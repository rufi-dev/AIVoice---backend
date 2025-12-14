import { OpenAI } from 'openai';
import { config } from '../config/index.js';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

/**
 * Analyze sentiment and emotion from transcribed text
 * This provides sentiment analysis that can approximate voice tone
 * @param {string} text - Transcribed text to analyze
 * @returns {Promise<Object>} - Sentiment analysis result
 */
export async function analyzeSentiment(text) {
  try {
    // Use OpenAI to analyze sentiment from text
    // While this doesn't capture audio tone directly, it can infer emotion from text
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Use cheaper model for sentiment analysis
      messages: [
        {
          role: 'system',
          content: 'You are a sentiment analysis expert. Analyze the emotional tone and sentiment of the given text. Respond with ONLY a JSON object in this exact format: {"sentiment": "positive|negative|neutral", "emotion": "happy|sad|angry|frustrated|excited|calm|confused|satisfied", "confidence": 0.0-1.0, "urgency": "low|medium|high"}. Do not include any other text.'
        },
        {
          role: 'user',
          content: text
        }
      ],
      temperature: 0.3,
      max_tokens: 100
    });

    const resultText = response.choices[0].message.content.trim();
    
    // Try to parse JSON response
    try {
      const sentiment = JSON.parse(resultText);
      return sentiment;
    } catch (e) {
      // Fallback if JSON parsing fails
      console.warn('Failed to parse sentiment JSON, using defaults');
      return {
        sentiment: 'neutral',
        emotion: 'calm',
        confidence: 0.5,
        urgency: 'low'
      };
    }
  } catch (error) {
    console.error('Error analyzing sentiment:', error);
    // Return neutral sentiment on error
    return {
      sentiment: 'neutral',
      emotion: 'calm',
      confidence: 0.5,
      urgency: 'low'
    };
  }
}

/**
 * Enhanced sentiment analysis that can be used to adjust AI responses
 * This helps the AI understand user's emotional state
 */
export async function getSentimentContext(text) {
  const sentiment = await analyzeSentiment(text);
  
  // Create context string for AI prompt
  const context = `User's emotional state: ${sentiment.emotion} (${sentiment.sentiment}), urgency: ${sentiment.urgency}. `;
  
  return {
    context,
    sentiment
  };
}
