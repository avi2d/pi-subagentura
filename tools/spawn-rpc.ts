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
   debugLog,
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
   const tmuxAvailable = await tmuxBridge.isTmuxAvailable();
   if (!tmuxAvailable) {
      throw new Error(
         'tmux is not installed. RPC mode requires tmux.\n' +
         'Install: macOS: brew install tmux | Ubuntu: sudo apt-get install tmux'
      );
   }

   const jobId = generateId();
   debugLog("info", "spawn_rpc_start", { jobId, taskLength: params.task?.length ?? 0 });

   const notifyMode = params.notifyOnComplete || "notify";

   try {
      await fs.promises.mkdir(SOCKET_DIR, { mode: SOCKET_DIR_MODE, recursive: true });
   } catch (err) {
      debugLog("error", "socket_dir_create_failed", { jobId, error: String(err) });
      throw err;
   }

   const correlationId = generateId();

   // Build entry script
   await new Promise<void>((resolve, reject) => {
      const build = spawn('npx', [
         'esbuild',
         'entry/subagent-rpc-client.ts',
         '--outfile=entry/subagent-rpc-client.cjs',
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

   const entryScriptPath = path.resolve(process.cwd(), 'entry/subagent-rpc-client.cjs');
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

   // Set up ready timeout BEFORE waiting for socket
   const readyTimeout = setTimeout(() => {
      debugLog("warn", "ready_timeout", { jobId });
      pendingReadyTimeouts.delete(jobId);
   }, 5000);
   pendingReadyTimeouts.set(jobId, readyTimeout);

   // Wait for socket to be ready
   const waitForSocket = async (sockPath: string, timeout = 5000): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
         try {
            await fs.promises.access(sockPath);
            return;
         } catch {
            await new Promise(r => setTimeout(r, 50));
         }
      }
      throw new Error(`Socket ${sockPath} not ready after ${timeout}ms`);
   };

   try {
      await waitForSocket(socketPath, 5000);
      await rpcRouter.connect(jobId, socketPath, () => {
         clearPendingReadyTimeout(jobId);
      });
   } catch (err) {
      debugLog("error", "connect_failed", { jobId, error: String(err) });
   }

   // Subscribe to notifications from subagent
   rpcRouter.subscribe('session.output', (notification) => {
      const p = notification.params as { jobId?: string; output?: string; isError?: boolean } | undefined;
      if (p?.jobId) {
         const job = jobRegistry.get(p.jobId);
         if (job) {
            job.liveStatus.output += p.output || '';
            jobRegistry.set(p.jobId, job);
         }
      }
   });

   rpcRouter.subscribe('session.done', (notification) => {
      const p = notification.params as { jobId?: string; output?: string; isError?: boolean } | undefined;
      if (p?.jobId) {
         const job = jobRegistry.get(p.jobId);
         if (job) {
            job.status = p.isError ? 'error' : 'done';
            job.liveStatus.output = p.output || '';
            job.promise = Promise.resolve({
               output: p.output || '',
               usage: job.liveStatus.usage,
               model: undefined,
               isError: p.isError || false
            });
            jobRegistry.set(p.jobId, job);
         }
      }
   });

   rpcRouter.startHeartbeat(jobId);

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
