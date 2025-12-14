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
 * Get streaming AI response from OpenAI
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Optional parameters (temperature, max_tokens, etc.)
 * @param {Function} onChunk - Callback function called with each chunk of text
 * @returns {Promise<Object>} - Response object with full content and usage
 */
export async function getStreamingAIResponse(messages, options = {}, onChunk) {
  const {
    temperature = 0.7,
    max_tokens = 500,
    model = 'gpt-4',
  } = options;

  let fullContent = '';
  let tokensUsed = 0;

  const stream = await openai.chat.completions.create({
    model,
    messages,
    temperature,
    max_tokens,
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      fullContent += content;
      if (onChunk) {
        onChunk(content);
      }
    }
    if (chunk.usage) {
      tokensUsed = chunk.usage.total_tokens || 0;
    }
  }

  return {
    content: fullContent,
    tokensUsed: tokensUsed,
  };
}

