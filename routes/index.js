import express from 'express';
import authRoutes from './auth.js';
import agentsRoutes from './agents.js';
import knowledgeBasesRoutes from './knowledgeBases.js';
import conversationsRoutes from './conversations.js';
import callHistoryRoutes from './callHistory.js';
import voicesRoutes from './voices.js';
import realtimeRoutes from './realtime.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { serveAudioFromGridFS } from '../controllers/audioController.js';
import { getStorageStats, cleanupAudio } from '../controllers/audioManagementController.js';
import { getAgentByToken } from '../controllers/publicAgentController.js';
import { streamTtsByToken } from '../controllers/ttsController.js';

const router = express.Router();

// Health check endpoint (public)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Voice Agent API is running' });
});

// Audio serving route (public - file IDs are hard to guess, providing security through obscurity)
router.get('/audio/:fileId', serveAudioFromGridFS);
// Ephemeral streaming TTS route (public - token is random and short-lived)
router.get('/tts/:token', streamTtsByToken);

// Public agent route (no authentication required)
router.get('/public/agent/:token', getAgentByToken);

// Auth routes (public)
router.use('/auth', authRoutes);

// Protected API routes - require authentication
router.use('/agents', authenticate, agentsRoutes);
router.use('/knowledge-bases', authenticate, knowledgeBasesRoutes);
// Conversations support authenticated and public-token access
router.use('/conversation', optionalAuth, conversationsRoutes);
router.use('/call-history', authenticate, callHistoryRoutes);
router.use('/voices', authenticate, voicesRoutes);
// Realtime (LiveKit) supports authenticated and public-token access
router.use('/realtime', optionalAuth, realtimeRoutes);
router.get('/audio-stats', authenticate, getStorageStats);
router.post('/audio-cleanup', authenticate, cleanupAudio);

export default router;

