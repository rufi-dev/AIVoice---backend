import express from 'express';
import {
  getAllAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  generateToken
} from '../controllers/agentsController.js';

const router = express.Router();

router.get('/', getAllAgents);
router.get('/:id', getAgent);
router.post('/', createAgent);
router.put('/:id', updateAgent);
router.post('/:id/generate-token', generateToken);
router.delete('/:id', deleteAgent);

export default router;

