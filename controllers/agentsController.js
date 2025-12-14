import Agent from '../models/Agent.js';

export const getAllAgents = async (req, res) => {
  try {
    // Only get agents for the authenticated user
    const agents = await Agent.find({ userId: req.userId }).sort({ createdAt: -1 });
    // Map _id to id and convert ObjectId fields to strings for frontend compatibility
    const agentsWithId = agents.map(agent => {
      const agentObj = agent.toObject();
      return {
        ...agentObj,
        id: agent._id.toString(),
        knowledgeBaseId: agentObj.knowledgeBaseId ? agentObj.knowledgeBaseId.toString() : null
      };
    });
    res.json(agentsWithId);
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
};

export const getAgent = async (req, res) => {
  try {
    const agent = await Agent.findOne({ _id: req.params.id, userId: req.userId });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    // Map _id to id and convert ObjectId fields to strings for frontend compatibility
    const agentObj = agent.toObject();
    const agentWithId = {
      ...agentObj,
      id: agent._id.toString(),
      knowledgeBaseId: agentObj.knowledgeBaseId ? agentObj.knowledgeBaseId.toString() : null
    };
    res.json(agentWithId);
  } catch (error) {
    console.error('Error fetching agent:', error);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
};

export const createAgent = async (req, res) => {
  try {
    const { name, systemPrompt } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Agent name is required' });
    }

    const agent = new Agent({
      userId: req.userId,
      name: name.trim(),
      systemPrompt: systemPrompt || ''
    });

    await agent.save();
    console.log(`Agent created: ${agent._id} - ${agent.name}`);
    // Map _id to id and convert ObjectId fields to strings for frontend compatibility
    const agentObj = agent.toObject();
    const agentWithId = {
      ...agentObj,
      id: agent._id.toString(),
      knowledgeBaseId: agentObj.knowledgeBaseId ? agentObj.knowledgeBaseId.toString() : null
    };
    res.status(201).json(agentWithId);
  } catch (error) {
    console.error('Error creating agent:', error);
    res.status(500).json({ error: 'Failed to create agent', details: error.message });
  }
};

export const updateAgent = async (req, res) => {
  try {
    const { systemPrompt, knowledgeBaseId, speechSettings, callSettings } = req.body;
    
    console.log('💾 Updating agent with speechSettings:', {
      voiceId: speechSettings?.voiceId,
      voiceName: speechSettings?.voiceName,
      hasSpeechSettings: !!speechSettings
    });
    
    const updateData = {};
    if (systemPrompt !== undefined) updateData.systemPrompt = systemPrompt;
    if (knowledgeBaseId !== undefined) {
      // Convert empty string to null, otherwise keep the value
      updateData.knowledgeBaseId = knowledgeBaseId && knowledgeBaseId.trim() !== '' ? knowledgeBaseId : null;
    }
    if (speechSettings !== undefined) {
      // Ensure voiceId is always included if speechSettings is provided
      updateData.speechSettings = {
        ...speechSettings,
        voiceId: speechSettings.voiceId || '21m00Tcm4TlvDq8ikWAM', // Ensure voiceId is never empty
      };
      console.log('💾 Saving speechSettings with voiceId:', updateData.speechSettings.voiceId);
    }
    if (callSettings !== undefined) updateData.callSettings = callSettings;

    const agent = await Agent.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      updateData,
      { new: true, runValidators: true }
    );

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Verify the voiceId was saved correctly
    console.log('✅ Agent updated. Saved voiceId:', agent.speechSettings?.voiceId);
    console.log('✅ Full speechSettings:', JSON.stringify(agent.speechSettings, null, 2));

    // Map _id to id and convert ObjectId fields to strings for frontend compatibility
    const agentObj = agent.toObject();
    const agentWithId = {
      ...agentObj,
      id: agent._id.toString(),
      knowledgeBaseId: agentObj.knowledgeBaseId ? agentObj.knowledgeBaseId.toString() : null
    };
    res.json(agentWithId);
  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({ error: 'Failed to update agent' });
  }
};

export const deleteAgent = async (req, res) => {
  try {
    const agent = await Agent.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json({ message: 'Agent deleted' });
  } catch (error) {
    console.error('Error deleting agent:', error);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
};

