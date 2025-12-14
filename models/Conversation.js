import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['system', 'user', 'assistant'],
    required: true
  },
  content: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

const conversationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    default: null
  },
  knowledgeBaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KnowledgeBase',
    default: null
  },
  systemPrompt: {
    type: String,
    required: true
  },
  messages: [messageSchema],
  startTime: {
    type: Date,
    default: Date.now
  },
  // Temporary storage for audio file IDs during conversation (will be merged on end)
  audioSegments: {
    type: [String], // GridFS file IDs
    default: []
  }
}, {
  timestamps: true
});

export default mongoose.model('Conversation', conversationSchema);
