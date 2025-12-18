import express from 'express';
import {
  getAllCallHistory,
  getCallStatsByConversation,
  getCallDetails,
  deleteCallHistory
} from '../controllers/callHistoryController.js';

const router = express.Router();

router.get('/', getAllCallHistory);
router.get('/by-conversation/:conversationId', getCallStatsByConversation);
router.get('/:id', getCallDetails);
router.delete('/:id', deleteCallHistory);

export default router;

