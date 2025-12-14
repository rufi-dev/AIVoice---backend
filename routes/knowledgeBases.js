import express from 'express';
import { upload } from '../middleware/upload.js';
import {
  getAllKnowledgeBases,
  getKnowledgeBase,
  createKnowledgeBase,
  deleteKnowledgeBase,
  uploadDocument
} from '../controllers/knowledgeBasesController.js';

const router = express.Router();

router.get('/', getAllKnowledgeBases);
router.get('/:id', getKnowledgeBase);
router.post('/', createKnowledgeBase);
router.delete('/:id', deleteKnowledgeBase);
router.post('/:id/documents', upload.single('file'), uploadDocument);

export default router;

