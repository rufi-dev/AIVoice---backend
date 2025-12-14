import Conversation from '../models/Conversation.js';
import CallHistory from '../models/CallHistory.js';
import Agent from '../models/Agent.js';
import KnowledgeBase from '../models/KnowledgeBase.js';
import { buildSystemPrompt } from '../services/promptService.js';
import { getAIResponse, getStreamingAIResponse } from '../services/openaiService.js';
import { textToSpeech } from '../services/elevenLabsService.js';
import { config } from '../config/index.js';

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
            similarity_boost: speechSettings.similarityBoost ?? 0.75
          });
          // Return URL to access the audio from GridFS
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

    // Add user message
    conversation.messages.push({
      role: 'user',
      content: message
    });

    // Convert messages to format expected by OpenAI
    const messagesForOpenAI = conversation.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    // Get agent speech settings to use the correct OpenAI model and language
    const agent = agentId ? await Agent.findOne({ _id: agentId, userId: req.userId }) : null;
    const speechSettings = agent?.speechSettings || {};
    const openaiModel = speechSettings.openaiModel || 'gpt-4';
    const language = speechSettings.language || 'en';
    
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

    // Stream the response from OpenAI
    const { content: aiResponse, tokensUsed } = await getStreamingAIResponse(
      messagesForOpenAI,
      {
        model: openaiModel,
        temperature: 0.7,
        max_tokens: 500
      },
      (chunk) => {
        // Accumulate chunks for full response
        fullResponse += chunk;
        accumulatedText += chunk;
      }
    );

    // Add AI response to conversation
    conversation.messages.push({
      role: 'assistant',
      content: aiResponse
    });
    await conversation.save();

    // Update call history with latest messages - find by conversation ID and user
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
      // Estimate cost (rough calculation - adjust based on your pricing)
      callRecord.cost += (tokensUsed / 1000) * 0.03; // Approximate cost
      await callRecord.save();
      console.log(`📝 Call history updated for ${callRecord._id}, total messages: ${callRecord.messages.length}`);
    } else {
      console.log(`⚠️ Warning: Call record not found for conversation ${conversationId}`);
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
        similarity_boost: speechSettings.similarityBoost ?? 0.75
      });
      // Return URL to access the audio from GridFS
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
        similarity_boost: speechSettings.similarityBoost ?? 0.75
      });
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

