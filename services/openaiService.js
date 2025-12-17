import { OpenAI } from 'openai';
import { config } from '../config/index.js';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

/**
 * Get AI response from OpenAI (non-streaming)
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Optional parameters (temperature, max_tokens, etc.)
 * @returns {Promise<Object>} - Response object with content and usage
 */
export async function getAIResponse(messages, options = {}) {
  const {
    temperature = 0.7,
    max_tokens = 500,
    model = 'gpt-4',
  } = options;

  const completion = await openai.chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens,
  });

  return {
    content: completion.choices[0].message.content,
    tokensUsed: completion.usage?.total_tokens || 0,
  };
}

/**
 * Get streaming AI response from OpenAI with optional function calling
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Optional parameters (temperature, max_tokens, tools, etc.)
 * @param {Function} onChunk - Callback function called with each chunk of text
 * @returns {Promise<Object>} - Response object with full content, usage, and function calls
 */
export async function getStreamingAIResponse(messages, options = {}, onChunk) {
  const {
    temperature = 0.7,
    max_tokens = 500,
    model = 'gpt-4',
    tools = null, // OpenAI function definitions
    tool_choice = 'auto', // 'auto', 'none', or specific function
    signal = undefined, // AbortSignal support for streaming cancellation
  } = options;

  let fullContent = '';
  let tokensUsed = 0;
  let functionCalls = []; // Track function calls from AI

  const requestBody = {
    model,
    messages,
    temperature,
    max_tokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  // Add tools if provided (for function calling)
  if (tools && tools.length > 0) {
    requestBody.tools = tools;
    requestBody.tool_choice = tool_choice;
  }

  // IMPORTANT: AbortSignal must be passed as request option (2nd arg),
  // not inside the JSON body (or OpenAI API will reject `signal`).
  const stream = await openai.chat.completions.create(
    requestBody,
    signal ? { signal } : undefined
  );

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      fullContent += content;
      if (onChunk) {
        onChunk(content);
      }
    }
    
    // Check for function calls in the delta
    const delta = chunk.choices[0]?.delta;
    if (delta?.tool_calls) {
      for (const toolCall of delta.tool_calls) {
        const index = toolCall.index || 0;
        if (!functionCalls[index]) {
          functionCalls[index] = {
            id: toolCall.id,
            type: toolCall.type,
            function: {
              name: '',
              arguments: ''
            }
          };
        }
        if (toolCall.function?.name) {
          functionCalls[index].function.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          functionCalls[index].function.arguments += toolCall.function.arguments;
        }
      }
    }
    
    // Usage is included in the final chunk when stream_options.include_usage is true
    if (chunk.usage) {
      tokensUsed = chunk.usage.total_tokens || 0;
      console.log('📊 Token usage:', {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
        total_tokens: chunk.usage.total_tokens
      });
    }
  }

  // If no usage was found in stream, estimate based on content length
  if (tokensUsed === 0 && fullContent) {
    // Rough estimation: ~4 characters per token
    const estimatedTokens = Math.ceil(fullContent.length / 4) + Math.ceil(JSON.stringify(messages).length / 4);
    tokensUsed = estimatedTokens;
    console.log('⚠️ No usage data in stream, estimated tokens:', estimatedTokens);
  }

  return {
    content: fullContent,
    tokensUsed: tokensUsed,
    functionCalls: functionCalls.filter(fc => fc && fc.function.name), // Return only valid function calls
  };
}

