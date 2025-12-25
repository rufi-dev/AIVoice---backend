import crypto from 'crypto';
import * as livekit from 'livekit-server-sdk';
import Agent from '../models/Agent.js';
import CallHistory from '../models/CallHistory.js';
import { buildSystemPrompt } from '../services/promptService.js';
import { spawnWorker, stopWorker } from '../services/workerSpawner.js';

function requireLiveKitEnv() {
  const livekitUrl = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!livekitUrl || !apiKey || !apiSecret) {
    const missing = [
      !livekitUrl ? 'LIVEKIT_URL' : null,
      !apiKey ? 'LIVEKIT_API_KEY' : null,
      !apiSecret ? 'LIVEKIT_API_SECRET' : null
    ].filter(Boolean);
    const err = new Error(`Missing LiveKit env vars: ${missing.join(', ')}`);
    err.statusCode = 500;
    throw err;
  }
  return { livekitUrl, apiKey, apiSecret };
}

function toLiveKitApiHost(livekitUrl) {
  const raw = String(livekitUrl || '');
  if (raw.startsWith('wss://')) return raw.replace('wss://', 'https://');
  if (raw.startsWith('ws://')) return raw.replace('ws://', 'http://');
  return raw;
}

async function resolveAgentAccess({ agentId, publicToken, userId }) {
  if (!agentId) {
    const err = new Error('agentId is required');
    err.statusCode = 400;
    throw err;
  }

  // Authenticated access
  if (userId) {
    const agent = await Agent.findOne({ _id: agentId, userId });
    if (!agent) {
      const err = new Error('Agent not found or access denied');
      err.statusCode = 404;
      throw err;
    }
    return { agent, ownerUserId: userId, isPublic: false };
  }

  // Public access via shareable token
  if (publicToken) {
    const agent = await Agent.findOne({ _id: agentId, shareableToken: publicToken, isPublic: true });
    if (!agent) {
      const err = new Error('Agent not found or not publicly accessible');
      err.statusCode = 404;
      throw err;
    }
    return { agent, ownerUserId: agent.userId?.toString?.() || null, isPublic: true };
  }

  const err = new Error('Unauthorized');
  err.statusCode = 401;
  throw err;
}

function makeRoomName({ agentId }) {
  // Use consistent room name per agent (like Retell AI)
  // This allows the same room to be reused and the worker to stay connected
  return `room_${agentId}`;
}

function makeIdentity({ provider, userId, callSid }) {
  const rand = crypto.randomBytes(3).toString('hex');
  if (provider === 'pstn') return `pstn_${callSid || 'call'}_${rand}`;
  return `web_${userId || 'anon'}_${rand}`;
}

async function maybeCreateRoom({ livekitUrl, apiKey, apiSecret, roomName }) {
  try {
    if (!process.env.LIVEKIT_CREATE_ROOM) return;
    if (!livekit.RoomServiceClient) return;
    const client = new livekit.RoomServiceClient(toLiveKitApiHost(livekitUrl), apiKey, apiSecret);
    await client.createRoom({ name: roomName });
  } catch (e) {
    // Best-effort: room will be created on join if server allows it.
  }
}

async function maybeStartEgress({ livekitUrl, apiKey, apiSecret, roomName }) {
  try {
    // Enable egress by default if not explicitly disabled
    // User can set LIVEKIT_EGRESS_ENABLED=0 to disable
    const egressEnabled = process.env.LIVEKIT_EGRESS_ENABLED !== '0' && process.env.LIVEKIT_EGRESS_ENABLED !== 'false';
    if (!egressEnabled) {
      console.log('[realtime] Egress disabled via LIVEKIT_EGRESS_ENABLED');
      return null;
    }
    
    if (!livekit.EgressClient) {
      console.log('[realtime] EgressClient not available in livekit-server-sdk');
      return null;
    }

    // NOTE: This is a best-effort integration. You must set S3 env vars for it to work.
    const s3Bucket = process.env.S3_BUCKET;
    const awsRegion = process.env.AWS_REGION;
    const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    
    if (!s3Bucket || !awsRegion || !awsAccessKeyId || !awsSecretAccessKey) {
      console.log('[realtime] Egress requires S3 configuration (S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)');
      return null;
    }
    
    console.log(`[realtime] Starting egress recording for room: ${roomName}`);

    const egress = new livekit.EgressClient(toLiveKitApiHost(livekitUrl), apiKey, apiSecret);

    // livekit-server-sdk v2 uses classes + explicit `case` for oneof outputs.
    // See: livekit-server-sdk README "Egress API" section.
    const fileOutput = new livekit.EncodedFileOutput({
      filepath: `recordings/${roomName}/${Date.now()}.mp4`,
      output: {
        case: 's3',
        value: new livekit.S3Upload({
          accessKey: awsAccessKeyId,
          secret: awsSecretAccessKey,
          region: awsRegion,
          bucket: s3Bucket
        })
      }
    });

    const resp =
      typeof egress.startRoomCompositeEgress === 'function'
        ? await egress.startRoomCompositeEgress(roomName, fileOutput, { layout: 'grid' })
        : null;

    const egressId = resp?.egressId || resp?.info?.egressId || resp?.info?.egress_id || null;
    if (egressId) {
      console.log(`[realtime] ✅ Egress recording started: ${egressId}`);
      return { egressId };
    } else {
      console.log('[realtime] ⚠️ Egress started but no egressId returned');
      return null;
    }
  } catch (e) {
    // Best-effort: calls still work without recording.
    console.error('[realtime] Failed to start egress:', e.message);
    return null;
  }
}

