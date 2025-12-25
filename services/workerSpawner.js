import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Track running workers by room name
const activeWorkers = new Map();

/**
 * WORKER SPAWNER SERVICE
 * 
 * WHY THIS IS NEEDED:
 * - Retell AI automatically starts workers when calls begin
 * - Users shouldn't have to manually run Python scripts
 * - Workers should be managed automatically (start on call start, stop on call end)
 * 
 * HOW IT WORKS:
 * - When a call starts, spawn the Python worker with the correct room name
 * - Track workers by room name to prevent duplicates
 * - Clean up workers when calls end
 */

/**
 * Get the path to the Python worker script
 */
function getWorkerScriptPath() {
  // Worker is in agent-worker/voice_agent.py relative to backend
  const backendDir = path.resolve(__dirname, '..');
  const projectRoot = path.resolve(backendDir, '..');
  return path.join(projectRoot, 'agent-worker', 'voice_agent.py');
}

/**
 * Get the path to the agent-worker directory
 */
function getAgentWorkerDir() {
  const backendDir = path.resolve(__dirname, '..');
  const projectRoot = path.resolve(backendDir, '..');
  return path.join(projectRoot, 'agent-worker');
}

/**
 * Find Python executable, checking for virtual environment first
 * @returns {string} Python command to use
 */
