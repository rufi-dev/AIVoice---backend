import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import apiRoutes from './routes/index.js';
import { connectDatabase } from './database/connection.js';
import fs from 'fs';

const app = express();

// Middleware
app.use(cors());
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
    app.listen(config.port, () => {
      console.log(`🚀 Server running on http://localhost:${config.port}`);
      console.log(`📝 Make sure to set OPENAI_API_KEY and ELEVENLABS_API_KEY in .env file`);
      console.log(`💾 Database: ${config.database.uri}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
