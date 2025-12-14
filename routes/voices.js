import express from 'express';
import {
  getAllVoices,
  getVoice,
  createVoice,
  updateVoice,
  deleteVoice,
  getPredefinedVoices
} from '../controllers/voicesController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.get('/predefined', authenticate, getPredefinedVoices);
router.get('/', authenticate, getAllVoices);
router.get('/:id', authenticate, getVoice);
router.post('/', authenticate, createVoice);
router.put('/:id', authenticate, updateVoice);
router.delete('/:id', authenticate, deleteVoice);

export default router;

