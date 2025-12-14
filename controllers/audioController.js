import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';

// Ensure mongoose connection is ready
const getDb = () => {
  if (!mongoose.connection.db) {
    throw new Error('MongoDB connection not ready. Please ensure database is connected.');
  }
  return mongoose.connection.db;
};

/**
 * Serve audio file from MongoDB GridFS
 */
export const serveAudioFromGridFS = async (req, res) => {
  try {
    const { fileId } = req.params;
    console.log('🎵 Requesting audio file:', fileId);

    if (!fileId) {
      return res.status(400).json({ error: 'File ID is required' });
    }

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(fileId)) {
      console.error('❌ Invalid file ID format:', fileId);
      return res.status(400).json({ error: 'Invalid file ID format' });
    }

    const db = getDb();
    if (!db) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    const bucket = new GridFSBucket(db, { bucketName: 'audio' });
    const objectId = new mongoose.Types.ObjectId(fileId);

    // Check if file exists
    const files = await bucket.find({ _id: objectId }).toArray();
    
    if (files.length === 0) {
      console.error('❌ Audio file not found in GridFS:', fileId);
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const file = files[0];
    console.log('✅ Found audio file:', {
      fileId: fileId,
      filename: file.filename,
      length: file.length,
      contentType: file.contentType
    });

    // Set appropriate headers
    res.setHeader('Content-Type', file.contentType || 'audio/mpeg');
    res.setHeader('Content-Length', file.length);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

    // Stream the file from GridFS
    const downloadStream = bucket.openDownloadStream(objectId);
    
    downloadStream.on('error', (error) => {
      console.error('❌ Error streaming audio from GridFS:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming audio file' });
      } else {
        res.end();
      }
    });

    downloadStream.on('end', () => {
      console.log('✅ Audio stream completed for fileId:', fileId);
    });

    downloadStream.pipe(res);
  } catch (error) {
    console.error('❌ Error serving audio from GridFS:', error);
    console.error('❌ Error stack:', error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to serve audio file', details: error.message });
    }
  }
};