async function maybeStopEgress({ livekitUrl, apiKey, apiSecret, egressId }) {
  try {
    if (!egressId) return;
    if (!livekit.EgressClient) return;
    const egress = new livekit.EgressClient(toLiveKitApiHost(livekitUrl), apiKey, apiSecret);
    if (typeof egress.stopEgress === 'function') {
      await egress.stopEgress(egressId);
    }
  } catch (e) {
    // ignore
  }
}

/**
 * POST /api/realtime/token
 * Input: { agentId, publicToken?, provider: 'web'|'pstn', roomName? }
 * Output: { livekitUrl, accessToken, roomName, identity }
 */
export const mintRealtimeToken = async (req, res) => {
  try {
    const { agentId, publicToken, provider = 'web', roomName: requestedRoomName, callSid } = req.body || {};
    const { livekitUrl, apiKey, apiSecret } = requireLiveKitEnv();

    console.log('[realtime] token request', {
      agentId: agentId ? String(agentId) : null,
      provider,
      hasAuthUser: !!req.userId,
      hasPublicToken: !!publicToken
    });

    const { ownerUserId } = await resolveAgentAccess({ agentId, publicToken, userId: req.userId });

    const roomName = requestedRoomName || makeRoomName({ agentId });
    const identity = makeIdentity({ provider, userId: req.userId || ownerUserId, callSid });

    await maybeCreateRoom({ livekitUrl, apiKey, apiSecret, roomName });

    if (!livekit.AccessToken) {
      return res.status(500).json({ error: 'LiveKit server SDK not available (missing dependency)' });
    }

    const at = new livekit.AccessToken(apiKey, apiSecret, {
      identity,
      ttl: 60 * 60 // 1 hour
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const accessToken = await at.toJwt();
    res.json({ livekitUrl, accessToken, roomName, identity });
  } catch (error) {
    console.error('Error minting realtime token:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to mint token' });
  }
};

/**
 * POST /api/realtime/start
 * Creates CallHistory record linked to roomName and (best-effort) starts egress recording.
 * Input: { agentId, roomName, provider: 'web'|'pstn', publicToken?, callSid? }
 */
export const startRealtimeSession = async (req, res) => {
  try {
    const { agentId, roomName, provider = 'web', publicToken, callSid } = req.body || {};
    if (!roomName) return res.status(400).json({ error: 'roomName is required' });

    const { livekitUrl, apiKey, apiSecret } = requireLiveKitEnv();
    console.log('[realtime] start request', {
      agentId: agentId ? String(agentId) : null,
      roomName,
      provider,
      hasAuthUser: !!req.userId,
      hasPublicToken: !!publicToken
    });
    const { agent, ownerUserId } = await resolveAgentAccess({ agentId, publicToken, userId: req.userId });
    if (!ownerUserId) return res.status(400).json({ error: 'Unable to resolve call owner userId' });

    const startTime = new Date();

    const callRecord = new CallHistory({
      userId: ownerUserId,
      conversationId: null,
      agentId: agentId || null,
      agentName: agent?.name || 'Unknown',
      startTime,
      status: 'active',
      channelType: provider === 'pstn' ? 'livekit_pstn' : 'livekit_web',
      provider,
      roomName,
      callSid: callSid || null
    });

    // Best-effort recording start
    const egressStarted = await maybeStartEgress({ livekitUrl, apiKey, apiSecret, roomName });
    if (egressStarted?.egressId) {
      callRecord.egressId = egressStarted.egressId;
      callRecord.recordingProvider = 'livekit_egress';
    }

    await callRecord.save();

    // Auto-start Python worker (like Retell AI)
    // This eliminates the need to manually run python voice_agent.py
    try {
      await spawnWorker(roomName, {
        identity: 'agent-worker',
        vad: process.env.AGENT_VAD || 'off'
      });
      console.log(`[realtime] ✅ Auto-started worker for room: ${roomName}`);
    } catch (workerError) {
      // Don't fail the call if worker spawn fails - user can still connect manually
      console.error(`[realtime] ⚠️  Failed to auto-start worker for room ${roomName}:`, workerError.message);
      console.error(`[realtime] 💡 You can still manually start the worker:`);
      console.error(`[realtime]    cd agent-worker`);
      console.error(`[realtime]    python voice_agent.py --room ${roomName} --url ${livekitUrl}`);
      console.error(`[realtime] 📝 Make sure Python dependencies are installed: pip install -r requirements.txt`);
    }

    res.json({
      callId: callRecord._id.toString(),
      roomName,
      provider,
      egressId: callRecord.egressId || null
    });
  } catch (error) {
    console.error('Error starting realtime session:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to start realtime session' });
  }
};

