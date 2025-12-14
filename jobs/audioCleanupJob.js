import { cleanupExpiredAudio } from '../services/audioCacheService.js';

/**
 * Scheduled job to clean up expired audio files
 * Run this daily to prevent database bloat
 */
export async function runAudioCleanup() {
  try {
    console.log('🧹 Starting scheduled audio cleanup...');
    const result = await cleanupExpiredAudio();
    console.log(`✅ Cleanup completed: Deleted ${result.deleted} of ${result.total} expired files`);
    return result;
  } catch (error) {
    console.error('❌ Error in scheduled audio cleanup:', error);
    throw error;
  }
}

// Run cleanup every 24 hours (86400000 ms)
// You can also set this up as a cron job instead
let cleanupInterval = null;

export function startAudioCleanupScheduler() {
  // Run cleanup immediately on start
  runAudioCleanup().catch(console.error);
  
  // Then run every 24 hours
  cleanupInterval = setInterval(() => {
    runAudioCleanup().catch(console.error);
  }, 24 * 60 * 60 * 1000); // 24 hours
  
  console.log('✅ Audio cleanup scheduler started (runs every 24 hours)');
}

export function stopAudioCleanupScheduler() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('⏹️ Audio cleanup scheduler stopped');
  }
}
