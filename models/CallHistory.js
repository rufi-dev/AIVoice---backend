import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true
  },
  content: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

const callHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    default: null
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    default: null
  },
  agentName: {
    type: String,
    default: 'Unknown'
  },
  startTime: {
    type: Date,
    required: true,
    default: Date.now
  },
  endTime: {
    type: Date,
    default: null
  },
  duration: {
    type: Number,
    default: 0 // Duration in seconds
  },
  channelType: {
    type: String,
    default: 'web_call'
  },
  cost: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'ended'],
    default: 'active'
  },
  endReason: {
    type: String,
    default: null
  },
  messages: [messageSchema],
  summary: {
    type: String,
    default: null
  },
  audioUrl: {
    type: String,
    default: null // Full conversation audio file ID in GridFS
  },
  // --- Realtime (LiveKit) call fields ---
  roomName: {
    type: String,
    default: null,
    index: true
  },
  provider: {
    type: String,
    enum: ['web', 'pstn'],
    default: 'web'
  },
  recordingProvider: {
    type: String,
    enum: ['livekit_egress', null],
    default: null
  },
  recordingUrl: {
    type: String,
    default: null
  },
  egressId: {
    type: String,
    default: null,
    index: true
  },
  callSid: {
    type: String,
    default: null,
    index: true
  },
  // Retell-like realtime metrics (aggregated server-side over turns)
  metrics: {
    avgVadEndToPlayoutStartMs: { type: Number, default: null },
    turns: {
      type: [
        {
          turnId: { type: String, default: null },
          // timestamps are epoch ms (client/server clocks may differ; use relative deltas where possible)
          vadEndAt: { type: Number, default: null },
          llmFirstTokenAt: { type: Number, default: null },
          ttsFirstFrameAt: { type: Number, default: null },
          clientPlayoutStartAt: { type: Number, default: null },
          vadEndToPlayoutStartMs: { type: Number, default: null },
          createdAt: { type: Date, default: Date.now }
        }
      ],
      default: []
    }
  },
  latencyTurns: {
    type: [
      {
        userText: { type: String, default: '' },
        mode: { type: String, default: 'chunked_tts' },
        llmModel: { type: String, default: null },
        tokensUsed: { type: Number, default: null },
        asrFinalMs: { type: Number, default: null },
        llmFirstTokenMs: { type: Number, default: null },
        llmTotalMs: { type: Number, default: null },
        ttsFirstAudioMs: { type: Number, default: null },
        ttsTotalMs: { type: Number, default: null },
        e2eFirstAudioMs: { type: Number, default: null },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    default: []
  },
  latencySummary: {
    avgE2eFirstAudioMs: { type: Number, default: null },
    avgLlmFirstTokenMs: { type: Number, default: null },
    avgTtsFirstAudioMs: { type: Number, default: null },
    lastTurn: {
      asrFinalMs: { type: Number, default: null },
      llmFirstTokenMs: { type: Number, default: null },
      llmTotalMs: { type: Number, default: null },
      ttsFirstAudioMs: { type: Number, default: null },
      ttsTotalMs: { type: Number, default: null },
      e2eFirstAudioMs: { type: Number, default: null }
    }
  }
}, {
  timestamps: true
});

export default mongoose.model('CallHistory', callHistorySchema);
