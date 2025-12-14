import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

export const config = {
  port: process.env.PORT || 5000,
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2',
  },
  database: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/aivoice',
  },
  paths: {
    uploads: path.join(__dirname, '..', 'uploads'),
    audio: path.join(__dirname, '..', 'public', 'audio'),
  },
  upload: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
  },
};

