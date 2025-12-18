import axios from 'axios';
import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { getCachedAudio, storeAudioWithMetadata } from './audioCacheService.js';

function sanitizeForTts(input) {
  if (!input) return '';
  let s = String(input);
  // Remove code blocks/backticks
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`+/g, '');
  // Remove common symbol noise that TTS pronounces awkwardly
  s = s.replace(/[{}\[\]<>]/g, ' ');
  s = s.replace(/[*^%$#@|~]/g, ' ');
  // Drop control chars
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Ensure mongoose connection is ready
const getDb = () => {
  if (!mongoose.connection.db) {
    throw new Error('MongoDB connection not ready. Please ensure database is connected.');
  }
  return mongoose.connection.db;
};

/**
 * Convert text to speech using ElevenLabs API and store in MongoDB GridFS
 * @param {string} text - Text to convert to speech
 * @param {Object} options - Optional voice settings (voiceId, modelId, stability, similarity_boost, type, useCache)
 * @returns {Promise<string>} - MongoDB file ID as string
 */
export async function textToSpeech(text, options = {}) {
  try {
    const cleanedText = sanitizeForTts(text);
    if (!cleanedText) {
      throw new Error('TTS input is empty after sanitization');
    }
    const voiceId = options.voiceId || config.elevenlabs.voiceId;
    const apiKey = config.elevenlabs.apiKey;
    const modelId = options.modelId || config.elevenlabs.modelId;

    // Log the voiceId being used for debugging
    console.log('🔊 ElevenLabs TTS called with:', {
      voiceId: voiceId,
      modelId: modelId,
      textLength: cleanedText.length,
      hasVoiceId: !!voiceId
    });

    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    if (!voiceId) {
      throw new Error('Voice ID is required for text-to-speech');
    }

    const voiceSettings = {
      stability: options.stability ?? 0.5,
      similarity_boost: options.similarity_boost ?? 0.75,
    };
    
    const audioType = options.type || 'conversation'; // 'preview', 'conversation', or 'temporary'
    const useCache = options.useCache !== false && audioType === 'preview'; // Only cache previews by default

    // For previews: Don't save to MongoDB, return audio buffer directly
    if (audioType === 'preview') {
      // Just return the audio buffer - don't save to GridFS
      // The previewVoice controller will handle streaming
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          text: cleanedText,
          model_id: modelId,
          voice_settings: voiceSettings,
        },
        {
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
          },
          responseType: 'arraybuffer',
        }
      );
      
      // Return buffer directly for previews (not saved to MongoDB)
      return Buffer.from(response.data);
    }

    // Check cache first for other types (if needed)
    if (useCache) {
      const cachedFileId = await getCachedAudio(
        cleanedText, 
        voiceId, 
        options.modelId || config.elevenlabs.modelId,
        voiceSettings.stability,
        voiceSettings.similarity_boost
      );
      
      if (cachedFileId) {
        console.log('✅ Using cached audio, skipping ElevenLabs API call');
        return cachedFileId;
      }
    }

    const apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    console.log('🔊 Calling ElevenLabs API:', apiUrl);

    const response = await axios.post(
      apiUrl,
      {
        text: cleanedText,
        model_id: modelId,
        voice_settings: voiceSettings,
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        responseType: 'arraybuffer',
      }
    );

    // Store audio in MongoDB GridFS with metadata (only for conversation/temporary types)
    try {
      // Convert arraybuffer to Buffer
      const audioBuffer = Buffer.from(response.data);
      console.log(`📦 Audio buffer size: ${audioBuffer.length} bytes`);
      
      // For temporary conversation segments, mark as temporary (will be merged later)
      const actualType = audioType === 'conversation' ? 'temporary' : audioType;
      
      // Generate cache key for previews (not used for temporary)
      const cacheKey = useCache ? crypto.createHash('md5')
        .update(`${cleanedText}|${voiceId}|${options.modelId || config.elevenlabs.modelId}|${voiceSettings.stability}|${voiceSettings.similarity_boost}`)
        .digest('hex') : null;
      
      // Store with metadata
      const fileId = await storeAudioWithMetadata(audioBuffer, {
        type: actualType,
        cacheKey: cacheKey,
        voiceId: voiceId,
        modelId: options.modelId || config.elevenlabs.modelId,
        textLength: cleanedText.length
      });
      
      return fileId;
    } catch (gridfsError) {
      console.error('❌ GridFS upload failed, falling back to local storage:', gridfsError);
      // Fallback to local file storage if GridFS fails
      const fs = await import('fs');
      const path = await import('path');
      const audioDir = config.paths.audio;
      if (!fs.existsSync(audioDir)) {
        fs.mkdirSync(audioDir, { recursive: true });
      }
      const audioFileName = `audio_${Date.now()}.mp3`;
      const audioPath = path.join(audioDir, audioFileName);
      fs.writeFileSync(audioPath, Buffer.from(response.data));
      console.log('✅ Audio saved to local file as fallback:', audioFileName);
      return `/audio/${audioFileName}`;
    }
  } catch (error) {
    console.error('❌ Error converting text to speech:', error);
    console.error('❌ VoiceId used:', options.voiceId || config.elevenlabs.voiceId);
    console.error('❌ Error details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data ? Buffer.from(error.response.data).toString() : 'No data'
    });
    
    // Parse error response for better error messages
    if (error.response) {
      const status = error.response.status;
      let errorMessage = 'ElevenLabs API error';
      
      try {
        const errorData = JSON.parse(Buffer.from(error.response.data).toString());
        errorMessage = errorData.detail?.status || errorData.detail?.message || errorMessage;
        console.error('❌ ElevenLabs API error details:', errorData);
      } catch (e) {
        // If we can't parse, use status code
        if (status === 401) {
          errorMessage = 'Invalid ElevenLabs API key or unauthorized access';
        } else if (status === 429) {
          errorMessage = 'ElevenLabs API rate limit exceeded';
        } else if (status === 400) {
          errorMessage = `Invalid request to ElevenLabs API. Voice ID might be invalid: ${options.voiceId || config.elevenlabs.voiceId}`;
        } else if (status === 404) {
          errorMessage = `Voice not found. Invalid voice ID: ${options.voiceId || config.elevenlabs.voiceId}`;
        }
      }
      
      console.error(`❌ ElevenLabs API Error (${status}):`, errorMessage);
      throw new Error(errorMessage);
    }
    
    throw error;
  }
}

