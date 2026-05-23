import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

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
      return new Promise((resolve, reject) => {
         const id = Math.random().toString(36).substring(7);
         const request = {
            jsonrpc: "2.0",
            id,
            method,
            params
         };

         this.pendingRequests.set(id, {
            resolve: () => resolve(),
            reject
         });

         this.send(request);

         // 5 second timeout for notifications
         setTimeout(() => {
            if (this.pendingRequests.has(id)) {
               this.pendingRequests.delete(id);
               resolve(); // Don't fail notifications
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

// Main function
async function main(): Promise<void> {
   const args = parseArgs();
   currentJobId = args.jobId;
   correlationId = currentJobId;

   log('info', 'Starting RPC client', { jobId: currentJobId, socket: args.socket });

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
      return { status: 'running', jobId: currentJobId };
   });

   client.registerHandler('tools.list', async () => {
      return { tools: ['agent.prompt', 'agent.status', 'tools.list', 'tools.execute'] };
   });

   client.registerHandler('tools.execute', async (params) => {
      log('debug', 'tools.execute', { name: params?.name });
      return { success: true, tool: params?.name };
   });

   // CRITICAL: Handle session.shutdown notification (C-1)
   client.registerHandler('session.shutdown', async (params) => {
      log('info', 'Shutdown requested', { correlationId: params?.correlationId });

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

   // CRITICAL: Handle session.heartbeat ping (C-4)
   client.registerHandler('session.heartbeat', async (params) => {
      return { seq: params?.seq, correlationId: params?.correlationId };
   });

   // Handle session.execute - parent requests us to execute our task
   client.registerHandler('session.execute', async (params) => {
      log('info', 'session.execute called', { jobId: currentJobId });

      const task = (params?.task as string) || '';
      const persona = params?.persona as string | undefined;

      // Execute task and send output notification
      try {
         // TODO: Integrate with pi-agent for actual execution
         // For now, return a placeholder
         const output = `[Subagent ${currentJobId}] Task executed: ${task.slice(0, 100)}...\n` +
            `Persona: ${persona || 'default'}`;

         // Send output notification
         await client.sendNotification('session.output', {
            jobId: currentJobId,
            output,
            isError: false
         });

         // Send done notification
         await client.sendNotification('session.done', {
            jobId: currentJobId,
            output,
            isError: false
         });

         return { output, isError: false };
      } catch (err) {
         const errorMessage = err instanceof Error ? err.message : String(err);
         log('error', 'Task execution failed', { error: errorMessage });

         // Send error notification
         await client.sendNotification('session.output', {
            jobId: currentJobId,
            output: errorMessage,
            isError: true
         });

         return { output: errorMessage, isError: true };
      }
   });

   setupSignalHandlers(client);

   // Notify parent we're ready
   try {
      await client.sendNotification('session.ready', { jobId: currentJobId });
      log('info', 'Ready notification sent');
   } catch (err) {
      log('warn', 'Failed to send ready notification', { error: (err as Error).message });
   }

   // Message loop - the client handles incoming messages via event emitter
   // We just need to keep the process alive
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

function setupSignalHandlers(client: RpcClient): void {
   const shutdown = async (signal: string): Promise<void> => {
      log('info', `Received ${signal}, initiating graceful shutdown`, { jobId: currentJobId });

      try {
         await client.sendNotification('session.shutdown.starting', { jobId: currentJobId, signal });
      } catch {
         // Best effort
      }

      await client.disconnect();
      process.exit(0);
   };

   process.on('SIGTERM', () => shutdown('SIGTERM'));
   process.on('SIGINT', () => shutdown('SIGINT'));
   process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Run
main().catch((err) => {
   log('error', 'Fatal error', { error: (err as Error).message });
   process.exit(1);
});