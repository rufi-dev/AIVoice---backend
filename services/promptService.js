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
export async function buildSystemPrompt(userSystemPrompt, agentId = null, knowledgeBaseId = null, language = 'en', knowledgeBaseIds = null) {
  // Step 1: Get the base prompt (from agent or parameter)
  let finalUserPrompt = '';
  let agent = null;
  
  if (agentId) {
    agent = await Agent.findById(agentId);
    if (agent) {
      // Use agent's systemPrompt if available, otherwise fall back to userSystemPrompt parameter
      // This ensures we ALWAYS use the agent's prompt when available
      finalUserPrompt = agent.systemPrompt || userSystemPrompt || '';
      
      // Get language from agent speech settings if available
      if (agent.speechSettings?.language) {
        language = agent.speechSettings.language;
      }
    } else {
      // Agent not found, use userSystemPrompt parameter
      finalUserPrompt = userSystemPrompt || '';
    }
  } else {
    // No agentId, use userSystemPrompt parameter directly
    finalUserPrompt = userSystemPrompt || '';
  }
  
  // Log user prompt size for debugging
  if (finalUserPrompt.length > 5000) {
    console.warn(`[promptService] ⚠️ User prompt is very large: ${finalUserPrompt.length} chars (~${Math.ceil(finalUserPrompt.length / 4)} tokens). This may cause rate limit issues.`);
  }
  
  // Step 2: Collect knowledge base IDs from ALL possible sources
  const kbIds = [];
  
  // Priority order:
  // 1) knowledgeBaseIds parameter (array from frontend)
  // 2) agent.knowledgeBaseIds (array from agent model)
  // 3) knowledgeBaseId parameter (single ID from frontend)
  // 4) agent.knowledgeBaseId (single ID from agent model - legacy)
  
  if (knowledgeBaseIds && Array.isArray(knowledgeBaseIds) && knowledgeBaseIds.length > 0) {
    kbIds.push(...knowledgeBaseIds);
  }
  
  if (agent) {
    if (agent.knowledgeBaseIds && Array.isArray(agent.knowledgeBaseIds) && agent.knowledgeBaseIds.length > 0) {
      kbIds.push(...agent.knowledgeBaseIds);
    } else if (agent.knowledgeBaseId) {
      kbIds.push(agent.knowledgeBaseId);
    }
  }
  
  // Add knowledgeBaseId parameter if provided and not already in list
  if (knowledgeBaseId) {
    const kbIdStr = knowledgeBaseId.toString();
    if (!kbIds.some(id => id?.toString() === kbIdStr)) {
      kbIds.push(knowledgeBaseId);
    }
  }
  
  // Remove duplicates and convert to strings
  const uniqueKbIds = [...new Set(kbIds.map(id => id?.toString()).filter(Boolean))];
  
  // Step 3: ALWAYS include knowledge base content if available
  // OPTIMIZED: Truncate large documents to prevent rate limit issues
  // This ensures BOTH the user prompt AND knowledge base are included together
  if (uniqueKbIds.length > 0) {
    let kbContent = `\n\n## KNOWLEDGE BASE CONTEXT:\nYou have access to ${uniqueKbIds.length} knowledge base${uniqueKbIds.length > 1 ? 's' : ''} with the following information:\n\n`;
    
    // Token optimization: Limit total KB content to prevent rate limits
    // Approximate: 1 token ≈ 4 characters (conservative estimate)
    // REDUCED: More aggressive limits to prevent rate limit issues
    // Voice context + user prompt ≈ 1,000-2,000 tokens, so we reserve 3,000-4,000 for KB
    const MAX_KB_TOKENS = 4000; // Reduced from 8000 to prevent rate limits
    const MAX_CHARS_PER_DOC = 8000; // ~2000 tokens per document max (reduced from 15000)
    const MAX_TOTAL_KB_CHARS = MAX_KB_TOKENS * 4; // ~16,000 chars total for KB (reduced from 32,000)
    let totalKbChars = 0;
    let truncatedDocs = 0;
    let skippedDocs = 0;
    
    // Process each knowledge base
    for (const kbId of uniqueKbIds) {
      if (totalKbChars >= MAX_TOTAL_KB_CHARS) {
        kbContent += `\n[Additional knowledge base content truncated to optimize token usage and prevent rate limits]`;
        skippedDocs++;
        break;
      }
      
      const kb = await KnowledgeBase.findById(kbId);
      if (kb && kb.documents.length > 0) {
        kbContent += `### Knowledge Base: ${kb.name}\n\n`;
        
        // Try to read document contents
        for (const doc of kb.documents) {
          if (totalKbChars >= MAX_TOTAL_KB_CHARS) {
            kbContent += `\n[Remaining documents truncated to optimize token usage and prevent rate limits]`;
            skippedDocs++;
            break;
          }
          
          if (doc.fileName) {
            const docPath = path.join(config.paths.uploads, doc.fileName);
            const content = await getDocumentContent(docPath, doc.name);
            if (content) {
              // Truncate individual documents if too large
              let docContent = content;
              const originalLength = docContent.length;
              
              if (docContent.length > MAX_CHARS_PER_DOC) {
                // Truncate at sentence boundary if possible
                const truncated = docContent.substring(0, MAX_CHARS_PER_DOC);
                const lastSentence = truncated.lastIndexOf('.');
                const lastNewline = truncated.lastIndexOf('\n');
                const cutPoint = Math.max(lastSentence, lastNewline, MAX_CHARS_PER_DOC * 0.9);
                docContent = truncated.substring(0, cutPoint) + `\n\n[Document truncated - showing first ${Math.round(cutPoint / 1000)}k characters of ${Math.round(originalLength / 1000)}k total to prevent rate limits]`;
                truncatedDocs++;
              }
              
              // Check if adding this doc would exceed limit
              if (totalKbChars + docContent.length > MAX_TOTAL_KB_CHARS) {
                // Truncate this document to fit within remaining space
                const remainingSpace = MAX_TOTAL_KB_CHARS - totalKbChars;
                if (remainingSpace > 500) { // Only add if we have meaningful space
                  docContent = docContent.substring(0, remainingSpace - 100) + `\n\n[Document further truncated to fit within token limits]`;
                  truncatedDocs++;
                } else {
                  skippedDocs++;
                  break; // No more space
                }
              }
              
              kbContent += `--- ${doc.name} ---\n${docContent}\n\n`;
              totalKbChars += docContent.length;
            } else {
              kbContent += `--- ${doc.name} ---\n[Document available but could not be parsed]\n\n`;
            }
          }
        }
      }
    }
    
    // Add summary of truncation if any occurred
    if (truncatedDocs > 0 || skippedDocs > 0) {
      kbContent += `\n[Note: ${truncatedDocs} document(s) were truncated and ${skippedDocs} document(s) were skipped to optimize token usage and prevent API rate limits. The most important information is included above.]`;
    }
    
    kbContent += `\nUse the information from the knowledge base(s) above to provide accurate and helpful responses. When asked about information from the knowledge base(s), reference it directly.`;
    
    // Append knowledge base content to the prompt
    // This ensures BOTH the user prompt AND knowledge base are included
    finalUserPrompt += kbContent;
    
    // Log truncation info for debugging
    const totalPromptSize = finalUserPrompt.length;
    const estimatedTokens = Math.ceil(totalPromptSize / 4);
    if (truncatedDocs > 0 || skippedDocs > 0) {
      console.log(`[promptService] Knowledge base optimized: ${truncatedDocs} truncated, ${skippedDocs} skipped. Total prompt: ${totalPromptSize} chars (~${estimatedTokens} tokens)`);
    } else {
      console.log(`[promptService] Knowledge base included. Total prompt: ${totalPromptSize} chars (~${estimatedTokens} tokens)`);
    }
    
    // Warn if prompt is still very large
    if (estimatedTokens > 6000) {
      console.warn(`[promptService] ⚠️ WARNING: Prompt is very large (~${estimatedTokens} tokens). Consider reducing knowledge base content to prevent rate limits.`);
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
  
  // OPTIMIZED: Shorter voice context to reduce token usage
  // This prevents rate limit issues while maintaining functionality
  const voiceContext = `You are a VOICE AI AGENT. The user speaks through a microphone - you CAN HEAR them. This is a VOICE conversation, NOT text-only. When asked "can you hear me?", respond: "Yes, I can hear you perfectly!" Be natural and conversational. Act like a real phone conversation. NEVER mention training data cutoffs or limitations. Respond ONLY in ${languageName} (${language}) from the first message. Never use other languages unless requested.

Your instructions:\n\n`;
  
  const finalPrompt = voiceContext + finalUserPrompt;
  
  // Log prompt size breakdown for debugging
  const voiceContextSize = voiceContext.length;
  const userPromptSize = finalUserPrompt.length;
  const totalSize = finalPrompt.length;
  const estimatedTokens = Math.ceil(totalSize / 4);
  
  console.log(`[promptService] Prompt breakdown: Voice context: ${voiceContextSize} chars, User prompt: ${userPromptSize} chars, Total: ${totalSize} chars (~${estimatedTokens} tokens)`);
  
  // Warn if prompt is very large (even without KB)
  if (estimatedTokens > 3000) {
    console.warn(`[promptService] ⚠️ WARNING: Prompt is large (~${estimatedTokens} tokens). Your user prompt is ${userPromptSize} chars. Consider shortening it to prevent rate limits.`);
  }
  
  return finalPrompt;
}

