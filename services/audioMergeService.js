import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import { Readable } from 'stream';

// Ensure mongoose connection is ready
const getDb = () => {
  if (!mongoose.connection.db) {
    throw new Error('MongoDB connection not ready. Please ensure database is connected.');
  }
  return mongoose.connection.db;
};

/**
 * Merge multiple MP3 audio buffers into one continuous audio file
 * Note: This is a simple concatenation. For proper MP3 merging with proper headers,
 * you might want to use ffmpeg, but for same-format MP3s, concatenation often works.
 */
function mergeAudioBuffers(buffers) {
  // Simple concatenation - works for MP3 files with same format
  return Buffer.concat(buffers);
}

/**
 * Download audio file from GridFS and return as buffer
 */
async function downloadAudioFromGridFS(fileId) {
  try {
    const db = getDb();
    const bucket = new GridFSBucket(db, { bucketName: 'audio' });
    const objectId = new mongoose.Types.ObjectId(fileId);
    
    const chunks = [];
    const downloadStream = bucket.openDownloadStream(objectId);
    
    return new Promise((resolve, reject) => {
      downloadStream.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      downloadStream.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      });
      
      downloadStream.on('error', (error) => {
        reject(error);
      });
    });
  } catch (error) {
    console.error('Error downloading audio from GridFS:', error);
    throw error;
  }
}

/**
 * Store merged audio file in GridFS with no expiration
 */
async function storeMergedAudio(audioBuffer, conversationId) {
  try {
    const db = getDb();
    const bucket = new GridFSBucket(db, { bucketName: 'audio' });
    
    const audioFileName = `conversation_${conversationId}_${Date.now()}.mp3`;
    
    return new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(audioFileName, {
        contentType: 'audio/mpeg',
        metadata: {
          type: 'full_conversation',
          conversationId: conversationId.toString(),
          createdAt: new Date(),
          // NO expiration - keep forever
          expiresAt: null
        }
      });

      uploadStream.on('finish', () => {
        const fileId = uploadStream.id.toString();
        console.log(`✅ Merged conversation audio stored. File ID: ${fileId}, Size: ${audioBuffer.length} bytes`);
        resolve(fileId);
      });

      uploadStream.on('error', (error) => {
        console.error('❌ Error uploading merged audio:', error);
        reject(error);
      });

      uploadStream.end(audioBuffer);
    });
  } catch (error) {
    console.error('Error storing merged audio:', error);
    throw error;
  }
}

/**
 * Merge multiple audio files from GridFS into one file
 * @param {string[]} audioFileIds - Array of GridFS file IDs to merge
 * @param {string} conversationId - Conversation ID for metadata
 * @returns {Promise<string>} - File ID of merged audio
 */
export async function mergeConversationAudio(audioFileIds, conversationId) {
  try {
    if (!audioFileIds || audioFileIds.length === 0) {
      throw new Error('No audio files to merge');
    }

    console.log(`🔗 Merging ${audioFileIds.length} audio segments for conversation ${conversationId}`);

    // Download all audio files
    const audioBuffers = [];
    for (const fileId of audioFileIds) {
      try {
        const buffer = await downloadAudioFromGridFS(fileId);
        audioBuffers.push(buffer);
        console.log(`✅ Downloaded audio segment: ${fileId} (${buffer.length} bytes)`);
      } catch (error) {
        console.error(`⚠️ Failed to download audio segment ${fileId}, skipping:`, error);
        // Continue with other segments
      }
    }

    if (audioBuffers.length === 0) {
      throw new Error('No valid audio segments to merge');
    }

    // Merge all buffers
    const mergedBuffer = mergeAudioBuffers(audioBuffers);
    console.log(`✅ Merged ${audioBuffers.length} segments into ${mergedBuffer.length} bytes`);

    // Store merged audio
    const mergedFileId = await storeMergedAudio(mergedBuffer, conversationId);

    // Optionally: Delete individual segments after merging (they're temporary)
    // We'll do this in a separate cleanup step to avoid issues

    return mergedFileId;
  } catch (error) {
    console.error('Error merging conversation audio:', error);
    throw error;
  }
}

/**
 * Delete temporary audio segments after merging
 */
export async function deleteTemporaryAudioSegments(fileIds) {
  try {
    const db = getDb();
    const bucket = new GridFSBucket(db, { bucketName: 'audio' });
    
    let deletedCount = 0;
    for (const fileId of fileIds) {
      try {
        const objectId = new mongoose.Types.ObjectId(fileId);
        await bucket.delete(objectId);
        deletedCount++;
        console.log(`🗑️ Deleted temporary audio segment: ${fileId}`);
      } catch (error) {
        console.error(`⚠️ Failed to delete audio segment ${fileId}:`, error);
      }
    }
    
    console.log(`✅ Deleted ${deletedCount} temporary audio segments`);
    return deletedCount;
  } catch (error) {
    console.error('Error deleting temporary audio segments:', error);
    throw error;
  }
}
