import * as net from 'net';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Read task/persona from environment for auto-execution
const ENV_TASK = process.env.PI_TASK || '';
const ENV_PERSONA = process.env.PI_PERSONA || '';

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
      console.error('Usage: node subagent-rpc-client.js --socket=<path> --jobId=<id>');
      process.exit(1);
   }

   return { socket, jobId };
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
let correlationId = '';

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

// RPC Server that listens for connections from parent
class RpcServer {
   private server: net.Server | null = null;
   private socketPath: string;
   private jobId: string;
   private clientSocket: net.Socket | null = null;
   private handlers: Map<string, (params?: Record<string, unknown>) => Promise<unknown>> = new Map();
   private buffer = '';
   private running = true;

   constructor(socketPath: string, jobId: string) {
      this.socketPath = socketPath;
      this.jobId = jobId;
   }

   async listen(): Promise<void> {
      return new Promise((resolve, reject) => {
         // Ensure socket directory exists
         const dir = path.dirname(this.socketPath);
         fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

         this.server = net.createServer((socket) => {
            this.handleConnection(socket);
         });

         this.server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
               // Socket exists - try to unlink and retry
               fs.unlink(this.socketPath, () => {
                  this.server!.listen(this.socketPath, () => {
                     log('info', 'Server listening after retry', { socketPath: this.socketPath });
                     resolve();
                  });
               });
            } else {
               log('error', 'Server error', { error: err.message });
               reject(err);
            }
         });

         this.server.listen(this.socketPath, () => {
            log('info', 'Server listening', { socketPath: this.socketPath });
            resolve();
         });
      });
   }

   private handleConnection(socket: net.Socket): void {
      this.clientSocket = socket;
      log('info', 'Client connected');

      socket.on('data', (data: Buffer) => {
         this.buffer += data.toString();
         const messages = this.buffer.split('\n');
         this.buffer = messages.pop() || '';

         for (const msg of messages) {
            if (msg.trim()) {
               try {
                  const parsed = JSON.parse(msg);
                  this.handleMessage(parsed, socket);
               } catch {
                  // Invalid JSON - send parse error
                  socket.write(JSON.stringify({
                     jsonrpc: "2.0",
                     id: null,
                     error: { code: -32700, message: "Parse error" }
                  }) + '\n');
               }
            }
         }
      });

      socket.on('close', () => {
         log('info', 'Client disconnected');
         this.clientSocket = null;
      });

      socket.on('error', (err) => {
         log('error', 'Socket error', { error: err.message });
      });
   }

   private handleMessage(message: Record<string, unknown>, socket: net.Socket): void {
      // Request from parent
      if ('method' in message) {
         const method = message.method as string;
         const id = message.id;
         const params = message.params as Record<string, unknown> | undefined;
         const handler = this.handlers.get(method);

         if (handler) {
            handler(params).then((result) => {
               if (id !== undefined) {
                  socket.write(JSON.stringify({
                     jsonrpc: "2.0",
                     id,
                     result
                  }) + '\n');
               }
            }).catch((err) => {
               if (id !== undefined) {
                  socket.write(JSON.stringify({
                     jsonrpc: "2.0",
                     id,
                     error: { code: -32603, message: err.message }
                  }) + '\n');
               }
            });
         } else {
            if (id !== undefined) {
               socket.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: `Method not found: ${method}` }
               }) + '\n');
            }
         }
      }
   }

   registerHandler(method: string, handler: (params?: Record<string, unknown>) => Promise<unknown>): void {
      this.handlers.set(method, handler);
   }

   send(message: Record<string, unknown>): void {
      if (this.clientSocket) {
         this.clientSocket.write(JSON.stringify(message) + '\n');
      }
   }

   async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
      this.send({
         jsonrpc: "2.0",
         method,
         params
      });
   }

   async disconnect(): Promise<void> {
      this.running = false;
      if (this.clientSocket) {
         this.clientSocket.destroy();
         this.clientSocket = null;
      }
      if (this.server) {
         this.server.close();
         this.server = null;
      }
   }

   isRunning(): boolean {
      return this.running;
   }
}

