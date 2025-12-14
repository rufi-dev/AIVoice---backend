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
  }
}, {
  timestamps: true
});

export default mongoose.model('CallHistory', callHistorySchema);
