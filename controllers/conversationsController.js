import Conversation from '../models/Conversation.js';
import CallHistory from '../models/CallHistory.js';
import Agent from '../models/Agent.js';
import KnowledgeBase from '../models/KnowledgeBase.js';
import { buildSystemPrompt } from '../services/promptService.js';
import { getAIResponse, getStreamingAIResponse } from '../services/openaiService.js';
import { textToSpeech } from '../services/elevenLabsService.js';
import { getSentimentContext } from '../services/sentimentService.js';
import { config } from '../config/index.js';
import { mergeConversationAudio, deleteTemporaryAudioSegments } from '../services/audioMergeService.js';

function toAudioUrl(fileOrPath) {
  if (!fileOrPath) return null;
  const v = String(fileOrPath);
  if (!v) return null;
  if (v.startsWith('http://') || v.startsWith('https://')) return v;
  if (v.startsWith('/api/audio/')) return v;
  // elevenLabsService fallback returns `/audio/<file>.mp3`
  if (v.startsWith('/audio/')) return v;
  if (mongoose.Types.ObjectId.isValid(v)) return `/api/audio/${v}`;
  return v.startsWith('/') ? v : `/api/audio/${v}`;
}

/**
 * Start a new conversation
 */
export const startConversation = async (req, res) => {
  try {
    const { systemPrompt, conversationId, agentId, knowledgeBaseId, aiSpeaksFirst, publicToken } = req.body;
    
    // Get agent to retrieve language setting and verify ownership or public access
    let agent = null;
    if (agentId) {
      // If publicToken is provided, allow public access
      if (publicToken) {
        agent = await Agent.findOne({ 
          _id: agentId, 
          shareableToken: publicToken,
          isPublic: true 
        });
        if (!agent) {
          return res.status(404).json({ error: 'Agent not found or not publicly accessible' });
        }
      } else {
        // Regular authenticated access
        agent = await Agent.findOne({ _id: agentId, userId: req.userId });
        if (!agent) {
          return res.status(404).json({ error: 'Agent not found or access denied' });
        }
      }
    }
    
    const language = agent?.speechSettings?.language || 'en';
    
    // Build the final system prompt with voice context and knowledge base
    const finalSystemPrompt = await buildSystemPrompt(systemPrompt, agentId, knowledgeBaseId, language);
    
    if (!finalSystemPrompt) {
      return res.status(400).json({ error: 'System prompt is required' });
    }

    const startTime = new Date();
    
    // Verify knowledge base belongs to user if knowledgeBaseId is provided (skip for public access)
    if (knowledgeBaseId && !publicToken) {
      const kb = await KnowledgeBase.findOne({ _id: knowledgeBaseId, userId: req.userId });
      if (!kb) {
        return res.status(404).json({ error: 'Knowledge base not found or access denied' });
      }
    }

    // For public agents, userId might not be available - use agent owner's userId or null
    const userId = publicToken ? (agent?.userId || null) : req.userId;

    // Initialize conversation with system message
    const conversation = new Conversation({
      userId: userId,
      systemPrompt: finalSystemPrompt,
      agentId: agentId || null,
      knowledgeBaseId: knowledgeBaseId || null,
      messages: [
        {
          role: 'system',
          content: finalSystemPrompt
        }
      ],
      startTime: startTime
    });
    await conversation.save();

    // Create call history entry (only for authenticated users, skip for public)
    let callRecord = null;
    if (!publicToken && userId) {
      callRecord = new CallHistory({
        userId: userId,
      conversationId: conversation._id,
      agentId: agentId || null,
      agentName: agent ? agent.name : 'Unknown',
      startTime: startTime,
      status: 'active'
    });
    await callRecord.save();
    console.log(`✅ Call history created: ${callRecord._id} for agent: ${callRecord.agentName}`);
    } else if (publicToken) {
      console.log(`✅ Public conversation started (no call history for public access)`);
    }

    // If AI should speak first, generate an initial greeting
    let initialGreeting = null;
    let initialAudioUrl = null;
    
    if (aiSpeaksFirst && agent) {
      try {
        const speechSettings = agent.speechSettings || {};
        const openaiModel = speechSettings.openaiModel || 'gpt-4';
        
        // Get language name for the greeting
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

        // Generate initial greeting - MUST be in the selected language
        // Use a very strong prompt to force the language from the start
        const greetingPrompt = language !== 'en' 
          ? `You are starting a conversation. Greet the user in ${languageName} (${language}) language ONLY. Do NOT use English. Say "Hallo" or the equivalent greeting in ${languageName}. Keep it brief (1-2 sentences).`
          : `The conversation is starting. Greet the user naturally and ask how you can help them. Keep it brief and friendly.`;
        
        const greetingMessages = [
          {
            role: 'system',
            content: finalSystemPrompt
          },
          {
            role: 'user',
            content: greetingPrompt
          }
        ];

        const { content: greetingText, tokensUsed: greetingTokens } = await getAIResponse(greetingMessages, {
          model: openaiModel,
          temperature: 0.7,
          max_tokens: 100
        });

        initialGreeting = greetingText;

        // Generate audio for greeting
        try {
          // CRITICAL: Make sure we use the voiceId from speechSettings, not default
          const actualVoiceId = speechSettings.voiceId;
          if (!actualVoiceId) {
            console.warn('⚠️ No voiceId in speechSettings for initial greeting, using default');
          }
          
          console.log('🔊 Initial greeting voice settings:', {
            voiceId: actualVoiceId || config.elevenlabs.voiceId,
            voiceName: speechSettings.voiceName || 'Unknown',
            hasVoiceId: !!speechSettings.voiceId,
            allSpeechSettings: speechSettings
          });
          
          const greetingAudioFileId = await textToSpeech(greetingText, {
            voiceId: actualVoiceId || config.elevenlabs.voiceId,
            modelId: speechSettings.modelId || config.elevenlabs.modelId,
            stability: speechSettings.stability ?? 0.5,
            similarity_boost: speechSettings.similarityBoost ?? 0.75,
            type: 'conversation' // Will be saved as temporary segment
          });
          
          // Track this audio segment in conversation for later merging
          if (conversation && greetingAudioFileId) {
            conversation.audioSegments = conversation.audioSegments || [];
            conversation.audioSegments.push(greetingAudioFileId);
            await conversation.save();
          }
          
          // Return URL to access the audio (GridFS id or fallback path)
          initialAudioUrl = toAudioUrl(greetingAudioFileId);
        } catch (ttsError) {
          console.error('Error generating initial greeting audio:', ttsError);
        }

        // Add greeting to conversation
        conversation.messages.push({
          role: 'assistant',
          content: greetingText
        });
        await conversation.save();
      } catch (error) {
        console.error('Error generating initial greeting:', error);
      }
    }

    res.json({ 
      conversationId: conversation._id.toString(),
      id: conversation._id.toString(), // Also include id for compatibility
      message: 'Conversation started successfully',
      initialGreeting: initialGreeting,
      initialAudioUrl: initialAudioUrl
    });
  } catch (error) {
    console.error('Error starting conversation:', error);
    res.status(500).json({ error: 'Failed to start conversation' });
  }
};

