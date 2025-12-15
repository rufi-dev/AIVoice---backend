import Agent from '../models/Agent.js';
import crypto from 'crypto';

/**
 * Get agent by shareable token (public endpoint, no authentication required)
 */
export const getAgentByToken = async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const agent = await Agent.findOne({ 
      shareableToken: token,
      isPublic: true // Only return if agent is marked as public
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found or not publicly accessible' });
    }

    // Return agent data (excluding sensitive info like userId)
    const agentData = {
      id: agent._id.toString(),
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      knowledgeBaseId: agent.knowledgeBaseId,
      speechSettings: agent.speechSettings,
      callSettings: agent.callSettings,
      functions: agent.functions,
      shareableToken: agent.shareableToken,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt
    };

    res.json(agentData);
  } catch (error) {
    console.error('Error fetching agent by token:', error);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
};

/**
 * Generate a unique shareable token for an agent
 */
export function generateShareableToken() {
  // Generate a random 32-character token
  return crypto.randomBytes(16).toString('hex');
}
