import mongoose from 'mongoose';

const agentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  systemPrompt: {
    type: String,
    default: ''
  },
  knowledgeBaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KnowledgeBase',
    default: null
  },
  knowledgeBaseIds: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'KnowledgeBase',
    default: []
  },
  speechSettings: {
    voiceId: {
      type: String,
      default: '21m00Tcm4TlvDq8ikWAM'
    },
    voiceName: String,
    voiceProvider: {
      type: String,
      enum: ['elevenlabs', 'openai', 'custom'],
      default: 'elevenlabs'
    },
    modelId: {
      type: String,
      default: 'eleven_turbo_v2'
    },
    openaiModel: {
      type: String,
      default: 'gpt-4'
    },
    language: {
      type: String,
      default: 'en'
    },
    stability: {
      type: Number,
      default: 0.5,
      min: 0,
      max: 1
    },
    similarityBoost: {
      type: Number,
      default: 0.75,
      min: 0,
      max: 1
    }
  },
  callSettings: {
    aiSpeaksFirst: Boolean,
    pauseBeforeSpeaking: Number,
    welcomeMessageType: {
      type: String,
      enum: ['dynamic', 'custom'],
      default: 'dynamic'
    },
    customWelcomeMessage: {
      type: String,
      default: ''
    }
  },
  functions: [{
    name: {
      type: String,
      required: true
    },
    description: {
      type: String,
      default: ''
    },
    enabled: {
      type: Boolean,
      default: true
    },
    triggers: [{
      type: String // Keywords/phrases that trigger this function (e.g., "bye", "goodbye", "end call")
    }],
    config: {
      type: mongoose.Schema.Types.Mixed, // Flexible config for function-specific settings
      default: {}
    }
  }],
  shareableToken: {
    type: String,
    default: null
  },
  isPublic: {
    type: Boolean,
    default: false // Whether agent is publicly accessible via shareable link
  }
}, {
  timestamps: true
});

// Ensure shareableToken is unique only when present (ignore null/undefined)
agentSchema.index(
  { shareableToken: 1 },
  {
    unique: true,
    partialFilterExpression: { shareableToken: { $type: 'string' } }
  }
);

export default mongoose.model('Agent', agentSchema);
