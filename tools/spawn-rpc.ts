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
import {
   jobRegistry,
   type JobState,
   type NotifyOnComplete
} from '../helpers.js';

// Track pending ready timeouts to prevent memory leaks
const pendingReadyTimeouts = new Map<string, NodeJS.Timeout>();

const generateId = () => Math.random().toString(36).substring(2) + Date.now().toString(36);

export const SpawnRpcParams = Type.Object({
   task: Type.String({ description: "Task to delegate to the sub-agent" }),
   persona: Type.Optional(Type.String({ description: "Optional system prompt" })),
   model: Type.Optional(Type.String({ description: "Model override" })),
   cwd: Type.Optional(Type.String({ description: "Working directory override" })),
   expose: Type.Optional(Type.Array(Type.String(), { description: "Tools to expose" })),
   timeout: Type.Optional(Type.Number({ description: "Max execution time in ms" })),
   notifyOnComplete: Type.Optional(Type.Union([
      Type.Literal("notify"),
      Type.Literal("inject")
   ], { description: "How to notify on completion" }))
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
   notifyOnComplete?: NotifyOnComplete;
}): Promise<{
   jobId: string;
   socketPath: string;
   exposedTools: string[];
   correlationId: string;
   message: string;
   sessionId: string;
   attachCommand: string;
   weztermCommand: string;
   zellijCommand: string;
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
   console.error(`[spawn-rpc] Starting with task: ${params.task?.slice(0, 50)}...`);
   const jobId = generateId();
   // Default to "notify" mode for RPC subagents so notifications work by default
   const notifyMode = params.notifyOnComplete || "notify";

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
      task: params.task,
      persona: params.persona
   });
   console.error(`[spawn-rpc] Tmux session created: ${sessionId}, socket: ${socketPath}`);

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
   try {
      await rpcRouter.connect(jobId, socketPath, () => {
         clearPendingReadyTimeout(jobId);
      });
      console.error(`[spawn-rpc] Connected to RPC socket`);
   } catch (err) {
      console.error(`[spawn-rpc] Failed to connect to RPC socket: ${(err as Error).message}`);
   }
   // 9. Start heartbeat monitoring
   rpcRouter.startHeartbeat(jobId);

   // 10. Set ready timeout - will be cleared by the onReady callback above
   const readyTimeout = setTimeout(() => {
      console.warn(`Subagent ${jobId} did not send ready notification within 5s`);
      pendingReadyTimeouts.delete(jobId);
   }, 5000);
   pendingReadyTimeouts.set(jobId, readyTimeout);

   // Register in jobRegistry for notification delivery
   const jobState: JobState = {
      id: jobId,
      status: 'running',
      liveStatus: {
         turn: 0,
         output: '',
         usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
      },
      startedAt: Date.now(),
      promise: Promise.resolve({
         output: '',
         usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
         model: undefined,
         isError: false
      }),
      notifyOnComplete: notifyMode,
      notificationDelivered: false,
      maxAge: undefined
   };
   jobRegistry.set(jobId, jobState);

   const attachCommand = `tmux attach -t "${sessionId}"`;
   const weztermCommand = `wezterm cli split-pane --domain-id=TMUX -- tmux attach -t "${sessionId}"`;
   const zellijCommand = `zellij attach "${sessionId}"`;

   return {
      jobId,
      socketPath,
      exposedTools,
      correlationId,
      sessionId,
      attachCommand,
      weztermCommand,
      zellijCommand,
      message: `RPC subagent ${jobId} started in tmux session ${sessionId}`
   };
}