/**
 * GET /api/realtime/verify
 * Verifies LiveKit credentials by calling RoomService listRooms().
 */
export const verifyRealtimeCredentials = async (req, res) => {
  try {
    const { livekitUrl, apiKey, apiSecret } = requireLiveKitEnv();
    if (!livekit.RoomServiceClient) {
      return res.status(500).json({ ok: false, error: 'LiveKit server SDK missing RoomServiceClient' });
    }

    const host = toLiveKitApiHost(livekitUrl);
    const client = new livekit.RoomServiceClient(host, apiKey, apiSecret);
    const rooms = await client.listRooms();
    res.json({
      ok: true,
      host,
      roomCount: Array.isArray(rooms) ? rooms.length : 0
    });
  } catch (error) {
    console.error('LiveKit verify failed:', error);
    res.status(500).json({ ok: false, error: error.message || 'verify failed' });
  }
};

/**
 * POST /api/realtime/config
 * Returns the final system prompt (global prompt + KB context) and speech settings
 * so the agent-worker can mirror the same behavior as the legacy pipeline.
 *
 * Input: { agentId, systemPrompt?, knowledgeBaseId?, publicToken? }
 * Output: { agentId, agentName, finalSystemPrompt, speechSettings, callSettings }
 */
export const getRealtimeAgentConfig = async (req, res) => {
  try {
    const { agentId, systemPrompt, knowledgeBaseId, knowledgeBaseIds, publicToken } = req.body || {};
    const { agent } = await resolveAgentAccess({ agentId, publicToken, userId: req.userId });

    const language = agent?.speechSettings?.language || 'en';
    
    // Use knowledgeBaseIds array if available, otherwise fall back to single knowledgeBaseId
    let kbIdsArray = null;
    if (knowledgeBaseIds && Array.isArray(knowledgeBaseIds) && knowledgeBaseIds.length > 0) {
      kbIdsArray = knowledgeBaseIds;
    } else if (agent?.knowledgeBaseIds && Array.isArray(agent.knowledgeBaseIds) && agent.knowledgeBaseIds.length > 0) {
      kbIdsArray = agent.knowledgeBaseIds;
    } else if (knowledgeBaseId || agent?.knowledgeBaseId) {
      kbIdsArray = [knowledgeBaseId || agent.knowledgeBaseId];
    }
    
    const finalSystemPrompt = await buildSystemPrompt(
      systemPrompt || agent?.systemPrompt || '', 
      agentId, 
      kbIdsArray?.[0] || null, // First KB ID for backward compatibility
      language,
      kbIdsArray // Pass full array for multiple KBs
    );

    res.json({
      agentId: agentId ? String(agentId) : null,
      agentName: agent?.name || 'Unknown',
      finalSystemPrompt,
      speechSettings: agent?.speechSettings || {},
      callSettings: agent?.callSettings || {}
    });
  } catch (error) {
    console.error('Error building realtime agent config:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to build realtime agent config' });
  }
};

/**
 * POST /api/realtime/end
 * Ends call record and stops egress (best-effort).
 * Input: { callId?, roomName?, endReason? }
 */
