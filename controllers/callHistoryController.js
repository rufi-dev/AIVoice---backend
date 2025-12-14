import CallHistory from '../models/CallHistory.js';

/**
 * Get all call history
 */
export const getAllCallHistory = async (req, res) => {
  try {
    // Only get call history for the authenticated user
    const calls = await CallHistory.find({ userId: req.userId })
      .sort({ startTime: -1 })
      .populate('agentId', 'name');
    // Map _id to id for frontend compatibility
    const callsWithId = calls.map(call => ({
      ...call.toObject(),
      id: call._id.toString()
    }));
    res.json(callsWithId);
  } catch (error) {
    console.error('Error fetching call history:', error);
    res.status(500).json({ error: 'Failed to fetch call history' });
  }
};

/**
 * Get single call details
 */
export const getCallDetails = async (req, res) => {
  try {
    const call = await CallHistory.findOne({ _id: req.params.id, userId: req.userId })
      .populate('agentId', 'name');
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    // Map _id to id for frontend compatibility
    const callWithId = {
      ...call.toObject(),
      id: call._id.toString()
    };
    res.json(callWithId);
  } catch (error) {
    console.error('Error fetching call details:', error);
    res.status(500).json({ error: 'Failed to fetch call details' });
  }
};

/**
 * Delete call history
 */
export const deleteCallHistory = async (req, res) => {
  try {
    const call = await CallHistory.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }
    res.json({ message: 'Call deleted' });
  } catch (error) {
    console.error('Error deleting call history:', error);
    res.status(500).json({ error: 'Failed to delete call history' });
  }
};