function findPythonExecutable() {
  const agentWorkerDir = getAgentWorkerDir();
  const backendDir = path.resolve(__dirname, '..');
  const projectRoot = path.resolve(backendDir, '..');
  
  // Check for virtual environment in multiple locations:
  // 1. Project root (.venv, venv, env) - MOST COMMON
  // 2. agent-worker directory
  const venvPaths = [
    // Project root (most common location - user has .venv here)
    path.join(projectRoot, '.venv', 'Scripts', 'python.exe'), // Windows
    path.join(projectRoot, '.venv', 'bin', 'python'), // Linux/Mac
    path.join(projectRoot, 'venv', 'Scripts', 'python.exe'), // Windows
    path.join(projectRoot, 'venv', 'bin', 'python'), // Linux/Mac
    path.join(projectRoot, 'env', 'Scripts', 'python.exe'), // Windows
    path.join(projectRoot, 'env', 'bin', 'python'), // Linux/Mac
    // agent-worker directory
    path.join(agentWorkerDir, 'venv', 'Scripts', 'python.exe'), // Windows
    path.join(agentWorkerDir, 'venv', 'bin', 'python'), // Linux/Mac
    path.join(agentWorkerDir, '.venv', 'Scripts', 'python.exe'), // Windows alt
    path.join(agentWorkerDir, '.venv', 'bin', 'python'), // Linux/Mac alt
    path.join(agentWorkerDir, 'env', 'Scripts', 'python.exe'), // Windows alt2
    path.join(agentWorkerDir, 'env', 'bin', 'python'), // Linux/Mac alt2
  ];

  for (const venvPath of venvPaths) {
    if (fs.existsSync(venvPath)) {
      console.log(`[worker] ✅ Found virtual environment: ${venvPath}`);
      return venvPath;
    }
  }

  // Fall back to system Python
  console.log(`[worker] ⚠️  No virtual environment found, using system Python`);
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Spawn a Python worker for a specific room
 * @param {string} roomName - LiveKit room name
 * @param {object} options - Worker options
 * @returns {Promise<object>} Worker process info
 */
export async function spawnWorker(roomName, options = {}) {
  if (!roomName) {
    throw new Error('roomName is required');
  }

  // If worker already exists for this room, return existing
  if (activeWorkers.has(roomName)) {
    const existing = activeWorkers.get(roomName);
    if (existing.process && !existing.process.killed) {
      console.log(`[worker] Worker already running for room: ${roomName}`);
      return existing;
    }
    // Clean up stale entry
    activeWorkers.delete(roomName);
  }

  const workerScript = getWorkerScriptPath();
  const livekitUrl = process.env.LIVEKIT_URL;
  const identity = options.identity || 'agent-worker';

  if (!livekitUrl) {
    throw new Error('LIVEKIT_URL environment variable is required');
  }

  // Build Python command arguments
  const args = [
    workerScript,
    '--room', roomName,
    '--url', livekitUrl,
    '--identity', identity
  ];

  // Add optional arguments
  if (options.vad) {
    args.push('--vad', options.vad);
  }

  // Find Python executable (prefer virtual environment)
  const pythonCmd = findPythonExecutable();
  
  console.log(`[worker] Spawning worker for room: ${roomName}`);
  console.log(`[worker] Python executable: ${pythonCmd}`);
  console.log(`[worker] Command: ${pythonCmd} ${args.join(' ')}`);
  console.log(`[worker] Working directory: ${path.dirname(workerScript)}`);
  
  // Spawn Python process
  const workerProcess = spawn(pythonCmd, args, {
    cwd: path.dirname(workerScript),
    env: {
      ...process.env,
      // Ensure Python worker has access to required env vars
      LIVEKIT_URL: livekitUrl,
      LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
      ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY,
      // Pass through any other relevant env vars
      AGENT_VAD: options.vad || process.env.AGENT_VAD || 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe'] // Ignore stdin, pipe stdout/stderr
  });

  const workerInfo = {
    roomName,
    process: workerProcess,
    startedAt: Date.now(),
    identity
  };

  // Handle worker output
  workerProcess.stdout.on('data', (data) => {
    console.log(`[worker:${roomName}] ${data.toString().trim()}`);
  });

  workerProcess.stderr.on('data', (data) => {
    console.error(`[worker:${roomName}] ${data.toString().trim()}`);
  });

  // Handle worker exit
  workerProcess.on('exit', (code, signal) => {
    console.log(`[worker:${roomName}] Process exited with code ${code}, signal ${signal}`);
    activeWorkers.delete(roomName);
  });

  workerProcess.on('error', (error) => {
    console.error(`[worker:${roomName}] Process error:`, error);
    if (error.code === 'ENOENT') {
      console.error(`[worker:${roomName}] Python not found! Make sure Python is installed and in your PATH.`);
      console.error(`[worker:${roomName}] Tried command: ${pythonCmd}`);
      console.error(`[worker:${roomName}] You can still manually run: ${pythonCmd} ${args.join(' ')}`);
    }
    activeWorkers.delete(roomName);
    throw error; // Re-throw so caller knows spawn failed
  });

  // Check for module import errors in stderr (but only show once per worker)
  let stderrBuffer = '';
  let dependencyErrorShown = false;
  workerProcess.stderr.on('data', (data) => {
    const stderrText = data.toString();
    stderrBuffer += stderrText;
    
    // Only check for import errors if we haven't shown the message yet
    if (!dependencyErrorShown && (stderrBuffer.includes('ModuleNotFoundError') || stderrBuffer.includes('ImportError'))) {
      // Only show if it's actually a missing dependency (not other errors)
      if (stderrBuffer.includes('livekit') || stderrBuffer.includes('No module named')) {
        dependencyErrorShown = true;
        console.error(`[worker:${roomName}] ⚠️  Missing Python dependencies detected!`);
        console.error(`[worker:${roomName}] Using Python: ${pythonCmd}`);
        console.error(`[worker:${roomName}] Install dependencies by running:`);
        const agentWorkerDir = getAgentWorkerDir();
        console.error(`[worker:${roomName}]   cd ${agentWorkerDir}`);
        console.error(`[worker:${roomName}]   ${pythonCmd} -m pip install -r requirements.txt`);
        console.error(`[worker:${roomName}] Or if using venv, activate it first:`);
        console.error(`[worker:${roomName}]   .venv\\Scripts\\activate  (Windows)`);
        console.error(`[worker:${roomName}]   source .venv/bin/activate  (Linux/Mac)`);
        console.error(`[worker:${roomName}]   pip install -r requirements.txt`);
      }
    }
  });

  // Store worker info
  activeWorkers.set(roomName, workerInfo);

  return workerInfo;
}

/**
 * Stop a worker for a specific room
 * @param {string} roomName - LiveKit room name
 * @returns {Promise<boolean>} True if worker was stopped, false if not found
 */
export async function stopWorker(roomName) {
  if (!roomName) return false;

  const workerInfo = activeWorkers.get(roomName);
  if (!workerInfo || !workerInfo.process) {
    return false;
  }

  console.log(`[worker] Stopping worker for room: ${roomName}`);
  
  try {
    // Try graceful shutdown first (SIGTERM)
    workerInfo.process.kill('SIGTERM');
    
    // Wait a bit for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // If still running, force kill
    if (!workerInfo.process.killed) {
      workerInfo.process.kill('SIGKILL');
    }
    
    activeWorkers.delete(roomName);
    return true;
  } catch (error) {
    console.error(`[worker] Error stopping worker for room ${roomName}:`, error);
    activeWorkers.delete(roomName);
    return false;
  }
}

/**
 * Get all active workers
 * @returns {Array} Array of worker info objects
 */
export function getActiveWorkers() {
  return Array.from(activeWorkers.values()).map(w => ({
    roomName: w.roomName,
    startedAt: w.startedAt,
    identity: w.identity,
    isRunning: w.process && !w.process.killed
  }));
}

/**
 * Stop all active workers (cleanup on server shutdown)
 */
export async function stopAllWorkers() {
  console.log(`[worker] Stopping all workers (${activeWorkers.size} active)`);
  const promises = Array.from(activeWorkers.keys()).map(roomName => stopWorker(roomName));
  await Promise.all(promises);
}
