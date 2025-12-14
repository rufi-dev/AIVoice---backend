import Voice from '../models/Voice.js';

export const getAllVoices = async (req, res) => {
  try {
    // Get user's custom voices
    const customVoices = await Voice.find({ userId: req.userId }).sort({ createdAt: -1 });
    
    // Map _id to id for frontend compatibility
    const voicesWithId = customVoices.map(voice => ({
      ...voice.toObject(),
      id: voice._id.toString()
    }));
    
    res.json(voicesWithId);
  } catch (error) {
    console.error('Error fetching voices:', error);
    res.status(500).json({ error: 'Failed to fetch voices' });
  }
};

export const getVoice = async (req, res) => {
  try {
    const voice = await Voice.findOne({ _id: req.params.id, userId: req.userId });
    if (!voice) {
      return res.status(404).json({ error: 'Voice not found' });
    }
    
    const voiceWithId = {
      ...voice.toObject(),
      id: voice._id.toString()
    };
    res.json(voiceWithId);
  } catch (error) {
    console.error('Error fetching voice:', error);
    res.status(500).json({ error: 'Failed to fetch voice' });
  }
};

export const createVoice = async (req, res) => {
  try {
    const { name, provider, voiceId, description, traits, isCustom } = req.body;
    
    if (!name || !voiceId) {
      return res.status(400).json({ error: 'Voice name and ID are required' });
    }

    const voice = new Voice({
      userId: req.userId,
      name: name.trim(),
      provider: provider || 'elevenlabs',
      voiceId: voiceId.trim(),
      description: description || '',
      traits: traits || {},
      isCustom: isCustom !== undefined ? isCustom : true
    });

    await voice.save();
    
    const voiceWithId = {
      ...voice.toObject(),
      id: voice._id.toString()
    };
    res.status(201).json(voiceWithId);
  } catch (error) {
    console.error('Error creating voice:', error);
    res.status(500).json({ error: 'Failed to create voice', details: error.message });
  }
};

export const updateVoice = async (req, res) => {
  try {
    const { name, description, traits } = req.body;
    
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description;
    if (traits !== undefined) updateData.traits = traits;

    const voice = await Voice.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      updateData,
      { new: true, runValidators: true }
    );

    if (!voice) {
      return res.status(404).json({ error: 'Voice not found' });
    }

    const voiceWithId = {
      ...voice.toObject(),
      id: voice._id.toString()
    };
    res.json(voiceWithId);
  } catch (error) {
    console.error('Error updating voice:', error);
    res.status(500).json({ error: 'Failed to update voice' });
  }
};

export const deleteVoice = async (req, res) => {
  try {
    const voice = await Voice.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!voice) {
      return res.status(404).json({ error: 'Voice not found' });
    }
    res.json({ message: 'Voice deleted' });
  } catch (error) {
    console.error('Error deleting voice:', error);
    res.status(500).json({ error: 'Failed to delete voice' });
  }
};

// Get predefined ElevenLabs voices
export const getPredefinedVoices = async (req, res) => {
  try {
    // Predefined ElevenLabs voices
    const predefinedVoices = [
      {
        id: 'CwhRBWXzGAHq8TQ4Fs17',
        voiceId: 'CwhRBWXzGAHq8TQ4Fs17',
        name: 'Roger',
        provider: 'elevenlabs',
        description: 'Roger',
        traits: {
          gender: 'Male',
          accent: 'American',
          age: 'Middle Aged',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'EXAVITQu4vr4xnSDxMaL',
        voiceId: 'EXAVITQu4vr4xnSDxMaL',
        name: 'Sarah',
        provider: 'elevenlabs',
        description: 'Sarah',
        traits: {
          gender: 'Female',
          accent: 'American',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'FGY2WhTYpPnrIDTdsKH5',
        voiceId: 'FGY2WhTYpPnrIDTdsKH5',
        name: 'Laura',
        provider: 'elevenlabs',
        description: 'Laura',
        traits: {
          gender: 'Female',
          accent: 'American',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'IKne3meq5aSn9XLyUdCD',
        voiceId: 'IKne3meq5aSn9XLyUdCD',
        name: 'Charlie',
        provider: 'elevenlabs',
        description: 'Charlie',
        traits: {
          gender: 'Male',
          accent: 'American',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'JBFqnCBsd6RMkjVDRZzb',
        voiceId: 'JBFqnCBsd6RMkjVDRZzb',
        name: 'George',
        provider: 'elevenlabs',
        description: 'George',
        traits: {
          gender: 'Male',
          accent: 'American',
          age: 'Middle Aged',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'N2lVS1w4EtoT3dr4eOWO',
        voiceId: 'N2lVS1w4EtoT3dr4eOWO',
        name: 'Callum',
        provider: 'elevenlabs',
        description: 'Callum',
        traits: {
          gender: 'Male',
          accent: 'British',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'SAz9YHcvj6GT2YYXdXww',
        voiceId: 'SAz9YHcvj6GT2YYXdXww',
        name: 'River',
        provider: 'elevenlabs',
        description: 'River',
        traits: {
          gender: 'Female',
          accent: 'American',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'SOYHLrjzK2X1ezoPC6cr',
        voiceId: 'SOYHLrjzK2X1ezoPC6cr',
        name: 'Harry',
        provider: 'elevenlabs',
        description: 'Harry',
        traits: {
          gender: 'Male',
          accent: 'British',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'TX3LPaxmHKxFdv7VOQHJ',
        voiceId: 'TX3LPaxmHKxFdv7VOQHJ',
        name: 'Liam',
        provider: 'elevenlabs',
        description: 'Liam',
        traits: {
          gender: 'Male',
          accent: 'American',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'Xb7hH8MSUJpSbSDYk0k2',
        voiceId: 'Xb7hH8MSUJpSbSDYk0k2',
        name: 'Alice',
        provider: 'elevenlabs',
        description: 'Alice',
        traits: {
          gender: 'Female',
          accent: 'American',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'XrExE9yKIg1WjnnlVkGX',
        voiceId: 'XrExE9yKIg1WjnnlVkGX',
        name: 'Matilda',
        provider: 'elevenlabs',
        description: 'Matilda',
        traits: {
          gender: 'Female',
          accent: 'American',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      },
      {
        id: 'bIHbv24MWmeRgasZH58o',
        voiceId: 'bIHbv24MWmeRgasZH58o',
        name: 'Will',
        provider: 'elevenlabs',
        description: 'Will',
        traits: {
          gender: 'Male',
          accent: 'American',
          age: 'Young',
          language: 'English'
        },
        isCustom: false
      }
    ];
    
    res.json(predefinedVoices);
  } catch (error) {
    console.error('Error fetching predefined voices:', error);
    res.status(500).json({ error: 'Failed to fetch predefined voices' });
  }
};