/**
 * Get AI response with streaming and convert to speech
 */
export const chat = async (req, res) => {
  try {
    const { message, conversationId, agentId, publicToken } = req.body;

    if (!message || !conversationId) {
      return res.status(400).json({ error: 'Message and conversationId are required' });
    }

    // Find conversation and verify ownership or public access
    let conversation;
    if (publicToken) {
      // Public access - verify conversation belongs to a public agent
      conversation = await Conversation.findOne({ _id: conversationId });
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
    } else {
      conversation = await Conversation.findOne({ _id: conversationId, userId: req.userId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
      }
    }

    // Get agent first to check functions and get settings
    let agent = null;
    if (conversation.agentId) {
      if (publicToken) {
        agent = await Agent.findOne({ 
          _id: conversation.agentId,
          shareableToken: publicToken,
          isPublic: true 
        });
      } else {
        agent = await Agent.findOne({ _id: conversation.agentId, userId: req.userId });
      }
    }
    const speechSettings = agent?.speechSettings || {};
    // Speed-first default for voice streaming (Retell-like). Users can still set GPT-4 in UI,
    // but GPT-4o-mini is typically much faster and avoids TPM issues.
    const openaiModel = speechSettings.openaiModel || 'gpt-4o-mini';
    const language = speechSettings.language || 'en';
    const functions = agent?.functions || [];
    
    // Build OpenAI tools (function definitions) from agent functions
    // The AI will decide when to call these functions based on the conversation
    const tools = [];
    let shouldEndCall = false;
    let triggeredFunction = null;
    
    for (const func of functions) {
      if (!func || !func.enabled) continue;
      
      if (func.name === 'end_call') {
        // Define end_call as an OpenAI function
        tools.push({
          type: 'function',
          function: {
            name: 'end_call',
            description: func.description || 'End the call when the client wants to end the conversation, says goodbye, or indicates they don\'t want to talk anymore. Use this when the conversation should be terminated.',
            parameters: {
              type: 'object',
              properties: {
                reason: {
                  type: 'string',
                  description: 'The reason for ending the call (e.g., "client said goodbye", "client no longer wants to talk")'
                }
              },
              required: ['reason']
            }
          }
        });
        console.log('📋 Added end_call function to OpenAI tools');
      }
    }

    // Analyze sentiment from user message to understand emotional tone
    let sentimentContext = '';
    try {
      const sentimentResult = await getSentimentContext(message);
      sentimentContext = sentimentResult.context;
      console.log('🎭 Sentiment detected:', sentimentResult.sentiment);
    } catch (error) {
      console.error('Error analyzing sentiment:', error);
      // Continue without sentiment if analysis fails
    }

    // Add user message
    conversation.messages.push({
      role: 'user',
      content: message
    });

    // Convert messages to format expected by OpenAI
    // Add sentiment context to help AI understand user's emotional state
    const messagesForOpenAI = conversation.messages.map((msg, index, array) => {
      // Add sentiment context to the latest user message
      if (msg.role === 'user' && index === array.length - 1 && sentimentContext) {
        return {
          role: msg.role,
          content: `${sentimentContext}${msg.content}`
        };
      }
      return {
      role: msg.role,
      content: msg.content
      };
    });

    // Update system prompt with language if conversation doesn't have it yet
    // This ensures language is applied to all responses
    if (conversation.messages.length > 0 && conversation.messages[0].role === 'system') {
      const systemMessage = conversation.messages[0].content;
      // Check if language instruction is already in the prompt
      if (!systemMessage.includes(`MUST respond in`) && !systemMessage.includes(`respond in ${language}`)) {
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
        const languageInstruction = `\n\nIMPORTANT: You MUST respond in ${languageName} (${language}). All your responses should be in ${languageName} language.`;
        conversation.messages[0].content = systemMessage + languageInstruction;
        await conversation.save();
      }
    }

    // Use streaming to get response faster
    let fullResponse = '';
    let accumulatedText = '';

    // Stream the response from OpenAI with function calling support
    // Only include tools if end_call function is enabled
    const { content: aiResponse, tokensUsed, functionCalls } = await getStreamingAIResponse(
      messagesForOpenAI,
      {
      model: openaiModel,
      temperature: 0.7,
        max_tokens: 500,
        tools: tools.length > 0 ? tools : undefined, // Only include tools if we have functions enabled
        tool_choice: 'auto' // Let AI decide when to call functions
      },
      (chunk) => {
        // Accumulate chunks for full response
        fullResponse += chunk;
        accumulatedText += chunk;
      }
    );
    
    // Check if AI called the end_call function
    // Only process if end_call function was actually enabled and added to tools
    if (tools.length > 0 && functionCalls && functionCalls.length > 0) {
      for (const funcCall of functionCalls) {
        if (funcCall.function.name === 'end_call') {
          // Verify end_call function is actually enabled
          const endCallFunc = functions.find(f => f.name === 'end_call' && f.enabled);
          if (endCallFunc) {
            shouldEndCall = true;
            triggeredFunction = { name: 'end_call' };
            try {
              const args = JSON.parse(funcCall.function.arguments || '{}');
              console.log(`🔚 AI called end_call function. Reason: ${args.reason || 'Not specified'}`);
            } catch (e) {
              console.log(`🔚 AI called end_call function`);
            }
            break;
          } else {
            console.log('⚠️ AI tried to call end_call but function is not enabled');
          }
        }
      }
    }

    // OpenAI can legally return a tool call with no assistant content.
    // Our Conversation model requires `content`, so ensure we always persist non-empty text.
    let finalAiResponse = (aiResponse || '').trim();
    if (!finalAiResponse) {
      finalAiResponse = shouldEndCall
        ? "Goodbye! Have a great day."
        : "Sorry — I didn't catch that. Could you repeat?";
    }

    // Add AI response to conversation
    conversation.messages.push({
      role: 'assistant',
      content: finalAiResponse
    });
    await conversation.save();

    // Update call history with latest messages and cost (only for authenticated users)
    const userId = publicToken ? (conversation.userId || null) : req.userId;
    const callRecord = userId ? await CallHistory.findOne({ 
      conversationId: conversationId,
      userId: userId,
      status: 'active'
    }) : null;
    
    if (callRecord) {
      // Update messages (excluding system message for cleaner history)
      const userMessages = conversation.messages
        .filter(msg => msg.role !== 'system')
        .map(msg => ({
          role: msg.role,
          content: msg.content
        }));
      callRecord.messages = userMessages;
      
      // Calculate cost based on model and tokens used
      // Pricing per 1K tokens (as of 2024):
      // GPT-4: $0.03 input, $0.06 output per 1K tokens
      // GPT-4o: $0.005 input, $0.015 output per 1K tokens
      // GPT-3.5-turbo: $0.0015 input, $0.002 output per 1K tokens
      let costPer1K = 0.03; // Default for GPT-4
      if (openaiModel.includes('gpt-4o')) {
        costPer1K = 0.01; // Average of input/output for GPT-4o
      } else if (openaiModel.includes('gpt-3.5')) {
        costPer1K = 0.002; // Average for GPT-3.5
      } else if (openaiModel.includes('gpt-4-turbo')) {
        costPer1K = 0.01; // GPT-4 Turbo pricing
      }
      
      const messageCost = (tokensUsed / 1000) * costPer1K;
      callRecord.cost = (callRecord.cost || 0) + messageCost;
      
      console.log(`💰 Cost calculation: ${tokensUsed} tokens × $${costPer1K}/1K = $${messageCost.toFixed(6)}, Total: $${callRecord.cost.toFixed(6)}`);
      
      // If end_call function was triggered, mark call as ended
      if (shouldEndCall && triggeredFunction) {
        callRecord.status = 'ended';
        callRecord.endTime = new Date();
        callRecord.endReason = 'function_triggered';
        const duration = Math.floor((callRecord.endTime - callRecord.startTime) / 1000);
        callRecord.duration = duration;
        console.log(`✅ Call ended by function: ${triggeredFunction.name}`);
      }
      
      await callRecord.save();
      console.log(`📝 Call history updated for ${callRecord._id}, total messages: ${callRecord.messages.length}`);
    } else {
      console.log(`⚠️ Warning: Call record not found for conversation ${conversationId}`);
    }

    // If end_call function was triggered, return response with shouldEndCall flag (before generating audio)
    if (shouldEndCall && triggeredFunction) {
      // Still generate audio for the goodbye message
      let audioUrl = null;
      try {
        const speechSettings = agent?.speechSettings || {};
        const actualVoiceId = speechSettings.voiceId;
        
        console.log('🔊 Generating audio for end_call response:', {
          voiceId: actualVoiceId || config.elevenlabs.voiceId,
          voiceName: speechSettings.voiceName || 'Unknown',
          modelId: speechSettings.modelId || config.elevenlabs.modelId,
        });
        
        const audioFileId = await textToSpeech(finalAiResponse, {
          voiceId: actualVoiceId,
          modelId: speechSettings.modelId || config.elevenlabs.modelId,
          stability: speechSettings.stability ?? 0.5,
          similarity_boost: speechSettings.similarityBoost ?? 0.75,
          type: 'conversation' // Will be saved as temporary segment
        });
        
        // Track this audio segment in conversation for later merging
        if (conversation && audioFileId) {
          conversation.audioSegments = conversation.audioSegments || [];
          conversation.audioSegments.push(audioFileId);
          await conversation.save();
        }
        
        audioUrl = toAudioUrl(audioFileId);
      } catch (error) {
        console.error('Error generating audio for end_call:', error);
      }
      
      return res.json({
        text: finalAiResponse,
        audioUrl: audioUrl,
        shouldEndCall: true,
        functionTriggered: 'end_call'
      });
    }

    // Convert to speech using ElevenLabs (generate audio for full response)
    let audioUrl = null;
    try {
      // Use the speech settings we already fetched above
      const speechSettings = agent?.speechSettings || {};
      
      // CRITICAL: Use the voiceId from speechSettings, not default
      // Only use default if voiceId is truly missing
      const actualVoiceId = speechSettings.voiceId;
      
      console.log('🔊 Using voice settings for TTS:', {
        voiceId: actualVoiceId || config.elevenlabs.voiceId,
        voiceName: speechSettings.voiceName || 'Unknown',
        modelId: speechSettings.modelId || config.elevenlabs.modelId,
        language: speechSettings.language || 'en',
        agentId: agentId,
        hasVoiceId: !!speechSettings.voiceId,
        allSpeechSettings: JSON.stringify(speechSettings)
      });
      
      // Ensure we're using the correct voice ID
      if (!actualVoiceId) {
        console.warn('⚠️ No voiceId in speechSettings, using default:', config.elevenlabs.voiceId);
      } else {
        console.log('✅ Using custom voice:', actualVoiceId, speechSettings.voiceName);
      }
      
      const audioFileId = await textToSpeech(finalAiResponse, {
        voiceId: actualVoiceId || config.elevenlabs.voiceId,
        modelId: speechSettings.modelId || config.elevenlabs.modelId,
        stability: speechSettings.stability ?? 0.5,
        similarity_boost: speechSettings.similarityBoost ?? 0.75,
        type: 'conversation' // Will be saved as temporary segment
      });
      
      // Track this audio segment in conversation for later merging
      if (conversation && audioFileId) {
        conversation.audioSegments = conversation.audioSegments || [];
        conversation.audioSegments.push(audioFileId);
        await conversation.save();
      }
      
      // Return URL to access the audio from GridFS (temporary)
      audioUrl = toAudioUrl(audioFileId);
    } catch (ttsError) {
      console.error('Text-to-speech error:', ttsError);
      // Continue without audio if TTS fails
    }

    res.json({
      text: finalAiResponse,
      audioUrl: audioUrl,
      tokensUsed: tokensUsed
    });
  } catch (error) {
    console.error('Error in chat:', error);
    res.status(500).json({ error: error.message || 'Failed to process chat request' });
  }
};

/**
 * Prefetch a draft assistant response while user is still speaking.
 * Streams NDJSON events:
 * - { type: 'assistant_delta', delta }
 * - { type: 'latency', latency }
 * - { type: 'done' }
 *
 * NOTE: This does NOT persist messages to MongoDB (speculative).
 */
export const prefetchDraft = async (req, res) => {
  const startedAt = Date.now();
  let firstTokenAt = null;

  // NDJSON streaming
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Hint for proxies (nginx) not to buffer streaming responses
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}\n`);
    } catch (e) {
      // ignore
    }
  };

  const abortController = new AbortController();
  req.on('close', () => {
    try {
      abortController.abort();
    } catch (e) {}
  });

  try {
    const { conversationId, draftText, publicToken } = req.body;

    if (!conversationId || !draftText) {
      write({ type: 'error', error: 'conversationId and draftText are required' });
      return res.end();
    }

    // Find conversation and verify ownership or public access
    let conversation;
    if (publicToken) {
      conversation = await Conversation.findOne({ _id: conversationId });
      if (!conversation) {
        write({ type: 'error', error: 'Conversation not found' });
        return res.end();
      }
    } else {
      conversation = await Conversation.findOne({ _id: conversationId, userId: req.userId });
      if (!conversation) {
        write({ type: 'error', error: 'Conversation not found' });
        return res.end();
      }
    }

    // Load agent settings
    let agent = null;
    if (conversation.agentId) {
      if (publicToken) {
        agent = await Agent.findOne({
          _id: conversation.agentId,
          shareableToken: publicToken,
          isPublic: true
        });
      } else {
        agent = await Agent.findOne({ _id: conversation.agentId, userId: req.userId });
      }
    }
    const speechSettings = agent?.speechSettings || {};
    // IMPORTANT: Prefetch can easily hit OpenAI TPM limits if it uses GPT-4.
    // Use a fast/cheap model for speculative draft.
    const openaiModel = 'gpt-4o-mini';
    const language = speechSettings.language || 'en';

    // Build messages (speculative last user message)
    const messagesForOpenAI = (conversation.messages || []).map((msg) => ({
      role: msg.role,
      content: msg.content
    }));

    // Ensure language instruction is present (same logic as chat, but do not persist)
    if (messagesForOpenAI.length > 0 && messagesForOpenAI[0].role === 'system') {
      const systemMessage = messagesForOpenAI[0].content || '';
      if (!systemMessage.includes(`MUST respond in`) && !systemMessage.includes(`respond in ${language}`)) {
        const languageMap = {
          en: 'English',
          es: 'Spanish',
          fr: 'French',
          de: 'German',
          it: 'Italian',
          pt: 'Portuguese',
          zh: 'Chinese',
          ja: 'Japanese',
          ko: 'Korean',
          ru: 'Russian',
          ar: 'Arabic',
          hi: 'Hindi'
        };
        const languageName = languageMap[language] || 'English';
        messagesForOpenAI[0].content = `${systemMessage}\n\nIMPORTANT: You MUST respond in ${languageName} (${language}). All your responses should be in ${languageName} language.`;
      }
    }

    messagesForOpenAI.push({
      role: 'user',
      content: `Partial speech (may change): ${String(draftText).trim()}`
    });

    await getStreamingAIResponse(
      messagesForOpenAI,
      {
        model: openaiModel,
        temperature: 0.7,
        max_tokens: 80,
        signal: abortController.signal
      },
      (delta) => {
        if (!firstTokenAt) firstTokenAt = Date.now();
        write({ type: 'assistant_delta', delta });
      }
    );

    write({
      type: 'latency',
      latency: {
        llmFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
        llmTotalMs: Date.now() - startedAt
      }
    });
    write({ type: 'done' });
    res.end();
  } catch (error) {
    const isAborted = abortController.signal?.aborted;
    if (!isAborted) {
      const retryAfterMs =
        Number(error?.headers?.['retry-after-ms']) ||
        (Number(error?.headers?.['retry-after']) ? Number(error.headers['retry-after']) * 1000 : null);
      if (error?.status === 429 || error?.code === 'rate_limit_exceeded') {
        write({ type: 'rate_limited', retryAfterMs });
      } else {
        console.error('Error in prefetchDraft:', error);
        write({ type: 'error', error: error.message || 'Prefetch failed' });
      }
    }
    res.end();
  }
};

function _pickTtsChunk(pending, options = {}) {
  // Smaller chunks => earlier speech (Retell-like).
  const minLen = options.minLen ?? 22;
  const maxLen = options.maxLen ?? 160;
  const text = pending || '';
  if (text.trim().length < minLen) return { chunk: null, rest: text };

  // Prefer sentence boundaries after minLen
  const boundaryRe = /[.!?]\s+|\n+/g;
  let match;
  while ((match = boundaryRe.exec(text)) !== null) {
    const endIdx = match.index + match[0].length;
    if (endIdx >= minLen) {
      const chunk = text.slice(0, endIdx);
      const rest = text.slice(endIdx);
      return { chunk, rest };
    }
    if (boundaryRe.lastIndex > maxLen) break;
  }

  // If too long with no boundary, cut at last space before maxLen
  if (text.length >= maxLen) {
    const cut = text.lastIndexOf(' ', maxLen);
    const endIdx = cut > minLen ? cut : maxLen;
    const chunk = text.slice(0, endIdx);
    const rest = text.slice(endIdx);
    return { chunk, rest };
  }

  return { chunk: null, rest: text };
}

function _updateLatencySummary(callRecord) {
  try {
    const turns = callRecord.latencyTurns || [];
    if (!turns.length) return;
    const avg = (arr) => {
      const nums = arr.filter((n) => typeof n === 'number' && Number.isFinite(n));
      if (!nums.length) return null;
      return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
    };
    callRecord.latencySummary = {
      avgE2eFirstAudioMs: avg(turns.map((t) => t.e2eFirstAudioMs)),
      avgLlmFirstTokenMs: avg(turns.map((t) => t.llmFirstTokenMs)),
      avgTtsFirstAudioMs: avg(turns.map((t) => t.ttsFirstAudioMs)),
      lastTurn: {
        asrFinalMs: turns[turns.length - 1]?.asrFinalMs ?? null,
        llmFirstTokenMs: turns[turns.length - 1]?.llmFirstTokenMs ?? null,
        llmTotalMs: turns[turns.length - 1]?.llmTotalMs ?? null,
        ttsFirstAudioMs: turns[turns.length - 1]?.ttsFirstAudioMs ?? null,
        ttsTotalMs: turns[turns.length - 1]?.ttsTotalMs ?? null,
        e2eFirstAudioMs: turns[turns.length - 1]?.e2eFirstAudioMs ?? null
      }
    };
  } catch (e) {
    // ignore
  }
}

/**
 * Stream chat response with early chunked TTS (Retell-like feel).
 * Streams NDJSON events:
 * - { type: 'assistant_delta', delta }
 * - { type: 'tts_audio', audioUrl, text, index }
 * - { type: 'latency', latency }
 * - { type: 'final', text, shouldEndCall }
 * - { type: 'done' }
 */
export const chatStream = async (req, res) => {
  const startedAt = Date.now();
  let firstTokenAt = null;
  let firstTtsAt = null;
  let ttsDoneAt = null;
  let llmDoneAt = null;
  let firstTtsChunkQueuedAt = null;

  // NDJSON streaming
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Hint for proxies (nginx) not to buffer streaming responses
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (obj) => {
    try {
      res.write(`${JSON.stringify(obj)}\n`);
    } catch (e) {
      // ignore
    }
  };

  const abortController = new AbortController();
  req.on('close', () => {
    try {
      abortController.abort();
    } catch (e) {}
  });

  try {
    const { message, conversationId, agentId, publicToken, clientTimings } = req.body;
    if (!message || !conversationId) {
      write({ type: 'error', error: 'Message and conversationId are required' });
      return res.end();
    }

    // Find conversation and verify ownership or public access
    let conversation;
    if (publicToken) {
      conversation = await Conversation.findOne({ _id: conversationId });
      if (!conversation) {
        write({ type: 'error', error: 'Conversation not found' });
        return res.end();
      }
    } else {
      conversation = await Conversation.findOne({ _id: conversationId, userId: req.userId });
      if (!conversation) {
        write({ type: 'error', error: 'Conversation not found' });
        return res.end();
      }
    }

    // Get agent first to check functions and get settings
    let agent = null;
    if (conversation.agentId) {
      if (publicToken) {
        agent = await Agent.findOne({
          _id: conversation.agentId,
          shareableToken: publicToken,
          isPublic: true
        });
      } else {
        agent = await Agent.findOne({ _id: conversation.agentId, userId: req.userId });
      }
    } else if (agentId && !publicToken) {
      agent = await Agent.findOne({ _id: agentId, userId: req.userId });
    }

    const speechSettings = agent?.speechSettings || {};
    const openaiModel = speechSettings.openaiModel || 'gpt-4';
    const language = speechSettings.language || 'en';
    const functions = agent?.functions || [];

    // Build OpenAI tools (function definitions)
    const tools = [];
    let shouldEndCall = false;
    let triggeredFunction = null;

    for (const func of functions) {
      if (!func || !func.enabled) continue;
      if (func.name === 'end_call') {
        tools.push({
          type: 'function',
          function: {
            name: 'end_call',
            description:
              func.description ||
              "End the call when the client wants to end the conversation, says goodbye, or indicates they don't want to talk anymore. Use this when the conversation should be terminated.",
            parameters: {
              type: 'object',
              properties: {
                reason: {
                  type: 'string',
                  description: 'The reason for ending the call'
                }
              },
              required: ['reason']
            }
          }
        });
      }
    }

    // Persist user message
    conversation.messages.push({ role: 'user', content: message });

    // Convert messages to format expected by OpenAI (skip sentiment here to reduce latency)
    const messagesForOpenAI = conversation.messages.map((msg) => ({
      role: msg.role,
      content: msg.content
    }));

    // Ensure language instruction is persisted once
    if (conversation.messages.length > 0 && conversation.messages[0].role === 'system') {
      const systemMessage = conversation.messages[0].content;
      if (!systemMessage.includes(`MUST respond in`) && !systemMessage.includes(`respond in ${language}`)) {
        const languageMap = {
          en: 'English',
          es: 'Spanish',
          fr: 'French',
          de: 'German',
          it: 'Italian',
          pt: 'Portuguese',
          zh: 'Chinese',
          ja: 'Japanese',
          ko: 'Korean',
          ru: 'Russian',
          ar: 'Arabic',
          hi: 'Hindi'
        };
        const languageName = languageMap[language] || 'English';
        const languageInstruction = `\n\nIMPORTANT: You MUST respond in ${languageName} (${language}). All your responses should be in ${languageName} language.`;
        conversation.messages[0].content = systemMessage + languageInstruction;
      }
    }

    // Streaming LLM + chunked TTS
    let fullText = '';
    let pendingSpeak = '';
    const functionCallsAcc = [];

    const audioSegmentIds = [];
    const ttsQueue = [];
    let ttsProcessing = false;
    let ttsIndex = 0;
    let ttsResolve = null;
    const ttsIdle = () =>
      new Promise((resolve) => {
        if (!ttsQueue.length && !ttsProcessing) return resolve();
        ttsResolve = resolve;
      });

    const drainTtsQueue = async () => {
      if (ttsProcessing) return;
      ttsProcessing = true;
      try {
        while (ttsQueue.length && !abortController.signal.aborted) {
          const chunkText = (ttsQueue.shift() || '').trim();
          if (!chunkText) continue;

          const ttsStart = Date.now();
          const audioFileId = await textToSpeech(chunkText, {
            voiceId: speechSettings.voiceId || config.elevenlabs.voiceId,
            modelId: speechSettings.modelId || config.elevenlabs.modelId,
            stability: speechSettings.stability ?? 0.5,
            similarity_boost: speechSettings.similarityBoost ?? 0.75,
            type: 'conversation'
          });
          const ttsEnd = Date.now();

          if (!firstTtsAt) firstTtsAt = ttsEnd;
          ttsDoneAt = ttsEnd;

          const audioUrl = toAudioUrl(audioFileId);
          if (audioUrl) {
            // Only keep mergeable GridFS ids for later merging
            if (mongoose.Types.ObjectId.isValid(String(audioFileId))) {
              audioSegmentIds.push(String(audioFileId));
            }
            write({
              type: 'tts_audio',
              index: ttsIndex++,
              text: chunkText,
              audioUrl,
              ttsMs: ttsEnd - ttsStart
            });
          }
        }
      } catch (e) {
        if (!abortController.signal.aborted) {
          console.error('TTS queue error:', e);
          write({ type: 'tts_error', error: e.message || 'TTS failed' });
        }
      } finally {
        ttsProcessing = false;
        if (ttsResolve && !ttsQueue.length) {
          const r = ttsResolve;
          ttsResolve = null;
          r();
        }
      }
    };

    const maybeQueueChunks = () => {
      // Pull as many ready chunks as possible
      while (true) {
        const { chunk, rest } = _pickTtsChunk(pendingSpeak, { minLen: 22, maxLen: 160 });
        if (!chunk) break;
        pendingSpeak = rest || '';
        ttsQueue.push(chunk);
        if (!firstTtsChunkQueuedAt) firstTtsChunkQueuedAt = Date.now();
      }
      // If we haven't queued anything yet, force an early chunk after a short time budget.
      // This prevents "text appears fast but audio starts 5s later" feeling.
      if (!firstTtsChunkQueuedAt && firstTokenAt) {
        const msSinceFirstToken = Date.now() - firstTokenAt;
        const trimmedLen = (pendingSpeak || '').trim().length;
        if (msSinceFirstToken >= 650 && trimmedLen >= 18) {
          // Cut at a reasonable boundary (space) to avoid mid-word.
          const maxLen = 120;
          const cut = pendingSpeak.lastIndexOf(' ', Math.min(maxLen, pendingSpeak.length));
          const endIdx = cut > 10 ? cut : Math.min(maxLen, pendingSpeak.length);
          const forced = pendingSpeak.slice(0, endIdx);
          pendingSpeak = pendingSpeak.slice(endIdx);
          ttsQueue.push(forced);
          firstTtsChunkQueuedAt = Date.now();
        }
      }
      if (ttsQueue.length) {
        // async drain
        drainTtsQueue();
      }
    };

    const { content: aiResponse, tokensUsed, functionCalls } = await getStreamingAIResponse(
      messagesForOpenAI,
      {
        model: openaiModel,
        temperature: 0.7,
        // Voice calls shouldn't generate huge essays; smaller output is faster.
        max_tokens: 220,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: 'auto',
        signal: abortController.signal
      },
      (delta) => {
        if (!firstTokenAt) firstTokenAt = Date.now();
        fullText += delta;
        pendingSpeak += delta;
        write({ type: 'assistant_delta', delta });
        maybeQueueChunks();
      }
    );
    llmDoneAt = Date.now();

    if (functionCalls && functionCalls.length) {
      for (const fc of functionCalls) functionCallsAcc.push(fc);
    }

    // Determine if end_call triggered
    if (tools.length > 0 && functionCallsAcc.length > 0) {
      for (const funcCall of functionCallsAcc) {
        if (funcCall.function.name === 'end_call') {
          const endCallFunc = functions.find((f) => f.name === 'end_call' && f.enabled);
          if (endCallFunc) {
            shouldEndCall = true;
            triggeredFunction = { name: 'end_call' };
            break;
          }
        }
      }
    }

    let finalAiResponse = (aiResponse || fullText || '').trim();
    if (!finalAiResponse) {
      finalAiResponse = shouldEndCall ? 'Goodbye! Have a great day.' : "Sorry — I didn't catch that. Could you repeat?";
    }

    // Enqueue remaining text for TTS
    if (pendingSpeak.trim()) {
      ttsQueue.push(pendingSpeak);
      pendingSpeak = '';
      drainTtsQueue();
    }

    // Wait for TTS queue to finish before closing response
    await ttsIdle();

    // Persist assistant message + audio segments
    conversation.messages.push({ role: 'assistant', content: finalAiResponse });
    conversation.audioSegments = conversation.audioSegments || [];
    if (audioSegmentIds.length) {
      conversation.audioSegments.push(...audioSegmentIds);
    }
    await conversation.save();

    // Update call history: messages, cost, latency
    const userId = publicToken ? (conversation.userId || null) : req.userId;
    const callRecord = userId
      ? await CallHistory.findOne({ conversationId: conversationId, userId: userId, status: 'active' })
      : null;

    if (callRecord) {
      callRecord.messages = conversation.messages
        .filter((msg) => msg.role !== 'system')
        .map((msg) => ({ role: msg.role, content: msg.content }));

      let costPer1K = 0.03;
      if (openaiModel.includes('gpt-4o')) costPer1K = 0.01;
      else if (openaiModel.includes('gpt-3.5')) costPer1K = 0.002;
      else if (openaiModel.includes('gpt-4-turbo')) costPer1K = 0.01;
      const messageCost = (tokensUsed / 1000) * costPer1K;
      callRecord.cost = (callRecord.cost || 0) + messageCost;

      // Latency turn
      const asrFinalMs =
        clientTimings && typeof clientTimings.asr_final_ms === 'number' ? clientTimings.asr_final_ms : null;
      const llmFirstTokenMs = firstTokenAt ? firstTokenAt - startedAt : null;
      const llmTotalMs = llmDoneAt ? llmDoneAt - startedAt : Date.now() - startedAt;
      const ttsFirstAudioMs = firstTtsAt ? firstTtsAt - startedAt : null;
      const ttsTotalMs = ttsDoneAt ? ttsDoneAt - startedAt : null;
      const e2eFirstAudioMs = firstTtsAt ? firstTtsAt - startedAt : null;

      callRecord.latencyTurns = callRecord.latencyTurns || [];
      callRecord.latencyTurns.push({
        userText: message,
        mode: 'chunked_tts',
        llmModel: openaiModel,
        tokensUsed: typeof tokensUsed === 'number' ? tokensUsed : null,
        asrFinalMs,
        llmFirstTokenMs,
        llmTotalMs,
        ttsFirstAudioMs,
        ttsTotalMs,
        e2eFirstAudioMs
      });
      _updateLatencySummary(callRecord);

      // If end_call function was triggered, end call
      if (shouldEndCall && triggeredFunction) {
        callRecord.status = 'ended';
        callRecord.endTime = new Date();
        callRecord.endReason = 'function_triggered';
        const duration = Math.floor((callRecord.endTime - callRecord.startTime) / 1000);
        callRecord.duration = duration;
      }

      await callRecord.save();
    }

    write({
      type: 'latency',
      latency: {
        llmFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
        llmTotalMs: llmDoneAt ? llmDoneAt - startedAt : null,
        ttsFirstAudioMs: firstTtsAt ? firstTtsAt - startedAt : null,
        ttsTotalMs: ttsDoneAt ? ttsDoneAt - startedAt : null,
        e2eFirstAudioMs: firstTtsAt ? firstTtsAt - startedAt : null
      }
    });
    write({ type: 'final', text: finalAiResponse, shouldEndCall: !!shouldEndCall });
    write({ type: 'done' });
    res.end();
  } catch (error) {
    const isAborted = abortController.signal?.aborted;
    if (!isAborted) {
      const retryAfterMs =
        Number(error?.headers?.['retry-after-ms']) ||
        (Number(error?.headers?.['retry-after']) ? Number(error.headers['retry-after']) * 1000 : null);
      if (error?.status === 429 || error?.code === 'rate_limit_exceeded') {
        write({ type: 'rate_limited', retryAfterMs });
      } else {
        console.error('Error in chatStream:', error);
        write({ type: 'error', error: error.message || 'Failed to process chat stream' });
      }
    }
    res.end();
  }
};

/**
 * Generate a cutting phrase when user interrupts agent
 */
export const getCuttingPhrase = async (req, res) => {
  try {
    const { conversationId, agentId } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: 'ConversationId is required' });
    }

    const conversation = await Conversation.findOne({ _id: conversationId, userId: req.userId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Get agent speech settings
    const agent = agentId ? await Agent.findOne({ _id: agentId, userId: req.userId }) : null;
    const speechSettings = agent?.speechSettings || {};
    const openaiModel = speechSettings.openaiModel || 'gpt-4';

    // Generate a short cutting phrase
    const cuttingMessages = [
      {
        role: 'system',
        content: 'You are in a voice conversation. When the user interrupts you while you are speaking, respond with a very brief, natural acknowledgment phrase (1-3 words) like "okay sure", "yeah", "go ahead", "continue", "alright", etc. Keep it extremely short and conversational.'
      }
    ];

    const { content: cuttingPhrase } = await getAIResponse(cuttingMessages, {
      model: openaiModel,
      temperature: 0.8,
      max_tokens: 15
    });

    // Generate audio for cutting phrase
    let cuttingAudioUrl = null;
    try {
      const cuttingVoiceId = speechSettings.voiceId || config.elevenlabs.voiceId;
      console.log('🔊 Cutting phrase voice:', cuttingVoiceId, speechSettings.voiceName);
      
      const cuttingAudioFileId = await textToSpeech(cuttingPhrase.trim(), {
        voiceId: cuttingVoiceId,
        modelId: speechSettings.modelId || config.elevenlabs.modelId,
        stability: speechSettings.stability ?? 0.5,
        similarity_boost: speechSettings.similarityBoost ?? 0.75,
        type: 'conversation' // Will be saved as temporary segment
      });
      
      // Track this audio segment in conversation for later merging
      if (conversation && cuttingAudioFileId) {
        conversation.audioSegments = conversation.audioSegments || [];
        conversation.audioSegments.push(cuttingAudioFileId);
        await conversation.save();
      }
      // Return URL to access the audio from GridFS
      cuttingAudioUrl = toAudioUrl(cuttingAudioFileId);
    } catch (ttsError) {
      console.error('Error generating cutting phrase audio:', ttsError);
    }

    res.json({
      text: cuttingPhrase.trim(),
      audioUrl: cuttingAudioUrl
    });
  } catch (error) {
    console.error('Error generating cutting phrase:', error);
    res.status(500).json({ error: 'Failed to generate cutting phrase' });
  }
};

/**
 * Get conversation by ID
 */
export const getConversation = async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ _id: req.params.id, userId: req.userId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    // Map _id to id for frontend compatibility
    const conversationWithId = {
      ...conversation.toObject(),
      id: conversation._id.toString()
    };
    res.json(conversationWithId);
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
};

/**
 * Delete conversation
 */
export const deleteConversation = async (req, res) => {
  try {
    await Conversation.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    await CallHistory.findOneAndDelete({ conversationId: req.params.id, userId: req.userId });
    res.json({ message: 'Conversation deleted' });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
};

/**
 * End conversation and finalize call history
 */
export const endConversation = async (req, res) => {
  try {
    const { publicToken } = req.body;
    
    // Find conversation and verify ownership or public access
    let conversation;
    if (publicToken) {
      conversation = await Conversation.findOne({ _id: req.params.id });
      if (conversation && conversation.agentId) {
        const agent = await Agent.findOne({ 
          _id: conversation.agentId,
          shareableToken: publicToken,
          isPublic: true 
        });
        if (!agent) {
          return res.status(404).json({ error: 'Conversation not found or not publicly accessible' });
        }
      } else {
        return res.status(404).json({ error: 'Conversation not found' });
      }
    } else {
      conversation = await Conversation.findOne({ _id: req.params.id, userId: req.userId });
    }
    
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    // Find call history by conversation ID and user (only for authenticated users)
    const userId = publicToken ? (conversation.userId || null) : req.userId;
    const callRecord = userId ? await CallHistory.findOne({ 
      conversationId: req.params.id,
      userId: userId,
      status: 'active'
    }) : null;
    
    if (!callRecord) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const endTime = new Date();
    const startTime = callRecord.startTime;
    const duration = Math.floor((endTime - startTime) / 1000); // Duration in seconds

    callRecord.endTime = endTime;
    callRecord.duration = duration;
    callRecord.status = 'ended';
    callRecord.endReason = req.body.endReason || 'user_hangup';
    
    if (conversation) {
      // Exclude system message from call history for cleaner display
      callRecord.messages = conversation.messages
        .filter(msg => msg.role !== 'system')
        .map(msg => ({
          role: msg.role,
          content: msg.content
        }));
      
      // Merge all audio segments into one full conversation audio file
      if (conversation.audioSegments && conversation.audioSegments.length > 0) {
        try {
          console.log(`🔗 Merging ${conversation.audioSegments.length} audio segments for conversation ${conversation._id}`);
          const mergedAudioFileId = await mergeConversationAudio(
            conversation.audioSegments,
            conversation._id.toString()
          );
          
          // Store the merged audio file ID in call history
          callRecord.audioUrl = toAudioUrl(mergedAudioFileId);
          console.log(`✅ Full conversation audio saved: ${mergedAudioFileId}`);
          
          // Delete temporary audio segments after merging
          try {
            await deleteTemporaryAudioSegments(conversation.audioSegments);
          } catch (deleteError) {
            console.error('⚠️ Error deleting temporary segments (non-critical):', deleteError);
          }
        } catch (mergeError) {
          console.error('❌ Error merging conversation audio:', mergeError);
          // Continue without audio if merge fails
        }
      }
    }

    await callRecord.save();
    console.log(`✅ Call ended: ${callRecord._id}, duration: ${duration}s, messages: ${callRecord.messages.length}`);
    // Map _id to id for frontend compatibility
    const callRecordWithId = {
      ...callRecord.toObject(),
      id: callRecord._id.toString()
    };
    res.json(callRecordWithId);
  } catch (error) {
    console.error('Error ending conversation:', error);
    res.status(500).json({ error: 'Failed to end conversation' });
  }
};

