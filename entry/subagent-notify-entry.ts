/**
 * subagent-notify-entry: Entry script for tmux-launched subagents with notification.
 * 
 * This script:
 * 1. Connects to parent's Unix socket
 * 2. Accepts RPC calls
 * 3. Executes delegated tasks
 * 4. Sends session.output notification when done
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Parse CLI arguments
function parseArgs(): { socket: string; jobId: string } {
   const args = process.argv.slice(2);
   let socket = '';
   let jobId = '';

   for (const arg of args) {
      if (arg.startsWith('--socket=')) {
         socket = arg.substring('--socket='.length);
      } else if (arg.startsWith('--jobId=')) {
         jobId = arg.substring('--jobId='.length);
      }
   }

   if (!socket || !jobId) {
      console.error('Usage: node subagent-notify-entry.js --socket=<path> --jobId=<id> [--task=<base64>]');
      process.exit(1);
   }

   return { socket, jobId };
}

// Parse task from environment or CLI
interface TaskConfig {
   task: string;
   persona?: string;
   model?: string;
   cwd?: string;
   timeout?: number;
   notifyOnComplete?: 'inject' | 'notify';
   jobId: string;
   correlationId: string;
}

function parseTaskConfig(): TaskConfig | null {
   // Try environment variable first
   const envTask = process.env.PI_SUBAGENT_TASK;
   if (envTask) {
      try {
         return JSON.parse(Buffer.from(envTask, 'base64').toString('utf8'));
      } catch {
         // Fall through to CLI parsing
      }
   }

   // Try CLI argument
   for (const arg of process.argv) {
      if (arg.startsWith('--task=')) {
         try {
            return JSON.parse(Buffer.from(arg.substring('--task='.length), 'base64').toString('utf8'));
         } catch {
            console.error('[subagent-notify] Failed to parse task from CLI');
            return null;
         }
      }
   }

   return null;
}

// Logging helper
function log(level: string, message: string, data?: Record<string, unknown>): void {
   const entry = {
      timestamp: Date.now(),
      level,
      event: message,
      jobId: currentJobId,
      ...data
   };
   console.error(JSON.stringify(entry));
}

// Global state
let currentJobId = '';
let currentTask: TaskConfig | null = null;

// RPC Client that connects to parent
class RpcClient {
   private socket: net.Socket | null = null;
   private socketPath: string;
   private jobId: string;
   private pendingRequests: Map<string | number, {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
   }> = new Map();
   private handlers: Map<string, (params?: Record<string, unknown>) => Promise<unknown>> = new Map();
   private buffer = '';
   private connected = false;

   constructor(socketPath: string, jobId: string) {
      this.socketPath = socketPath;
      this.jobId = jobId;
   }

   async connect(): Promise<void> {
      return new Promise((resolve, reject) => {
         this.socket = net.createConnection(this.socketPath, () => {
            this.connected = true;
            log('info', 'Connected to parent socket', { socketPath: this.socketPath });
            resolve();
         });

         this.socket.on('data', (data: Buffer) => {
            this.buffer += data.toString();
            const messages = this.buffer.split('\n');
            this.buffer = messages.pop() || '';

            for (const msg of messages) {
               if (msg.trim()) {
                  try {
                     const parsed = JSON.parse(msg);
                     this.handleMessage(parsed);
                  } catch {
                     // Invalid JSON - send parse error
                     this.send({
                        jsonrpc: "2.0",
                        id: null,
                        error: { code: -32700, message: "Parse error" }
                     });
                  }
               }
            }
         });

         this.socket.on('close', () => {
            this.connected = false;
            log('info', 'Disconnected from parent socket');
         });

         this.socket.on('error', (err) => {
            log('error', 'Socket error', { error: err.message });
            if (!this.connected) {
               reject(err);
            }
         });

         // Connection timeout
         setTimeout(() => {
            if (!this.connected) {
               this.socket?.destroy();
               reject(new Error('Connection timeout'));
            }
         }, 5000);
      });
   }

   private handleMessage(message: Record<string, unknown>): void {
      // Response to our pending request
      if ('id' in message && ('result' in message || 'error' in message)) {
         const pending = this.pendingRequests.get(message.id as string | number);
         if (pending) {
            this.pendingRequests.delete(message.id as string | number);
            if ('error' in message && message.error) {
               pending.reject(new Error((message.error as { message: string }).message));
            } else {
               pending.resolve(message.result);
            }
         }
         return;
      }

      // Request from parent
      if ('method' in message) {
         const method = message.method as string;
         const id = message.id;
         const params = message.params as Record<string, unknown> | undefined;
         const handler = this.handlers.get(method);

         if (handler) {
            handler(params).then((result) => {
               if (id !== undefined) {
                  this.send({
                     jsonrpc: "2.0",
                     id,
                     result
                  });
               }
            }).catch((err) => {
               if (id !== undefined) {
                  this.send({
                     jsonrpc: "2.0",
                     id,
                     error: { code: -32603, message: err.message }
                  });
               }
            });
         } else {
            if (id !== undefined) {
               this.send({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: `Method not found: ${method}` }
               });
            }
         }
      }
   }

   send(message: Record<string, unknown>): void {
      if (this.socket && this.connected) {
         this.socket.write(JSON.stringify(message) + '\n');
      }
   }

   async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
      return new Promise((resolve) => {
         const id = Math.random().toString(36).substring(7);
         const request = {
            jsonrpc: "2.0",
            id,
            method,
            params
         };

         this.pendingRequests.set(id, {
            resolve: () => resolve(),
            reject: () => resolve() // Don't fail notifications
         });

         this.send(request);

         // 5 second timeout for notifications
         setTimeout(() => {
            if (this.pendingRequests.has(id)) {
               this.pendingRequests.delete(id);
               resolve();
            }
         }, 5000);
      });
   }

   registerHandler(method: string, handler: (params?: Record<string, unknown>) => Promise<unknown>): void {
      this.handlers.set(method, handler);
   }

   async disconnect(): Promise<void> {
      if (this.socket) {
         this.socket.destroy();
         this.socket = null;
      }
   }
}

/**
 * Execute the delegated task.
 * This is a simplified implementation - real execution would integrate with pi-agent.
 */
