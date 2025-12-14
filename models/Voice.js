import mongoose from 'mongoose';

const voiceSchema = new mongoose.Schema({
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
  provider: {
    type: String,
    required: true,
    enum: ['elevenlabs', 'openai', 'custom'],
    default: 'elevenlabs'
  },
  voiceId: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  traits: {
    gender: String,
    accent: String,
    age: String,
    language: String
  },
  isCustom: {
    type: Boolean,
    default: false
  },
  isDefault: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

export default mongoose.model('Voice', voiceSchema);

