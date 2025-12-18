import crypto from 'crypto';
import { streamTextToSpeech } from '../services/elevenLabsService.js';

// Ephemeral one-time tokens for streaming audio.
// In-memory store: fine for a single backend instance (current setup).
const ttsTokenStore = new Map(); // token -> { text, voiceId, modelId, stability, similarity_boost, turnId, expiresAt }

// Per-turn metrics shared between chatStream and /tts streaming endpoint.
const turnMetrics = new Map(); // turnId -> { startedAt, ttsFirstByteAt, ttsLastByteAt }

function _cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, item] of ttsTokenStore.entries()) {
    if (!item || (item.expiresAt && item.expiresAt <= now)) {
      ttsTokenStore.delete(token);
    }
  }
}

export function initTurnMetrics(turnId, startedAt) {
  if (!turnId) return;
  turnMetrics.set(turnId, {
    startedAt: typeof startedAt === 'number' ? startedAt : Date.now(),
    ttsFirstByteAt: null,
    ttsLastByteAt: null
  });
}

export function getTurnMetrics(turnId) {
  if (!turnId) return null;
  return turnMetrics.get(turnId) || null;
}

export function finalizeTurnMetrics(turnId) {
  if (!turnId) return;
  // Keep a short window for late /tts fetches, then clean up.
  setTimeout(() => {
    turnMetrics.delete(turnId);
  }, 5 * 60 * 1000);
}

export function createTtsToken(payload) {
  _cleanupExpiredTokens();
  const token = crypto.randomBytes(16).toString('hex');
  const ttlMs = 3 * 60 * 1000; // 3 minutes
  ttsTokenStore.set(token, {
    text: payload?.text ?? '',
    voiceId: payload?.voiceId ?? null,
    modelId: payload?.modelId ?? null,
    stability: payload?.stability,
    similarity_boost: payload?.similarity_boost,
    optimize_streaming_latency: payload?.optimize_streaming_latency,
    turnId: payload?.turnId ?? null,
    expiresAt: Date.now() + ttlMs
  });
  return token;
}

/**
 * GET /api/tts/:token
 * Streams audio bytes from ElevenLabs to the browser (no GridFS).
 */
export async function streamTtsByToken(req, res) {
  const token = req.params.token;
  const item = token ? ttsTokenStore.get(token) : null;
  if (!item || (item.expiresAt && item.expiresAt <= Date.now())) {
    return res.status(404).send('Not found');
  }

  // One-time token: prevent re-use.
  ttsTokenStore.delete(token);

  // Streaming audio response
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const ttsStream = await streamTextToSpeech(item.text, {
      voiceId: item.voiceId,
      modelId: item.modelId,
      stability: item.stability,
      similarity_boost: item.similarity_boost,
      optimize_streaming_latency: item.optimize_streaming_latency ?? 3
    });

    let first = true;
    const turnId = item.turnId;

    ttsStream.on('data', () => {
      if (!first) return;
      first = false;
      if (turnId) {
        const m = turnMetrics.get(turnId);
        if (m && !m.ttsFirstByteAt) m.ttsFirstByteAt = Date.now();
      }
    });

    ttsStream.on('end', () => {
      if (turnId) {
        const m = turnMetrics.get(turnId);
        if (m) m.ttsLastByteAt = Date.now();
      }
    });

    ttsStream.on('error', (err) => {
      try {
        console.error('TTS stream error:', err);
      } catch {}
      if (!res.headersSent) {
        res.status(500);
      }
      try {
        res.end();
      } catch {}
    });

    // If client disconnects, stop upstream stream.
    req.on('close', () => {
      try {
        ttsStream.destroy();
      } catch {}
    });

    ttsStream.pipe(res);
  } catch (err) {
    console.error('Failed to stream TTS:', err);
    if (!res.headersSent) {
      res.status(500).send('TTS failed');
    } else {
      try {
        res.end();
      } catch {}
    }
  }
}

