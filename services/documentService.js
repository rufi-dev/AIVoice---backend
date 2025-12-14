import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

/**
 * Read document content based on file type
 * @param {string} filePath - Path to the document file
 * @param {string} fileName - Original file name
 * @returns {Promise<string|null>} - Document content or null if error
 */
export async function getDocumentContent(filePath, fileName) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const ext = path.extname(fileName).toLowerCase();
    
    if (ext === '.txt') {
      return fs.readFileSync(filePath, 'utf-8');
    } else if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      return pdfData.text;
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } else {
      // Try to read as text for other formats
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch (e) {
        return `[Document ${fileName} - format not supported for text extraction]`;
      }
    }
  } catch (error) {
    console.error('Error reading document:', error);
    return null;
  }
}

