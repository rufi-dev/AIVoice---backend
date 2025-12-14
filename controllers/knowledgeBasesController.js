import KnowledgeBase from '../models/KnowledgeBase.js';

export const getAllKnowledgeBases = async (req, res) => {
  try {
    // Only get knowledge bases for the authenticated user
    const kbList = await KnowledgeBase.find({ userId: req.userId }).sort({ createdAt: -1 });
    // Map _id to id for frontend compatibility
    const kbListWithId = kbList.map(kb => ({
      ...kb.toObject(),
      id: kb._id.toString()
    }));
    res.json(kbListWithId);
  } catch (error) {
    console.error('Error fetching knowledge bases:', error);
    res.status(500).json({ error: 'Failed to fetch knowledge bases' });
  }
};

export const getKnowledgeBase = async (req, res) => {
  try {
    const kb = await KnowledgeBase.findOne({ _id: req.params.id, userId: req.userId });
    if (!kb) {
      return res.status(404).json({ error: 'Knowledge base not found' });
    }
    // Map _id to id for frontend compatibility
    const kbWithId = {
      ...kb.toObject(),
      id: kb._id.toString()
    };
    res.json(kbWithId);
  } catch (error) {
    console.error('Error fetching knowledge base:', error);
    res.status(500).json({ error: 'Failed to fetch knowledge base' });
  }
};

export const createKnowledgeBase = async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Knowledge base name is required' });
    }

    const kb = new KnowledgeBase({
      userId: req.userId,
      name: name.trim(),
      documents: []
    });

    await kb.save();
    // Map _id to id for frontend compatibility
    const kbWithId = {
      ...kb.toObject(),
      id: kb._id.toString()
    };
    res.status(201).json(kbWithId);
  } catch (error) {
    console.error('Error creating knowledge base:', error);
    res.status(500).json({ error: 'Failed to create knowledge base' });
  }
};

export const deleteKnowledgeBase = async (req, res) => {
  try {
    const kb = await KnowledgeBase.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!kb) {
      return res.status(404).json({ error: 'Knowledge base not found' });
    }
    res.json({ message: 'Knowledge base deleted' });
  } catch (error) {
    console.error('Error deleting knowledge base:', error);
    res.status(500).json({ error: 'Failed to delete knowledge base' });
  }
};

export const uploadDocument = async (req, res) => {
  try {
    const kb = await KnowledgeBase.findOne({ _id: req.params.id, userId: req.userId });
    if (!kb) {
      return res.status(404).json({ error: 'Knowledge base not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Store file metadata
    const document = {
      name: req.file.originalname || 'document',
      fileName: req.file.filename,
      size: req.file.size
    };

    kb.documents.push(document);
    await kb.save();

    // Get the last document (the one we just added)
    const addedDocument = kb.documents[kb.documents.length - 1];
    
    // Map document with id field for frontend compatibility
    const documentWithId = {
      ...addedDocument.toObject ? addedDocument.toObject() : addedDocument,
      id: addedDocument._id ? addedDocument._id.toString() : `doc_${Date.now()}`
    };
    res.status(201).json(documentWithId);
  } catch (error) {
    console.error('Error uploading document:', error);
    res.status(500).json({ error: 'Failed to upload document' });
  }
};