// Execute task using pi command
async function executePiTask(task: string, persona: string | undefined, cwd: string): Promise<{ output: string; isError: boolean }> {
   return new Promise((resolve) => {
      const args: string[] = [];

      if (persona) {
         const escapedPersona = persona.replace(/'/g, "'\\''");
         args.push(`--persona='${escapedPersona}'`);
      }

      const escapedTask = task.replace(/'/g, "'\\''");
      args.push(`'${escapedTask}'`);

      log('info', 'spawning-pi', { cwd, args: args.join(' ') });

      const pi = spawn('pi', args, {
         cwd,
         stdio: ['ignore', 'pipe', 'pipe'],
         env: { ...process.env, TERM: 'xterm' }
      });

      let stdout = '';
      let stderr = '';

      pi.stdout?.on('data', (data: Buffer) => {
         stdout += data.toString();
      });

      pi.stderr?.on('data', (data: Buffer) => {
         stderr += data.toString();
      });

      pi.on('close', (code) => {
         const output = stdout || (stderr ? `Errors:\n${stderr}` : '(no output)');
         const isError = code !== 0;

         if (isError && stderr) {
            log('warn', 'pi-exited-with-error', { exitCode: code, stderr: stderr.slice(0, 500) });
         }

         resolve({ output, isError });
      });

      pi.on('error', (err) => {
         log('error', 'pi-process-error', { error: err.message });
         resolve({ output: `Failed to spawn pi: ${err.message}`, isError: true });
      });
   });
}

// Main function
async function main(): Promise<void> {
   const args = parseArgs();
   currentJobId = args.jobId;
   correlationId = currentJobId;

   log('info', 'Starting RPC server', { jobId: currentJobId, socket: args.socket });

   const server = new RpcServer(args.socket, args.jobId);

   try {
      await server.listen();
   } catch (err) {
      log('error', 'Failed to start server', { error: (err as Error).message });
      process.exit(1);
   }

   // Register default handlers
   server.registerHandler('agent.prompt', async (params) => {
      log('debug', 'agent.prompt', { prompt: params?.prompt });
      return { success: true, prompt: params?.prompt, executed: true };
   });

   server.registerHandler('agent.status', async () => {
      return { status: 'running', jobId: currentJobId };
   });

   server.registerHandler('tools.list', async () => {
      return { tools: ['agent.prompt', 'agent.status', 'tools.list', 'tools.execute'] };
   });

   server.registerHandler('tools.execute', async (params) => {
      log('debug', 'tools.execute', { name: params?.name });
      return { success: true, tool: params?.name };
   });

   // CRITICAL: Handle session.shutdown notification (C-1)
   server.registerHandler('session.shutdown', async (params) => {
      log('info', 'Shutdown requested', { correlationId: params?.correlationId });

      try {
         await server.sendNotification('session.shutdown.ack', {
            jobId: currentJobId,
            correlationId: params?.correlationId
         });
      } catch {
         // Best effort
      }

      return { acknowledged: true };
   });

   // CRITICAL: Handle session.heartbeat ping (C-4)
   server.registerHandler('session.heartbeat', async (params) => {
      return { seq: params?.seq, correlationId: params?.correlationId };
   });

   // Handle session.execute - parent requests us to execute our task
   server.registerHandler('session.execute', async (params) => {
      log('info', 'session.execute called', { jobId: currentJobId });

      const task = (params?.task as string) || '';
      const persona = params?.persona as string | undefined;
      const cwd = (params?.cwd as string) || process.cwd();

      // Execute task using pi command
      try {
         const result = await executePiTask(task, persona, cwd);

         // Send output notification
         await server.sendNotification('session.output', {
            jobId: currentJobId,
            output: result.output,
            isError: result.isError
         });

         // Send done notification
         await server.sendNotification('session.done', {
            jobId: currentJobId,
            output: result.output,
            isError: result.isError
         });

         return result;
      } catch (err) {
         const errorMessage = err instanceof Error ? err.message : String(err);
         log('error', 'Task execution failed', { error: errorMessage });

         // Send error notification
         await server.sendNotification('session.output', {
            jobId: currentJobId,
            output: errorMessage,
            isError: true
         });

         return { output: errorMessage, isError: true };
      }
   });

   // Notify parent we're ready
   try {
      await server.sendNotification('session.ready', { jobId: currentJobId });
      log('info', 'Ready notification sent');
   } catch (err) {
      log('warn', 'Failed to send ready notification', { error: (err as Error).message });
   }

   // Auto-execute if task was provided via environment
   if (ENV_TASK) {
      log('info', 'Auto-executing task from environment', { taskLength: ENV_TASK.length });

      const result = await executePiTask(ENV_TASK, ENV_PERSONA || undefined, process.cwd());

      // Send output notification
      await server.sendNotification('session.output', {
         jobId: currentJobId,
         output: result.output,
         isError: result.isError
      });

      // Send done notification
      await server.sendNotification('session.done', {
         jobId: currentJobId,
         output: result.output,
         isError: result.isError
      });

      log('info', 'Auto-execution complete', { isError: result.isError });
   } else {
      log('info', 'RPC client running, waiting for requests...');

      // Keep alive until disconnected
      await new Promise<void>((resolve) => {
         const checkConnection = setInterval(() => {
            if (!server.isRunning()) {
               clearInterval(checkConnection);
               resolve();
            }
         }, 1000);
      });
   }
}

// Run
main().catch((err) => {
   log('error', 'Fatal error', { error: err.message, stack: err.stack });
   process.exit(1);
});
