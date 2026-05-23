// Core RPC Types
export interface RpcRequest {
   jsonrpc: "2.0";
   id: string | number;
   method: string;
   params?: Record<string, unknown>;
}

export interface RpcResponse {
   jsonrpc: "2.0";
   id: string | number;
   result?: unknown;
   error?: {
      code: number;
      message: string;
      data?: unknown;
   };
}

export interface RpcNotification {
   jsonrpc: "2.0";
   method: string;
   params?: Record<string, unknown>;
}

// Job State Extension
export interface RpcJobState {
   mode: "rpc";
   socketPath: string;
   exposedTools: string[];
   tmuxSessionId: string;
   processId?: number;
   correlationId?: string;
}

// Error Codes
export enum RpcErrorCode {
   MethodNotFound = -32601,
   InvalidParams = -32602,
   InternalError = -32603,
   Timeout = -32000,
   ConnectionRefused = -32001,
   SessionNotFound = -32002,
   RequestTooLarge = -32003,
   InvalidMethodName = -32004,
   SubagentDead = -32005,
}

// Service Registry Entry
export interface RpcServiceEntry {
   jobId: string;
   socketPath: string;
   exposedTools: string[];
   status: "running" | "done" | "error" | "dead";
   startedAt: number;
   exitCode?: number;
   correlationId?: string;
   lastHeartbeat?: number;
}

// Tmux Session Config
export interface TmuxSessionConfig {
   jobId: string;
   socketDir: string;
   entryScriptPath: string;
   cwd?: string;
   timeout?: number;
   correlationId?: string;
   /** Task to execute (passed via env for auto-execution) */
   task?: string;
   /** Persona/system prompt */
   persona?: string;
}

// Tmux Exit Event
export interface TmuxExitEvent {
   sessionId: string;
   jobId: string;
   exitCode: number;
   reason: "normal" | "crash" | "signal" | "timeout";
   correlationId?: string;
}

// Heartbeat Types (C-4)
export interface HeartbeatPing {
   jsonrpc: "2.0";
   method: "session.heartbeat";
   params: {
      seq: number;
      correlationId?: string;
   };
}

export interface HeartbeatPong {
   jsonrpc: "2.0";
   method: "session.heartbeat";
   params: {
      seq: number;
      correlationId?: string;
   };
}

// Streaming Types (C-5)
export interface StreamChunk {
   jsonrpc: "2.0";
   method: "stream.chunk";
   params: {
      streamId: string;
      chunkIndex: number;
      data: string;  // Base64 encoded
      isLast: boolean;
      correlationId?: string;
   };
}

export interface StreamControl {
   jsonrpc: "2.0";
   method: "stream.control";
   params: {
      streamId: string;
      action: "pause" | "resume" | "cancel";
      correlationId?: string;
   };
}

// Observability Types (O-1)
export interface LogEvent {
   timestamp: number;
   level: "debug" | "info" | "warn" | "error";
   event: string;
   correlationId?: string;
   jobId?: string;
   data?: Record<string, unknown>;
}

// Constants
export const RPC_CONSTANTS = {
   MAX_REQUEST_SIZE: 10 * 1024 * 1024,  // 10MB
   MAX_DEPTH: 64,                         // Maximum JSON nesting depth
   MAX_STRING_LENGTH: 1024,              // Maximum method name / string field length
   MAX_BATCH_SIZE: 100,                  // Maximum items in a batch request
} as const;

export const STREAM_CONSTANTS = {
   CHUNK_SIZE: 64 * 1024,                // 64KB chunks for streaming responses
   MAX_BUFFERED_CHUNKS: 16,               // Backpressure threshold: pause after 16 chunks (1MB)
   STREAM_HIGH_WATER: 16,                // Resume when buffer drops to this level
} as const;

export const HEARTBEAT_CONSTANTS = {
   INTERVAL_MS: 10_000,                  // Ping every 10 seconds
   TIMEOUT_MS: 30_000,                   // Pong must arrive within 30 seconds
   MAX_MISSED: 3,                        // Mark dead after 3 missed pongs
} as const;

export const SOCKET_DIR = "/tmp/pi-subagentura/";
export const SOCKET_DIR_MODE = 0o700;
export const SOCKET_MODE = 0o700;
