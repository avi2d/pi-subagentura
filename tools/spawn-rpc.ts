import { Type } from 'typebox';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { 
  SOCKET_DIR, 
  SOCKET_DIR_MODE,
  RpcServiceEntry 
} from '../rpc/types.js';
import { rpcRegistry } from '../rpc/registry.js';
import { rpcRouter } from '../rpc/router.js';
import { tmuxBridge } from '../rpc/tmux-bridge.js';

// Track pending ready timeouts to prevent memory leaks
const pendingReadyTimeouts = new Map<string, NodeJS.Timeout>();

const generateId = () => Math.random().toString(36).substring(2) + Date.now().toString(36);

export const SpawnRpcParams = Type.Object({
  task: Type.String({ description: "Task to delegate to the sub-agent" }),
  persona: Type.Optional(Type.String({ description: "Optional system prompt" })),
  model: Type.Optional(Type.String({ description: "Model override" })),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
  expose: Type.Optional(Type.Array(Type.String(), { description: "Tools to expose" })),
  timeout: Type.Optional(Type.Number({ description: "Max execution time in ms" }))
});

// Clear any pending ready timeout for a job
export function clearPendingReadyTimeout(jobId: string): void {
  const timeout = pendingReadyTimeouts.get(jobId);
  if (timeout) {
    clearTimeout(timeout);
    pendingReadyTimeouts.delete(jobId);
  }
}

export async function spawnRpcSubagent(params: {
  task: string;
  persona?: string;
  model?: string;
  cwd?: string;
  expose?: string[];
  timeout?: number;
}): Promise<{
  jobId: string;
  socketPath: string;
  exposedTools: string[];
  correlationId: string;
  message: string;
}> {
  // 1. Validate tmux availability
  const tmuxAvailable = await tmuxBridge.isTmuxAvailable();
  if (!tmuxAvailable) {
    throw new Error(
      'tmux is not installed. RPC mode requires tmux.\n' +
      'Install: macOS: brew install tmux | Ubuntu: sudo apt-get install tmux'
    );
  }
  
  // 2. Generate jobId
  const jobId = generateId();
  
  // 3. Ensure socket directory exists atomically with 0700 permissions
  try {
    await fs.promises.mkdir(SOCKET_DIR, { mode: SOCKET_DIR_MODE, recursive: true });
  } catch (err) {
    console.error(`[spawn-rpc] Failed to create socket directory ${SOCKET_DIR}:`, err);
    throw err;
  }
  // 4. Generate correlationId
  const correlationId = generateId();
  
  // 5. Build entry script
  await new Promise<void>((resolve, reject) => {
    const build = spawn('npx', [
      'esbuild',
      'entry/subagent-rpc-client.ts',
      '--outfile=entry/subagent-rpc-client.js',
      '--platform=node',
      '--target=node18',
      '--format=cjs'
    ], {
      cwd: process.cwd(),
      stdio: 'inherit'
    });
    build.on('close', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
  });
  
  // 6. Create tmux session
  const entryScriptPath = path.resolve(process.cwd(), 'entry/subagent-rpc-client.js');
  const socketPath = path.join(SOCKET_DIR, `${jobId}.sock`);
  
  const { sessionId, processId } = await tmuxBridge.createSession({
    jobId,
    socketDir: SOCKET_DIR,
    entryScriptPath,
    cwd: params.cwd,
    timeout: params.timeout,
    correlationId
  });
  
  // 7. Register service
  const exposedTools = params.expose || ['agent.prompt', 'agent.status', 'tools.list', 'tools.execute'];
  
  const entry: RpcServiceEntry = {
    jobId,
    socketPath,
    exposedTools,
    status: 'running',
    startedAt: Date.now(),
    correlationId,
  };
  
  rpcRegistry.register(entry);
  
  // 8. Connect explicitly with ready notification handler
  // This ensures we capture the session.ready even if it arrives before heartbeat starts
  await rpcRouter.connect(jobId, socketPath, () => {
    clearPendingReadyTimeout(jobId);
  });
  
  // 9. Start heartbeat monitoring
  rpcRouter.startHeartbeat(jobId);
  
  // 10. Set ready timeout - will be cleared by the onReady callback above
  const readyTimeout = setTimeout(() => {
    console.warn(`Subagent ${jobId} did not send ready notification within 5s`);
    pendingReadyTimeouts.delete(jobId);
  }, 5000);
  pendingReadyTimeouts.set(jobId, readyTimeout);
  
  return {
    jobId,
    socketPath,
    exposedTools,
    correlationId,
    message: `RPC subagent ${jobId} started in tmux session ${sessionId}`
  };
}
