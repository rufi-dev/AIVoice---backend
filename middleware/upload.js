import multer from 'multer';
import { config } from '../config/index.js';
import fs from 'fs';

// Ensure uploads directory exists
if (!fs.existsSync(config.paths.uploads)) {
  fs.mkdirSync(config.paths.uploads, { recursive: true });
}

// Configure multer for file uploads
export const upload = multer({
  dest: config.paths.uploads,
  limits: { fileSize: config.upload.maxFileSize },
});

