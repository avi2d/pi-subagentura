import * as net from 'net';
import { 
  RpcRequest, 
  RpcResponse, 
  RpcNotification,
  RpcErrorCode,
  HEARTBEAT_CONSTANTS,
  STREAM_CONSTANTS 
} from './types.js';
import { RpcServiceRegistry, rpcRegistry } from './registry.js';
import { jobRegistry } from '../helpers.js';

interface HeartbeatMonitor {
  jobId: string;
  seq: number;
  timer: NodeJS.Timeout;
  missed: number;
  onDead: (jobId: string) => void;
}

interface PubSubHandler {
  handler: (message: RpcNotification) => void;
  subscription: () => void;
}

export class RpcRouter {
  private connections: Map<string, net.Socket> = new Map();
  private heartbeatMonitors: Map<string, HeartbeatMonitor> = new Map();
  private pubSubHandlers: Map<string, Set<PubSubHandler>> = new Map();
  private registry: RpcServiceRegistry;
  private pendingCalls: Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  constructor(registry: RpcServiceRegistry = rpcRegistry) {
    this.registry = registry;
  }

  // Connect to a subagent's socket
  async connect(jobId: string, socketPath: string, onReady?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath, () => {
        this.connections.set(jobId, socket);
        resolve();
      });

      socket.on('error', (err) => {
        this.connections.delete(jobId);
        reject(err);
      });

      socket.on('close', () => {
        this.connections.delete(jobId);
      });

      let buffer = '';
      socket.on('data', (data: Buffer) => {
        buffer += data.toString();
        const messages = buffer.split('\n');
        buffer = messages.pop() || '';

        for (const msg of messages) {
          if (msg.trim()) {
            try {
              const parsed = JSON.parse(msg);
              // Check for session.ready notification
              if (onReady && parsed.method === 'session.ready') {
                onReady();
              }
              this.handleMessage(jobId, parsed);
            } catch (err) {
              console.warn(`[router] Invalid JSON from ${jobId}: ${err}`);
            }
          }
        }
      });

      // Connection timeout
      setTimeout(() => {
        if (!this.connections.has(jobId)) {
          socket.destroy();
          reject(new Error('Connection timeout'));
        }
      }, 5000);
    });
  }

  private handleMessage(jobId: string, message: RpcRequest | RpcResponse | RpcNotification): void {
    // Handle response to our pending call (RpcResponse has result or error)
    // Check if message is a response by checking for 'id' and ('result' or 'error')
    const isResponse = 'id' in message && ('result' in message || 'error' in message);
    if (isResponse) {
      const response = message as RpcResponse;
      const pending = this.pendingCalls.get(response.id as string | number);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingCalls.delete(response.id as string | number);
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
        return;
      }
    }

    // Handle notification (pub/sub) - RpcNotification has method but no id
    const isNotification = 'method' in message && !('id' in message);
    if (isNotification) {
      const notification = message as RpcNotification;
      const handlers = this.pubSubHandlers.get(notification.method);
      if (handlers) {
        for (const { handler } of handlers) {
          handler(notification);
        }
      }
    }
  }

  // Call a subagent (parent → subagent)
  async call(
    jobId: string, 
    method: string, 
    params?: Record<string, unknown>,
    timeout = 30000
  ): Promise<unknown> {
    const socket = this.connections.get(jobId);
    if (!socket) {
      // Try to reconnect
      const entry = this.registry.lookup(jobId);
      if (!entry) {
        throw new Error(`Session not found: ${jobId}`);
      }
      await this.connect(jobId, entry.socketPath);
      return this.call(jobId, method, params, timeout);
    }

    const id = Math.random().toString(36).substring(7);
    const correlationId = params?.correlationId as string || id;
    
    const request: RpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, correlationId }
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`RPC timeout: ${method} for job ${jobId}`));
      }, timeout);

      this.pendingCalls.set(id, { resolve, reject, timeout: timer });

      socket.write(JSON.stringify(request) + '\n');
    });
  }

  // Direct call between subagents (FR-2.1)
  async directCall(
    toJobId: string, 
    method: string, 
    params?: Record<string, unknown>
  ): Promise<unknown> {
    return this.call(toJobId, method, params);
  }

  // Pub/Sub for FR-2.2
  subscribe(topic: string, handler: (message: RpcNotification) => void): () => void {
    if (!this.pubSubHandlers.has(topic)) {
      this.pubSubHandlers.set(topic, new Set());
    }

    const subscription = () => {
      const handlers = this.pubSubHandlers.get(topic);
      if (handlers) {
        for (const h of handlers) {
          if (h.handler === handler) {
            handlers.delete(h);
            break;
          }
        }
      }
    };

    this.pubSubHandlers.get(topic)!.add({ handler, subscription });
    return subscription;
  }

  publish(topic: string, message: RpcNotification): void {
    const handlers = this.pubSubHandlers.get(topic);
    if (handlers) {
      for (const { handler } of handlers) {
        handler(message);
      }
    }
  }

  // Heartbeat monitoring (C-4)
  startHeartbeat(jobId: string): void {
    if (this.heartbeatMonitors.has(jobId)) {
      this.stopHeartbeat(jobId);
    }

    const monitor: HeartbeatMonitor = {
      jobId,
      seq: 0,
      missed: 0,
      timer: setInterval(async () => {
        try {
          await this.call(jobId, 'session.heartbeat', { seq: monitor.seq });
          monitor.missed = 0;
          monitor.seq++;
        } catch {
          monitor.missed++;
          if (monitor.missed >= HEARTBEAT_CONSTANTS.MAX_MISSED) {
            clearInterval(monitor.timer);
            this.heartbeatMonitors.delete(jobId);
            monitor.onDead(jobId);
          }
        }
      }, HEARTBEAT_CONSTANTS.INTERVAL_MS),
      onDead: (jobId) => {
        this.registry.updateStatus(jobId, 'dead');
        // Also update jobRegistry so it gets cleaned up
        const job = jobRegistry.get(jobId);
        if (job) {
          job.status = 'dead';
          jobRegistry.set(jobId, job);
        }
      }
    };

    this.heartbeatMonitors.set(jobId, monitor);
  }

  stopHeartbeat(jobId: string): void {
    const monitor = this.heartbeatMonitors.get(jobId);
    if (monitor) {
      clearInterval(monitor.timer);
      this.heartbeatMonitors.delete(jobId);
    }
  }

  disconnect(jobId: string): void {
    this.stopHeartbeat(jobId);
    const socket = this.connections.get(jobId);
    if (socket) {
      socket.destroy();
      this.connections.delete(jobId);
    }
  }

  getConnection(jobId: string): net.Socket | undefined {
    return this.connections.get(jobId);
  }

  hasConnection(jobId: string): boolean {
    return this.connections.has(jobId);
  }
}

export const rpcRouter = new RpcRouter();
