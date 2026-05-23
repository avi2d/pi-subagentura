import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { SOCKET_DIR, SOCKET_DIR_MODE, SOCKET_MODE, RPC_CONSTANTS } from './types.js';

export class UnixSocketTransport {
  private server: net.Server | null = null;
  private socketPath: string;
  private connections: Set<net.Socket> = new Set();
  private onConnectionHandler: ((socket: net.Socket) => void) | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  // Ensure socket directory exists with proper permissions (C-3)
  private async ensureSocketDir(): Promise<void> {
    // Atomic directory creation with restricted permissions
    await fs.promises.mkdir(SOCKET_DIR, { mode: SOCKET_DIR_MODE, recursive: true });
    
    // Verify permissions after creation
    const stat = await fs.promises.stat(SOCKET_DIR);
    if ((stat.mode & 0o777) !== SOCKET_DIR_MODE) {
      throw new Error(`Socket directory permissions incorrect: ${stat.mode.toString(8)}`);
    }
  }

  async start(): Promise<void> {
    await this.ensureSocketDir();
    
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Socket already exists - unlink stale socket and retry
          fs.unlink(this.socketPath, () => {
            this.server!.listen(this.socketPath, () => {
              this.setupSocketPermissions();
              resolve();
            });
          });
        } else {
          reject(err);
        }
      });

      this.server.listen(this.socketPath, () => {
        this.setupSocketPermissions();
        resolve();
      });
    });
  }

  private async setupSocketPermissions(): Promise<void> {
    try {
      await fs.promises.chmod(this.socketPath, SOCKET_MODE);
    } catch (err) {
      // Socket might not exist yet if server hasn't fully started
      console.warn(`[transport] Could not set socket permissions: ${err}`);
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    
    let buffer = '';
    
    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      const messages = buffer.split('\n');
      buffer = messages.pop() || ''; // Keep incomplete message in buffer
      
      for (const msg of messages) {
        if (msg.trim()) {
          try {
            const parsed = JSON.parse(msg);
            // Validate request size (S-3)
            if (msg.length > RPC_CONSTANTS.MAX_REQUEST_SIZE) {
              const error = JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id ?? null,
                error: { code: -32003, message: "Request too large" }
              });
              socket.write(error + '\n');
              continue;
            }
            
            if (this.onConnectionHandler) {
              this.onConnectionHandler(socket);
            }
          } catch {
            // Invalid JSON - send parse error
            const error = JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" }
            });
            socket.write(error + '\n');
          }
        }
      }
    });

    socket.on('close', () => {
      this.connections.delete(socket);
    });

    socket.on('error', (err) => {
      this.connections.delete(socket);
    });
  }

  async stop(): Promise<void> {
    // Close all connections
    for (const conn of this.connections) {
      conn.destroy();
    }
    this.connections.clear();

    // Close server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // Send raw JSON message (newline-delimited)
  send(socket: net.Socket, message: Record<string, unknown>): void {
    const data = JSON.stringify(message) + '\n';
    socket.write(data);
  }

  // Broadcast to all connected clients
  broadcast(message: Record<string, unknown>): void {
    const data = JSON.stringify(message) + '\n';
    for (const conn of this.connections) {
      conn.write(data);
    }
  }

  // Accept new connections
  onConnection(handler: (socket: net.Socket) => void): void {
    this.onConnectionHandler = handler;
  }

  // Get all active connections
  getConnections(): net.Socket[] {
    return Array.from(this.connections);
  }

  getSocketPath(): string {
    return this.socketPath;
  }
}
