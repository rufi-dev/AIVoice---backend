import { cleanupExpiredAudio, getAudioStorageStats } from '../services/audioCacheService.js';

/**
 * Get audio storage statistics
 */
export const getStorageStats = async (req, res) => {
  try {
    const stats = await getAudioStorageStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting storage stats:', error);
    res.status(500).json({ error: 'Failed to get storage stats', details: error.message });
  }
};

/**
 * Manually trigger cleanup of expired audio files
 */
export const cleanupAudio = async (req, res) => {
  try {
    const result = await cleanupExpiredAudio();
    res.json({
      message: 'Cleanup completed',
      deleted: result.deleted,
      total: result.total
    });
  } catch (error) {
    console.error('Error cleaning up audio:', error);
    res.status(500).json({ error: 'Failed to cleanup audio', details: error.message });
  }
};