export const endRealtimeSession = async (req, res) => {
  try {
    const { callId, roomName, endReason, publicToken, agentId } = req.body || {};
    if (!callId && !roomName) return res.status(400).json({ error: 'callId or roomName is required' });

    const { livekitUrl, apiKey, apiSecret } = requireLiveKitEnv();

    const q = { status: 'active' };
    if (callId) q._id = callId;
    if (roomName) q.roomName = roomName;
    if (req.userId) {
      q.userId = req.userId;
    } else {
      // Public access: require agentId + publicToken and scope to agent owner userId.
      const { ownerUserId } = await resolveAgentAccess({ agentId, publicToken, userId: null });
      if (!ownerUserId) return res.status(400).json({ error: 'Unable to resolve call owner userId' });
      q.userId = ownerUserId;
    }

    const callRecord = await CallHistory.findOne(q);
    if (!callRecord) return res.status(404).json({ error: 'Active realtime call not found' });

    callRecord.endTime = new Date();
    callRecord.status = 'ended';
    callRecord.endReason = endReason || 'user_hangup';
    callRecord.duration = Math.floor((callRecord.endTime - new Date(callRecord.startTime)) / 1000);

    // Save messages/transcripts if provided
    const { messages } = req.body || {};
    if (messages && Array.isArray(messages) && messages.length > 0) {
      callRecord.messages = messages.map(msg => ({
        role: msg.role || 'user',
        content: String(msg.content || '').trim()
      })).filter(msg => msg.content.length > 0); // Remove empty messages
      
      console.log(`[realtime] ✅ Saved ${callRecord.messages.length} messages to CallHistory ${callRecord._id}`, {
        userMessages: callRecord.messages.filter(m => m.role === 'user').length,
        assistantMessages: callRecord.messages.filter(m => m.role === 'assistant').length
      });
    } else {
      console.log(`[realtime] ⚠️ No messages provided in end call request`);
    }

    // Save audio URL if provided (from merged audio or recording)
    const { audioUrl } = req.body || {};
    if (audioUrl) {
      callRecord.audioUrl = audioUrl;
      console.log(`[realtime] Saved audioUrl to CallHistory ${callRecord._id}`);
    }

    await callRecord.save();
    await maybeStopEgress({ livekitUrl, apiKey, apiSecret, egressId: callRecord.egressId });

    // Auto-stop Python worker when call ends
    if (callRecord.roomName) {
      try {
        await stopWorker(callRecord.roomName);
        console.log(`[realtime] Auto-stopped worker for room: ${callRecord.roomName}`);
      } catch (workerError) {
        console.error(`[realtime] Failed to stop worker for room ${callRecord.roomName}:`, workerError.message);
      }
    }

    res.json({ callId: callRecord._id.toString(), status: callRecord.status });
  } catch (error) {
    console.error('Error ending realtime session:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to end realtime session' });
  }
};

/**
 * POST /api/realtime/webhook
 * Receives egress status + participant events (best-effort).
 * We primarily persist recording URL when egress completes.
 */
