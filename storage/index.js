// In-memory storage for agents, knowledge bases, conversations, and call history
// In production, replace with a database (MongoDB, PostgreSQL, etc.)

export const agents = new Map();
export const knowledgeBases = new Map();
export const conversations = new Map();
export const callHistory = new Map();

