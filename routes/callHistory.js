import express from 'express';
import {
  getAllCallHistory,
  getCallDetails,
  deleteCallHistory
} from '../controllers/callHistoryController.js';

const router = express.Router();

router.get('/', getAllCallHistory);
router.get('/:id', getCallDetails);
router.delete('/:id', deleteCallHistory);

export default router;

