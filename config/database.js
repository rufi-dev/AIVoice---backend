import mongoose from 'mongoose';
import { config } from './index.js';

/**
 * Connect to MongoDB database
 */
export const connectDatabase = async () => {
  try {
    const mongoUri = config.database.uri;
    
    if (!mongoUri) {
      throw new Error('MongoDB connection string is not configured. Please set MONGODB_URI in .env file');
    }

    await mongoose.connect(mongoUri, {
      // These options are recommended for Mongoose 6+
      // Remove if using older versions
    });

    console.log('✅ MongoDB connected successfully');
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('⚠️ MongoDB disconnected');
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      console.log('MongoDB connection closed through app termination');
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error.message);
    throw error;
  }
};