async function executeTask(task: TaskConfig, client: RpcClient): Promise<{ output: string; isError: boolean }> {
   log('info', 'Executing task', { task: task.task.slice(0, 100) });

   try {
      // In a real implementation, this would:
      // 1. Initialize pi-agent with the task
      // 2. Run the agent loop
      // 3. Return the result

      // For now, simulate task execution
      // This could be replaced with actual pi-agent integration
      const cwd = task.cwd || process.cwd();

      // Check if we're in a pi-agent environment
      // For demo purposes, just return a placeholder
      const output = `[Subagent ${task.jobId}] Task executed: ${task.task.slice(0, 100)}...\n` +
         `Persona: ${task.persona || 'default'}\n` +
         `CWD: ${cwd}`;

      // Simulate some work
      await new Promise(r => setTimeout(r, 1000));

      return { output, isError: false };
   } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log('error', 'Task execution failed', { error: errorMessage });
      return { output: errorMessage, isError: true };
   }
}

// Setup signal handlers
function setupSignalHandlers(client: RpcClient): void {
   const shutdown = async (signal: string): Promise<void> => {
      log('info', `Received ${signal}, initiating graceful shutdown`, { jobId: currentJobId });

      try {
         await client.sendNotification('session.shutdown.starting', { jobId: currentJobId, signal });
      } catch {
         // Best effort
      }

      // Give some time for cleanup
      await new Promise(r => setTimeout(r, 1000));
      log('info', 'Shutdown complete', { jobId: currentJobId });
      process.exit(0);
   };

   process.on('SIGINT', () => shutdown('SIGINT'));
   process.on('SIGTERM', () => shutdown('SIGTERM'));
   process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Main function
async function main(): Promise<void> {
   const args = parseArgs();
   currentJobId = args.jobId;

   // Parse task configuration
   currentTask = parseTaskConfig();
   if (!currentTask) {
      console.error('[subagent-notify] No task configuration found');
      // Continue anyway - we can still handle RPC calls
      currentTask = {
         task: '',
         jobId: currentJobId,
         correlationId: ''
      };
   }

   log('info', 'Starting notify subagent', { jobId: currentJobId, hasTask: !!currentTask.task });

   const client = new RpcClient(args.socket, args.jobId);

   try {
      await client.connect();
   } catch (err) {
      log('error', 'Failed to connect to parent', { error: (err as Error).message });
      process.exit(1);
   }

   // Register default handlers
   client.registerHandler('agent.prompt', async (params) => {
      log('debug', 'agent.prompt', { prompt: params?.prompt });
      return { success: true, prompt: params?.prompt, executed: true };
   });

   client.registerHandler('agent.status', async () => {
      return { status: 'running', jobId: currentJobId, hasTask: !!currentTask?.task };
   });

   client.registerHandler('tools.list', async () => {
      return { tools: ['agent.prompt', 'agent.status', 'tools.list', 'tools.execute', 'session.output'] };
   });

   client.registerHandler('tools.execute', async (params) => {
      log('debug', 'tools.execute', { name: params?.name });
      return { success: true, tool: params?.name };
   });

   // Handle session.shutdown notification (C-1)
   client.registerHandler('session.shutdown', async (params) => {
      log('info', 'Shutdown requested', { correlationId: params?.correlationId });

      // Execute task before shutdown if we have one pending
      if (currentTask?.task) {
         const result = await executeTask(currentTask, client);

         // Send output notification before shutdown
         await client.sendNotification('session.output', {
            jobId: currentJobId,
            output: result.output,
            isError: result.isError,
            correlationId: params?.correlationId
         });
      }

      try {
         await client.sendNotification('session.shutdown.ack', {
            jobId: currentJobId,
            correlationId: params?.correlationId
         });
      } catch {
         // Best effort
      }

      return { acknowledged: true };
   });

   // Handle session.heartbeat ping (C-4)
   client.registerHandler('session.heartbeat', async (params) => {
      return { seq: params?.seq, correlationId: params?.correlationId };
   });

   // Handle session.execute - parent requests us to execute our task
   client.registerHandler('session.execute', async (params) => {
      log('info', 'session.execute called', { jobId: currentJobId });

      if (!currentTask?.task) {
         return { output: 'No task configured', isError: true };
      }

      const result = await executeTask(currentTask, client);

      // Send output notification
      await client.sendNotification('session.output', {
         jobId: currentJobId,
         output: result.output,
         isError: result.isError,
         correlationId: params?.correlationId
      });

      return result;
   });

   // Setup signal handlers (E-4)
   setupSignalHandlers(client);

   // Notify parent we're ready
   try {
      await client.sendNotification('session.ready', { jobId: currentJobId });
      log('info', 'Ready notification sent');
   } catch (err) {
      log('warn', 'Failed to send ready notification', { error: (err as Error).message });
   }

   // If we have a task and notifyOnComplete is set, execute automatically
   if (currentTask?.task && currentTask.notifyOnComplete) {
      log('info', 'Auto-executing task with notifyOnComplete', { mode: currentTask.notifyOnComplete });

      // Execute task in background
      executeTask(currentTask, client).then(async (result) => {
         log('info', 'Task completed', { isError: result.isError });

         // Send output notification
         await client.sendNotification('session.output', {
            jobId: currentJobId,
            output: result.output,
            isError: result.isError
         });

         // Send done notification
         await client.sendNotification('session.done', {
            jobId: currentJobId,
            output: result.output,
            isError: result.isError
         });

         // Send exit
         await client.sendNotification('session.exit', {
            jobId: currentJobId,
            exitCode: result.isError ? 1 : 0
         });

         // Give time for notifications to be sent
         await new Promise(r => setTimeout(r, 500));
         process.exit(result.isError ? 1 : 0);
      });
   }

   log('info', 'RPC client running, waiting for requests...');

   // Keep alive until disconnected
   await new Promise<void>((resolve) => {
      const checkConnection = setInterval(() => {
         if (!client) {
            clearInterval(checkConnection);
            resolve();
         }
      }, 1000);
   });
}

// Run
main().catch((err) => {
   log('error', 'Fatal error', { error: (err as Error).message, stack: (err as Error).stack });
   process.exit(1);
});
