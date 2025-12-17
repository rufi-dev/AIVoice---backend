import express from 'express';
import {
  startConversation,
  chat,
  chatStream,
  prefetchDraft,
  getConversation,
  deleteConversation,
  endConversation,
  getCuttingPhrase
} from '../controllers/conversationsController.js';

const router = express.Router();

router.post('/start', startConversation);
router.post('/chat', chat);
router.post('/:id/chat', chat); // Also support /conversation/:id/chat
router.post('/chat-stream', chatStream);
router.post('/prefetch', prefetchDraft);
router.post('/cutting-phrase', getCuttingPhrase);
router.get('/:id', getConversation);
router.delete('/:id', deleteConversation);
router.post('/:id/end', endConversation);

export default router;

