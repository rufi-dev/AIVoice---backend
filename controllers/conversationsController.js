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

/**
 * Start a new conversation
 */
export const startConversation = async (req, res) => {
  try {
    const { systemPrompt, conversationId, agentId, knowledgeBaseId, aiSpeaksFirst } = req.body;
    
    // Get agent to retrieve language setting and verify ownership
    let agent = null;
    if (agentId) {
      agent = await Agent.findOne({ _id: agentId, userId: req.userId });
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found or access denied' });
      }
    }
    
    const language = agent?.speechSettings?.language || 'en';
    
    // Build the final system prompt with voice context and knowledge base
    const finalSystemPrompt = await buildSystemPrompt(systemPrompt, agentId, knowledgeBaseId, language);
    
    if (!finalSystemPrompt) {
      return res.status(400).json({ error: 'System prompt is required' });
    }

    const startTime = new Date();

    // Verify knowledge base belongs to user if knowledgeBaseId is provided
    if (knowledgeBaseId) {
      const kb = await KnowledgeBase.findOne({ _id: knowledgeBaseId, userId: req.userId });
      if (!kb) {
        return res.status(404).json({ error: 'Knowledge base not found or access denied' });
      }
    }

    // Initialize conversation with system message
    const conversation = new Conversation({
      userId: req.userId,
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

    // Create call history entry (agent already fetched above)
    const callRecord = new CallHistory({
      userId: req.userId,
      conversationId: conversation._id,
      agentId: agentId || null,
      agentName: agent ? agent.name : 'Unknown',
      startTime: startTime,
      status: 'active'
    });
    await callRecord.save();
    console.log(`✅ Call history created: ${callRecord._id} for agent: ${callRecord.agentName}`);

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
          
          // Return URL to access the audio from GridFS (temporary)
          initialAudioUrl = `/api/audio/${greetingAudioFileId}`;
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
    const { message, conversationId, agentId } = req.body;

    if (!message || !conversationId) {
      return res.status(400).json({ error: 'Message and conversationId are required' });
    }

    const conversation = await Conversation.findOne({ _id: conversationId, userId: req.userId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Get agent first to check functions and get settings
    const agent = agentId ? await Agent.findOne({ _id: agentId, userId: req.userId }) : null;
    const speechSettings = agent?.speechSettings || {};
    const openaiModel = speechSettings.openaiModel || 'gpt-4';
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

    // Add AI response to conversation
    conversation.messages.push({
      role: 'assistant',
      content: aiResponse
    });
    await conversation.save();
    
    // Update call history with latest messages and cost - find by conversation ID and user
    const callRecord = await CallHistory.findOne({ 
      conversationId: conversationId,
      userId: req.userId,
      status: 'active'
    });
    
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
        
        const audioFileId = await textToSpeech(aiResponse, {
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
        
        audioUrl = `/api/audio/${audioFileId}`;
      } catch (error) {
        console.error('Error generating audio for end_call:', error);
      }
      
      return res.json({
        text: aiResponse,
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
      
      const audioFileId = await textToSpeech(aiResponse, {
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
      audioUrl = `/api/audio/${audioFileId}`;
    } catch (ttsError) {
      console.error('Text-to-speech error:', ttsError);
      // Continue without audio if TTS fails
    }

    res.json({
      text: aiResponse,
      audioUrl: audioUrl,
      tokensUsed: tokensUsed
    });
  } catch (error) {
    console.error('Error in chat:', error);
    res.status(500).json({ error: error.message || 'Failed to process chat request' });
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
      cuttingAudioUrl = `/api/audio/${cuttingAudioFileId}`;
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
    const conversation = await Conversation.findOne({ _id: req.params.id, userId: req.userId });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    // Find call history by conversation ID and user
    const callRecord = await CallHistory.findOne({ 
      conversationId: req.params.id,
      userId: req.userId,
      status: 'active'
    });
    
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
          callRecord.audioUrl = `/api/audio/${mergedAudioFileId}`;
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

