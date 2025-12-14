import express from 'express';
import {
  getAllAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent
} from '../controllers/agentsController.js';

const router = express.Router();

router.get('/', getAllAgents);
router.get('/:id', getAgent);
router.post('/', createAgent);
router.put('/:id', updateAgent);
router.delete('/:id', deleteAgent);

export default router;