export const realtimeWebhook = async (req, res) => {
  try {
    // LiveKit webhook payloads vary; handle common shapes.
    const body = req.body || {};
    const egressId =
      body?.egressInfo?.egressId ||
      body?.egressInfo?.egress_id ||
      body?.info?.egressId ||
      body?.egressId ||
      null;

    if (egressId) {
      const callRecord = await CallHistory.findOne({ egressId });
      if (callRecord) {
        // Try to extract a recording URL / location.
        const file =
          body?.egressInfo?.file ||
          body?.file ||
          body?.result?.file ||
          (Array.isArray(body?.fileResults) ? body.fileResults[0] : null) ||
          null;

        const location =
          file?.location ||
          file?.filepath ||
          body?.egressInfo?.fileResults?.[0]?.location ||
          body?.egressInfo?.fileResults?.[0]?.filepath ||
          null;

        // Only set recordingUrl if we got a usable URL/path.
        if (location && !callRecord.recordingUrl) {
          // Convert S3 path to URL if needed
          let recordingUrl = String(location);
          
          // If it's an S3 path (s3://bucket/path or just path), construct URL
          if (recordingUrl.startsWith('s3://')) {
            const s3Bucket = process.env.S3_BUCKET;
            const awsRegion = process.env.AWS_REGION;
            // Construct S3 public URL (if bucket is public) or use S3 path
            recordingUrl = `https://${s3Bucket}.s3.${awsRegion}.amazonaws.com/${recordingUrl.replace('s3://' + s3Bucket + '/', '')}`;
          } else if (!recordingUrl.startsWith('http')) {
            // If it's a relative path, try to construct S3 URL
            const s3Bucket = process.env.S3_BUCKET;
            const awsRegion = process.env.AWS_REGION;
            if (s3Bucket && awsRegion) {
              recordingUrl = `https://${s3Bucket}.s3.${awsRegion}.amazonaws.com/${recordingUrl}`;
            }
          }
          
          callRecord.recordingUrl = recordingUrl;
          callRecord.recordingProvider = callRecord.recordingProvider || 'livekit_egress';
          console.log(`[realtime] ✅ Saved recording URL to CallHistory: ${recordingUrl}`);
        } else if (location) {
          console.log(`[realtime] Recording URL already exists, skipping update`);
        } else {
          console.log(`[realtime] No recording location found in webhook payload`);
        }

        await callRecord.save();
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Realtime webhook error:', error);
    res.status(500).json({ ok: false });
  }
};

/**
 * POST /api/realtime/metrics
 * Stores per-turn latency metrics (Retell-like) on CallHistory.metrics.
 *
 * Input:
 * {
 *   callId?, roomName?,
 *   agentId?, publicToken?,           // required if unauthenticated
 *   turn: {
 *     turnId,
 *     vadEndAt?, llmFirstTokenAt?, ttsFirstFrameAt?, clientPlayoutStartAt?,
 *     vadEndToPlayoutStartMs?
 *   }
 * }
 */
export const postRealtimeMetrics = async (req, res) => {
  try {
    const { callId, roomName, agentId, publicToken, turn } = req.body || {};
    if (!turn || typeof turn !== 'object') return res.status(400).json({ error: 'turn is required' });
    if (!callId && !roomName) return res.status(400).json({ error: 'callId or roomName is required' });

    const turnId = String(turn.turnId || '').trim();
    if (!turnId) return res.status(400).json({ error: 'turn.turnId is required' });

    const q = { status: 'active' };
    if (callId) q._id = callId;
    if (roomName) q.roomName = roomName;

    if (req.userId) {
      q.userId = req.userId;
    } else {
      const { ownerUserId } = await resolveAgentAccess({ agentId, publicToken, userId: null });
      if (!ownerUserId) return res.status(400).json({ error: 'Unable to resolve call owner userId' });
      q.userId = ownerUserId;
    }

    const callRecord = await CallHistory.findOne(q);
    if (!callRecord) return res.status(404).json({ error: 'Active realtime call not found' });

    callRecord.metrics = callRecord.metrics || { turns: [] };
    callRecord.metrics.turns = Array.isArray(callRecord.metrics.turns) ? callRecord.metrics.turns : [];

    const idx = callRecord.metrics.turns.findIndex((t) => String(t?.turnId || '') === turnId);
    const existing = idx >= 0 ? callRecord.metrics.turns[idx] : { turnId };

    const patchNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    const updated = {
      ...existing,
      turnId,
      vadEndAt: patchNum(turn.vadEndAt) ?? existing.vadEndAt ?? null,
      llmFirstTokenAt: patchNum(turn.llmFirstTokenAt) ?? existing.llmFirstTokenAt ?? null,
      ttsFirstFrameAt: patchNum(turn.ttsFirstFrameAt) ?? existing.ttsFirstFrameAt ?? null,
      clientPlayoutStartAt: patchNum(turn.clientPlayoutStartAt) ?? existing.clientPlayoutStartAt ?? null,
      vadEndToPlayoutStartMs: patchNum(turn.vadEndToPlayoutStartMs) ?? existing.vadEndToPlayoutStartMs ?? null
    };

    if (idx >= 0) callRecord.metrics.turns[idx] = updated;
    else callRecord.metrics.turns.push(updated);

    // Compute avg(vad_end -> playout_start) over turns that have it.
    const vals = (callRecord.metrics.turns || [])
      .map((t) => t?.vadEndToPlayoutStartMs)
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    callRecord.metrics.avgVadEndToPlayoutStartMs = vals.length
      ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
      : null;

    await callRecord.save();
    res.json({ ok: true, avgVadEndToPlayoutStartMs: callRecord.metrics.avgVadEndToPlayoutStartMs });
  } catch (error) {
    console.error('Error saving realtime metrics:', error);
    res.status(500).json({ error: 'Failed to save metrics' });
  }
};

/**
 * POST /api/realtime/pstn/inbound
 *
 * Placeholder for Twilio Voice webhook -> LiveKit SIP trunk dispatch.
 * This repository does NOT yet include Twilio signature verification or SIP trunk provisioning.
 *
 * Expected future behavior:
 * - Validate Twilio signature
 * - Create/find a LiveKit room
 * - Start CallHistory with provider='pstn' and persist callSid
 * - Return TwiML that routes the call to LiveKit SIP trunk OR let LiveKit handle dispatch directly
 */
export const twilioInboundStub = async (req, res) => {
  res.status(501).json({
    error: 'PSTN inbound not implemented yet',
    nextSteps: [
      'Provision Twilio SIP trunk to LiveKit',
      'Add Twilio webhook signature verification',
      'Create room + CallHistory by CallSid',
      'Route inbound call into LiveKit room'
    ]
  });
};

