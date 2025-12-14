import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import apiRoutes from './routes/index.js';
import { connectDatabase } from './database/connection.js';
import fs from 'fs';

const app = express();

// Middleware
// CORS configuration - allow frontend URL from environment or default to localhost for development
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('public'));

// Ensure required directories exist (only uploads, audio is now in MongoDB)
const requiredDirs = [
  config.paths.uploads
];

requiredDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// API routes
app.use('/api', apiRoutes);

// Connect to database and start server
const startServer = async () => {
  try {
    await connectDatabase();
    
    // Start audio cleanup scheduler (runs daily)
    try {
      const { startAudioCleanupScheduler } = await import('./jobs/audioCleanupJob.js');
      startAudioCleanupScheduler();
    } catch (error) {
      console.warn('⚠️ Could not start audio cleanup scheduler:', error.message);
    }
    
    app.listen(config.port, () => {
      console.log(`🚀 Server running on http://localhost:${config.port}`);
      console.log(`📝 Make sure to set OPENAI_API_KEY and ELEVENLABS_API_KEY in .env file`);
      console.log(`💾 Database: ${config.database.uri}`);
      console.log(`🧹 Audio cleanup scheduler: Running daily`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
