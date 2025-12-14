import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import crypto from 'crypto';

// Ensure mongoose connection is ready
const getDb = () => {
  if (!mongoose.connection.db) {
    throw new Error('MongoDB connection not ready. Please ensure database is connected.');
  }
  return mongoose.connection.db;
};

/**
 * Generate a cache key for audio based on text and voice settings
 */
function generateCacheKey(text, voiceId, modelId, stability, similarityBoost) {
  const keyString = `${text}|${voiceId}|${modelId}|${stability}|${similarityBoost}`;
  return crypto.createHash('md5').update(keyString).digest('hex');
}

/**
 * Check if cached audio exists for the given parameters
 * @returns {Promise<string|null>} - File ID if found, null otherwise
 */
export async function getCachedAudio(text, voiceId, modelId, stability, similarityBoost) {
  try {
    const db = getDb();
    const bucket = new GridFSBucket(db, { bucketName: 'audio' });
    
    const cacheKey = generateCacheKey(text, voiceId, modelId, stability, similarityBoost);
    
    // Look for existing file with this cache key in metadata
    const files = await bucket.find({ 
      'metadata.cacheKey': cacheKey,
      'metadata.type': 'preview' // Only cache previews
    }).sort({ uploadDate: -1 }).limit(1).toArray();
    
    if (files.length > 0) {
      const file = files[0];
      console.log(`✅ Found cached audio for preview: ${file._id}`);
      return file._id.toString();
    }
    
    return null;
  } catch (error) {
    console.error('Error checking audio cache:', error);
    return null; // On error, don't use cache
  }
}

/**
 * Store audio with metadata for caching and cleanup
 */
export async function storeAudioWithMetadata(audioBuffer, metadata = {}) {
  try {
    const db = getDb();
    const bucket = new GridFSBucket(db, { bucketName: 'audio' });
    
    const audioFileName = `audio_${Date.now()}.mp3`;
    const cacheKey = metadata.cacheKey || null;
    
    return new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(audioFileName, {
        contentType: 'audio/mpeg',
        metadata: {
          ...metadata,
          cacheKey: cacheKey,
          createdAt: new Date(),
          // Set expiration: 
          // - previews: expire after 7 days
          // - temporary: expire after 1 day (conversation segments, will be merged)
          // - full_conversation: NO expiration (keep forever)
          expiresAt: metadata.type === 'full_conversation' 
            ? null 
            : new Date(Date.now() + (metadata.type === 'preview' ? 7 * 24 * 60 * 60 * 1000 : 1 * 24 * 60 * 60 * 1000))
        }
      });

      uploadStream.on('finish', () => {
        const fileId = uploadStream.id.toString();
        console.log(`✅ Audio stored with metadata. File ID: ${fileId}, Type: ${metadata.type || 'conversation'}`);
        resolve(fileId);
      });

      uploadStream.on('error', (error) => {
        console.error('❌ Error uploading to GridFS:', error);
        reject(error);
      });

      uploadStream.end(audioBuffer);
    });
  } catch (error) {
    console.error('Error storing audio with metadata:', error);
    throw error;
  }
}

/**
 * Clean up expired audio files
 * Should be run periodically (e.g., daily via cron job)
 */
export async function cleanupExpiredAudio() {
  try {
    const db = getDb();
    const bucket = new GridFSBucket(db, { bucketName: 'audio' });
    
    const now = new Date();
    
    // Find all files that have expired
    const expiredFiles = await bucket.find({
      'metadata.expiresAt': { $lt: now }
    }).toArray();
    
    console.log(`🧹 Found ${expiredFiles.length} expired audio files to delete`);
    
    let deletedCount = 0;
    for (const file of expiredFiles) {
      try {
        await bucket.delete(file._id);
        deletedCount++;
        console.log(`🗑️ Deleted expired audio file: ${file._id}`);
      } catch (error) {
        console.error(`❌ Error deleting file ${file._id}:`, error);
      }
    }
    
    console.log(`✅ Cleanup complete: Deleted ${deletedCount} expired audio files`);
    return { deleted: deletedCount, total: expiredFiles.length };
  } catch (error) {
    console.error('❌ Error cleaning up expired audio:', error);
    throw error;
  }
}

/**
 * Get storage statistics
 */
export async function getAudioStorageStats() {
  try {
    const db = getDb();
    const bucket = new GridFSBucket(db, { bucketName: 'audio' });
    
    const allFiles = await bucket.find({}).toArray();
    
    const totalSize = allFiles.reduce((sum, file) => sum + (file.length || 0), 0);
    const previewCount = allFiles.filter(f => f.metadata?.type === 'preview').length;
    const conversationCount = allFiles.filter(f => f.metadata?.type === 'conversation').length;
    const expiredCount = allFiles.filter(f => {
      const expiresAt = f.metadata?.expiresAt;
      return expiresAt && new Date(expiresAt) < new Date();
    }).length;
    
    return {
      totalFiles: allFiles.length,
      totalSize: totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      previewFiles: previewCount,
      conversationFiles: conversationCount,
      expiredFiles: expiredCount
    };
  } catch (error) {
    console.error('Error getting storage stats:', error);
    throw error;
  }
}
