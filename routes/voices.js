import express from 'express';
import {
  getAllVoices,
  getVoice,
  createVoice,
  updateVoice,
  deleteVoice,
  getPredefinedVoices,
  previewVoice
} from '../controllers/voicesController.js';

const router = express.Router();

// IMPORTANT: Specific routes MUST come before parameterized routes (/:id)
// Express matches routes in order, so /preview must come before /:id
// Authentication is handled at the router level in index.js, so we don't need it here

// Log route registration for debugging
console.log('📋 Registering voice routes...');

router.get('/predefined', getPredefinedVoices);
router.post('/preview', (req, res, next) => {
  console.log('🎵 /preview route hit!', req.method, req.path);
  previewVoice(req, res).catch(next);
});
router.get('/', getAllVoices);
router.post('/', createVoice);
// Parameterized routes come last
router.get('/:id', getVoice);
router.put('/:id', updateVoice);
router.delete('/:id', deleteVoice);

console.log('✅ Voice routes registered');

export default router;

