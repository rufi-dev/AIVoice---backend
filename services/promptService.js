import path from 'path';
import Agent from '../models/Agent.js';
import KnowledgeBase from '../models/KnowledgeBase.js';
import { getDocumentContent } from './documentService.js';
import { config } from '../config/index.js';

/**
 * Build the final system prompt with voice context and knowledge base
 * @param {string} userSystemPrompt - User-provided system prompt
 * @param {string} agentId - Optional agent ID
 * @param {string} knowledgeBaseId - Optional knowledge base ID
 * @returns {Promise<string>} - Final system prompt
 */
export async function buildSystemPrompt(userSystemPrompt, agentId = null, knowledgeBaseId = null, language = 'en') {
  let finalUserPrompt = userSystemPrompt || '';
  
  // If agentId is provided, get system prompt from agent
  // Note: userId should be passed to verify ownership, but for now we'll trust the controller
  if (agentId) {
    const agent = await Agent.findById(agentId);
    if (agent) {
      finalUserPrompt = agent.systemPrompt || userSystemPrompt || '';
      
      // Get language from agent speech settings if available
      if (agent.speechSettings?.language) {
        language = agent.speechSettings.language;
      }
      
      // If agent has knowledge base, include it in context
      if (agent.knowledgeBaseId || knowledgeBaseId) {
        const kbId = agent.knowledgeBaseId || knowledgeBaseId;
        const kb = await KnowledgeBase.findById(kbId);
        if (kb && kb.documents.length > 0) {
          let kbContent = `\n\n## KNOWLEDGE BASE CONTEXT:\nYou have access to a knowledge base with the following information:\n\n`;
          
          // Try to read document contents
          for (const doc of kb.documents) {
            if (doc.fileName) {
              const docPath = path.join(config.paths.uploads, doc.fileName);
              const content = await getDocumentContent(docPath, doc.name);
              if (content) {
                kbContent += `--- ${doc.name} ---\n${content}\n\n`;
              } else {
                kbContent += `--- ${doc.name} ---\n[Document available but could not be parsed]\n\n`;
              }
            }
          }
          
          kbContent += `Use the information from the knowledge base above to provide accurate and helpful responses. When asked about information from the knowledge base, reference it directly.`;
          finalUserPrompt += kbContent;
        }
      }
    }
  }
  
  // Map language codes to language names for the prompt
  const languageMap = {
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'zh': 'Chinese',
    'ja': 'Japanese',
    'ko': 'Korean',
    'ru': 'Russian',
    'ar': 'Arabic',
    'hi': 'Hindi'
  };
  
  const languageName = languageMap[language] || 'English';
  
  // CRITICAL: Add voice agent context at the BEGINNING - this must override any default behavior
  const voiceContext = `You are a VOICE AI AGENT in a real-time voice conversation. CRITICAL INSTRUCTIONS:
- The user is speaking to you through a microphone - you CAN HEAR them
- This is a VOICE conversation, NOT a text-only chat
- When asked "can you hear me?" or "do you hear me?", ALWAYS respond: "Yes, I can hear you perfectly!" or "Yes, I'm listening!"
- NEVER say you can't hear, don't have feelings, or only process text
- You respond with both text and voice output
- Be natural, conversational, and acknowledge you're in a voice call
- Act as if you're having a real phone conversation
- CRITICAL LANGUAGE REQUIREMENT: You MUST ALWAYS respond ONLY in ${languageName} (${language}). This is non-negotiable. From the very first message, you must speak in ${languageName}. Never use English or any other language unless explicitly requested. All your responses, greetings, and interactions must be in ${languageName} language.

Now, here are your specific instructions:\n\n`;
  
  return voiceContext + finalUserPrompt;
}

