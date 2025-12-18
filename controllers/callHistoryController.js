import CallHistory from '../models/CallHistory.js';

/**
 * Get all call history
 */
export const getAllCallHistory = async (req, res) => {
  try {
    // Only get call history for the authenticated user
    const calls = await CallHistory.find({ userId: req.userId })
      .sort({ startTime: -1 })
      .populate('agentId', 'name');
    // Map _id to id for frontend compatibility
    const callsWithId = calls.map(call => ({
      ...call.toObject(),
      id: call._id.toString()
    }));
    res.json(callsWithId);
  } catch (error) {
    console.error('Error fetching call history:', error);
    res.status(500).json({ error: 'Failed to fetch call history' });
  }
};

/**
 * Get single call details
 */
export const getCallDetails = async (req, res) => {
  try {
    const call = await CallHistory.findOne({ _id: req.params.id, userId: req.userId })
      .populate('agentId', 'name');
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    // Map _id to id for frontend compatibility
    const callWithId = {
      ...call.toObject(),
      id: call._id.toString()
    };
    res.json(callWithId);
  } catch (error) {
    console.error('Error fetching call details:', error);
    res.status(500).json({ error: 'Failed to fetch call details' });
  }
};

/**
 * Delete call history
 */
export const deleteCallHistory = async (req, res) => {
  try {
    const call = await CallHistory.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    res.json({ message: 'Call deleted' });
  } catch (error) {
    console.error('Error deleting call history:', error);
    res.status(500).json({ error: 'Failed to delete call history' });
  }
};

/**
 * Get live stats for a conversation (for Agent header UI)
 */
export const getCallStatsByConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    const call = await CallHistory.findOne({
      conversationId,
      userId: req.userId
    }).sort({ startTime: -1 });

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const now = new Date();
    const elapsedSec = Math.max(1, Math.floor((now - new Date(call.startTime)) / 1000));
    const costPerMin = call.cost ? (call.cost / (elapsedSec / 60)) : 0;

    const turns = call.latencyTurns || [];
    const nums = (arr) => arr.filter((v) => typeof v === 'number' && Number.isFinite(v));
    const avgOf = (field) => {
      const vals = nums(turns.map((t) => t?.[field]));
      if (!vals.length) return null;
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    };
    const rangeOf = (field) => {
      const vals = nums(turns.map((t) => t?.[field]));
      return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
    };

    const tokVals = nums(turns.map((t) => t?.tokensUsed));
    const avgTokensUsed = tokVals.length ? Math.round(tokVals.reduce((a, b) => a + b, 0) / tokVals.length) : null;
    const model = turns.length ? (turns[turns.length - 1]?.llmModel || null) : null;
    const last = turns.length ? turns[turns.length - 1] : null;

    const stats = {
      callId: call._id.toString(),
      conversationId: call.conversationId?.toString?.() || String(conversationId),
      agentId: call.agentId?.toString?.() || null,
      agentName: call.agentName || null,
      status: call.status,
      costTotal: call.cost || 0,
      costPerMin: costPerMin || 0,
      avgLatencyMs: call.latencySummary?.avgE2eFirstAudioMs ?? avgOf('e2eFirstAudioMs'),
      avgTokensUsed,
      // End-to-end (first audible audio) range
      latencyRangeMs: rangeOf('e2eFirstAudioMs'),
      // Component ranges
      asrFinalRangeMs: rangeOf('asrFinalMs'),
      llmFirstTokenRangeMs: rangeOf('llmFirstTokenMs'),
      llmTotalRangeMs: rangeOf('llmTotalMs'),
      ttsFirstAudioRangeMs: rangeOf('ttsFirstAudioMs'),
      ttsTotalRangeMs: rangeOf('ttsTotalMs'),
      tokensRange: tokVals.length ? { min: Math.min(...tokVals), max: Math.max(...tokVals) } : null,
      llmModel: model,
      lastTurn: last
        ? {
            asrFinalMs: last.asrFinalMs ?? null,
            llmFirstTokenMs: last.llmFirstTokenMs ?? null,
            llmTotalMs: last.llmTotalMs ?? null,
            ttsFirstAudioMs: last.ttsFirstAudioMs ?? null,
            ttsTotalMs: last.ttsTotalMs ?? null,
            e2eFirstAudioMs: last.e2eFirstAudioMs ?? null,
            tokensUsed: last.tokensUsed ?? null,
            llmModel: last.llmModel ?? null
          }
        : null
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching call stats:', error);
    res.status(500).json({ error: 'Failed to fetch call stats' });
  }
};

