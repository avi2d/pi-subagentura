# Implementation Plan: RPC Mode with Tmux for Subagent Communication

**Version:** 1.2  
**Author:** Planner  
**Date:** 2026-05-22  
**Status:** Draft (revised from critic review)  
**Based on Spec:** `plans/spec.md`

---

## 1. Architecture Decision Record (ADR)

### ADR-001: RPC Mode via Tmux + Unix Domain Sockets

#### Decision
Implement an alternative RPC execution mode for subagents using tmux for process isolation and UNIX domain sockets for JSON-RPC 2.0 communication.

#### Drivers
- **FR-3.4, NFR-2.1**: Crash isolation — a crashed subagent must not crash/hang the parent
- **FR-1.2, NFR-1.3**: Memory isolation — separate V8 heap per subagent
- **FR-2.1-FR-2.4**: Bidirectional inter-subagent communication
- **NFR-1.1**: Low latency (<50ms) for local RPC calls
- **NFR-2.2**: Crash detection via tmux exit notification

#### Alternatives Considered

| Alternative | Pros | Cons |
|-------------|------|------|
| **A. Child Processes (fork/spawn)** | Simple, no external deps | No true isolation, shared signals, complex crash handling |
| **B. Docker containers** | Strong isolation, portable | Slow startup (>2s), heavy dependency, requires Docker daemon |
| **C. Web Workers** | Shared-memory IPC, fast | No true OS process isolation, limited debugging |
| **D. tmux + Unix sockets (CHOSEN)** | Native OS process isolation, fast startup, debuggable, tmux available on Linux/macOS | Platform-dependent (Linux/macOS only), requires tmux installation |

#### Consequences
- **Positive**: True process isolation, attachable debugging via `tmux attach`, crash-safe architecture, subagents can communicate directly
- **Negative**: Platform-dependent (Linux/macOS only), requires tmux as system dependency
- **Risk Mitigation**: Graceful failure with clear error message if tmux absent (NFR-5.1)

---

### ADR-002: JSON-RPC 2.0 over Unix Domain Sockets

#### Decision
Use JSON-RPC 2.0 protocol over UNIX domain sockets as the RPC transport layer, using Node.js `net` module for raw socket communication (not WebSocket).

#### Drivers
- **IR-3.1**: Language-agnostic, well-defined protocol
- **NFR-1.1**: Low latency (<50ms) — Unix sockets avoid TCP/IP stack overhead
- **NFR-4.1**: Socket permissions (chmod 700) restrict access to owner only
- **IR-3.2**: Supports method calls, notifications, and streaming

#### Alternatives Considered

| Alternative | Pros | Cons |
|-------------|------|------|
| **A. HTTP/REST** | Ubiquitous, firewall-friendly | Higher latency, requires TCP port management |
| **B. WebSockets** | Bidirectional, streaming | More complex, requires WS library, runs over TCP not Unix sockets |
| **C. gRPC** | Binary protocol, strong typing | Heavy dependency, requires .proto definitions |
| **D. JSON-RPC 2.0 over Unix Sockets (CHOSEN)** | Simple, low-latency, file-permission security, native `net` module | Local-only, no TLS (acceptable per spec §1.4) |

#### Transport Implementation
- Use Node.js `net` module for UNIX domain socket server and clients
- NOT using `ws` WebSocket library — raw socket framing with JSON newline-delimited messages
- Each message is a JSON object terminated by newline (`\n`)
- This enables <50ms latency without WebSocket protocol overhead

#### Consequences
- **Positive**: Minimal protocol overhead, easy debugging (netcat can inspect), natural fit for co-located processes, no additional dependencies beyond Node.js
- **Negative**: Not network-distributed (intentionally out of scope per §1.4)
- **Library**: `json-rpc-2` ^0.2.1 for protocol handling

---

### ADR-003: Raw tmux CLI for Session Management

#### Decision
Use raw `child_process.exec('tmux ...')` for tmux session management instead of a library.

#### Drivers
- **FR-5.1**: spec mandates tmux integration
- **IR-1.2**: tmux as system dependency (peer dependency)
- **Reliability**: tmux CLI is stable and well-documented

#### Why Not a Library
- No widely-used, maintained npm package exists for tmux abstraction
- Raw CLI is straightforward: `tmux new-session`, `tmux kill-session`, `tmux list-sessions`
- tmux command syntax is simple and battle-tested
- Error parsing from stderr is deterministic

#### Consequences
- **Positive**: No external npm dependency beyond json-rpc-2, direct tmux access, no library bugs
- **Negative**: More manual parsing, handle edge cases ourselves
- **Commands Used:**
  - `tmux new-session -d -s <sessionName> -n pi-subagent "<entryCommand>"`
  - `tmux kill-session -t <sessionName>`
  - `tmux list-sessions -F '#{session_name}'`
  - `tmux list-panes -t <sessionName> -F '#{pane_pid}'`
  - `tmux set-hook -g session-closed 'send-keys -t <sessionName> C-c'`

---

## 2. Constants

The following constants are enforced throughout the RPC implementation:

```typescript
// Request validation limits (S-3)
export const RPC_CONSTANTS = {
  MAX_REQUEST_SIZE: 10 * 1024 * 1024,  // 10MB
  MAX_DEPTH: 64,                         // Maximum JSON nesting depth
  MAX_STRING_LENGTH: 1024,              // Maximum method name / string field length
  MAX_BATCH_SIZE: 100,                  // Maximum items in a batch request
} as const;

// Streaming configuration (C-5)
export const STREAM_CONSTANTS = {
  CHUNK_SIZE: 64 * 1024,                // 64KB chunks for streaming responses
  MAX_BUFFERED_CHUNKS: 16,               // Backpressure threshold: pause after 16 chunks (1MB)
  STREAM_HIGH_WATER: 16,                // Resume when buffer drops to this level
} as const;

// Heartbeat / liveness (C-4)
export const HEARTBEAT_CONSTANTS = {
  INTERVAL_MS: 10_000,                  // Ping every 10 seconds
  TIMEOUT_MS: 30_000,                   // Pong must arrive within 30 seconds
  MAX_MISSED: 3,                        // Mark dead after 3 missed pongs
} as const;
```

---

## 2. Task Breakdown

### Phase 1: Project Setup & Infrastructure

#### Task 1.1: Add Dependencies
**File:** `package.json`  
**Task:** Add `json-rpc-2` and `esbuild` as dependencies. Node.js `net` module is built-in.

```json
{
  "dependencies": {
    "json-rpc-2": "^0.2.1"
  },
  "devDependencies": {
    "esbuild": "^0.24.0"
  },
  "peerDependencies": {
    "tmux": "*"
  }
}
```

**Note:** `ws` WebSocket library is NOT used. Transport is raw UNIX sockets via Node.js `net` module.  
**Build Tool:** `esbuild` is the single, authoritative build tool (M-1).

**Acceptance Criteria:**
- [ ] `npm install` completes without errors
- [ ] `require('json-rpc-2')` resolves correctly
- [ ] `esbuild` available as `npm run build:entry`

---

#### Task 1.2: Create RPC Directory Structure
**Files:**
- `rpc/mod.ts` — Barrel export
- `rpc/types.ts` — RPC-specific types
- `rpc/router.ts` — RPC message routing
- `rpc/server.ts` — JSON-RPC server implementation (parent side)
- `rpc/transport.ts` — Unix socket transport using `net` module
- `rpc/registry.ts` — Subagent service registry
- `rpc/tmux-bridge.ts` — Tmux process spawning
- `entry/subagent-rpc-client.ts` — Client bootstrap for subagent process

**Acceptance Criteria:**
- [ ] All files created with proper TypeScript exports
- [ ] No circular dependencies between modules
- [ ] Types used across modules are properly exported/imported

---

### Phase 2: Core RPC Infrastructure

#### Task 2.1: RPC Types (`rpc/types.ts`)
**Exact File:** `pi-subagentura/rpc/types.ts`

```typescript
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
export interface RpcJobState extends JobState {
  mode: "rpc";
  socketPath: string;
  exposedTools: string[];
  tmuxSessionId: string;
  processId?: number;
  correlationId?: string;  // For observability (O-1)
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
```

**Acceptance Criteria:**
- [ ] All interfaces exported correctly
- [ ] `RpcErrorCode` enum matches spec values
- [ ] TypeScript compilation succeeds with no errors
- [ ] Types are compatible with `json-rpc-2` library

---

#### Task 2.2: Unix Socket Transport (`rpc/transport.ts`)
**Exact File:** `pi-subagentura/rpc/transport.ts`

**Responsibilities:**
- Create UNIX domain socket server using Node.js `net` module
- Accept incoming connections
- Handle socket lifecycle (create, chmod 700, delete)
- Raw socket framing with newline-delimited JSON messages

**Key Functions:**
```typescript
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

export class UnixSocketTransport {
  private server: net.Server;
  private socketPath: string;
  private connections: Set<net.Socket>;
  
  constructor(socketPath: string);
  
  async start(): Promise<void>;
  async stop(): Promise<void>;
  
  // Send raw JSON message (newline-delimited)
  send(socket: net.Socket, message: RpcRequest | RpcResponse): void;
  
  // Broadcast to all connected clients
  broadcast(message: RpcRequest | RpcResponse): void;
  
  // Accept new connections
  onConnection(handler: (socket: net.Socket) => void): void;
  
  // Get all active connections
  getConnections(): net.Socket[];
}
```

**Socket Directory Creation (C-3):**
```typescript
// CRITICAL: Atomic directory creation with restricted permissions
async function ensureSocketDir(dirPath: string): Promise<void> {
  // Use recursive: true with explicit mode for ATOMIC creation
  // mkdir creates all intermediate directories with the specified mode
  await fs.promises.mkdir(dirPath, { mode: 0o700, recursive: true });
  // Verify permissions after creation
  const stat = await fs.promises.stat(dirPath);
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`Socket directory permissions incorrect: ${stat.mode.toString(8)}`);
  }
}
```

**Socket Directory:** `/tmp/pi-subagentura/`  
**Socket Path Convention:** `/tmp/pi-subagentura/<jobId>.sock`

**Permission Model (S-1, S-2):**
- Directory `/tmp/pi-subagentura/` created atomically with `0700` permissions (owner only)
- Socket file `<jobId>.sock` created with `0700` permissions (owner only)
- Both directory AND socket file have restricted permissions
- Defense-in-depth: OS-level permissions provide isolation; no token-based auth needed (intentional per spec §1.4)

**Acceptance Criteria:**
- [ ] Socket directory created atomically with permissions 0700 (C-3)
- [ ] Socket file created with permissions 0700
- [ ] Server accepts connections on specified path
- [ ] Graceful cleanup on `stop()` — socket file removed
- [ ] Connection handler invoked with socket
- [ ] Error handling for EADDRINUSE (socket already exists)
- [ ] Request size/depth validation against RPC_CONSTANTS (S-3)

---

#### Task 2.3: JSON-RPC Server (`rpc/server.ts`)
**Exact File:** `pi-subagentura/rpc/server.ts`

**Execution Model Clarification:**
- `RpcServer` runs on the **parent process** side
- Parent creates socket, accepts connections from subagents
- Subagents are RPC clients that connect to parent's socket

**Responsibilities:**
- Parse JSON-RPC 2.0 requests
- Route method calls to registered handlers
- Handle batch requests (M-3)
- Support notifications (no response)
- Handle streaming responses
- Enforce request validation limits (S-3)

**Key Functions:**
```typescript
export class JsonRpcServer {
  private methodRegistry: Map<string, MethodHandler>;
  
  constructor();
  
  registerMethod(name: string, handler: MethodHandler): void;
  registerMethods(methods: Record<string, MethodHandler>): void;
  
  handleRequest(request: RpcRequest): Promise<RpcResponse>;
  handleBatch(requests: RpcRequest[]): Promise<RpcResponse[]>;
  
  emitStatus(jobId: string, status: AgentStatus): void;
}
```

**Request Validation (S-3):**
```typescript
function validateRequest(request: RpcRequest): boolean {
  // Check JSON string length (prevent memory exhaustion)
  const serialized = JSON.stringify(request);
  if (serialized.length > RPC_CONSTANTS.MAX_REQUEST_SIZE) {
    throw new RpcError(RpcErrorCode.RequestTooLarge, 
      `Request exceeds ${RPC_CONSTANTS.MAX_REQUEST_SIZE} bytes`);
  }
  
  // Validate method name length
  if (request.method.length > RPC_CONSTANTS.MAX_STRING_LENGTH) {
    throw new RpcError(RpcErrorCode.InvalidMethodName,
      `Method name exceeds ${RPC_CONSTANTS.MAX_STRING_LENGTH} characters`);
  }
  
  return true;
}
```

**Batch Request Error Handling (M-3):**
Per JSON-RPC 2.0 spec: batch with invalid items returns error for each invalid item individually. If batch is empty, return `InvalidRequest` (-32600).

```typescript
async handleBatch(requests: RpcRequest[]): Promise<RpcResponse[]> {
  if (requests.length === 0) {
    return [{
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid batch request" }
    }];
  }
  
  const results = await Promise.all(
    requests.map(async (req, index) => {
      try {
        return await this.handleRequest(req);
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id: req.id ?? `batch:${index}`,
          error: { code: (e as RpcError).code ?? -32603, 
                   message: (e as Error).message }
        };
      }
    })
  );
  
  // Return results in request order (JSON-RPC 2.0 requirement)
  return results;
}
```

**Default Methods:**
| Method | Handler |
|--------|---------|
| `agent.prompt` | Execute prompt with optional persona |
| `agent.status` | Return agent status |
| `tools.list` | Return list of exposed tools |
| `tools.execute` | Execute specified tool |
| `session.shutdown` | Graceful shutdown notification (C-1) |
| `session.heartbeat` | Heartbeat ping/pong (C-4) |

**Acceptance Criteria:**
- [ ] Invalid JSON returns `{ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }`
- [ ] Method not found returns `{ jsonrpc: "2.0", error: { code: -32601 } }`
- [ ] Notifications (no `id`) return nothing
- [ ] Batch requests processed in order, results match request order (M-3)
- [ ] Streaming via `ReadableStream` support for large responses (C-5)
- [ ] **Latency: end-to-end RPC call completes in <50ms (NFR-1.1)**
- [ ] Request validation enforces MAX_REQUEST_SIZE, MAX_DEPTH, MAX_STRING_LENGTH (S-3)

---

#### Task 2.4: Service Registry (`rpc/registry.ts`)
**Exact File:** `pi-subagentura/rpc/registry.ts`

**Responsibilities:**
- Track active RPC subagents
- Store socket paths and exposed tools
- Support filtering by jobId
- Concurrent async-safe registration/unregistration

**Key Functions:**
```typescript
export class RpcServiceRegistry {
  private registry: Map<string, RpcServiceEntry>;
  
  register(entry: RpcServiceEntry): void;
  unregister(jobId: string): void;
  lookup(jobId: string): RpcServiceEntry | undefined;
  list(filter?: string): RpcServiceEntry[];
  updateStatus(jobId: string, status: RpcServiceEntry['status'], exitCode?: number): void;
  updateHeartbeat(jobId: string): void;
  clear(): void; // For testing
}
```

**Note on Concurrency (M-2):** Node.js single-threaded model means `Map` operations are safe, but we use explicit locking for any operation that modifies shared state to prevent torn reads during concurrent updates.

**Acceptance Criteria:**
- [ ] `register()` stores entry and returns socketPath
- [ ] `unregister()` removes entry and cleans up
- [ ] `list()` returns all entries, optionally filtered
- [ ] `lookup()` returns entry by jobId or undefined
- [ ] Registry is separate from existing in-process job registry (IR-7.1)
- [ ] Concurrency-safe under concurrent async access

---

#### Task 2.5: RPC Router (`rpc/router.ts`)
**Exact File:** `pi-subagentura/rpc/router.ts`

**Responsibilities:**
- Route RPC calls between subagents (FR-2.3)
- Route messages from parent to subagents
- Support pub/sub event routing (FR-2.2)
- Maintain connection pool to subagent sockets
- Implement heartbeat monitoring (C-4)

**Key Functions:**
```typescript
export class RpcRouter {
  private connections: Map<string, net.Socket>;
  
  // Call parent→subagent
  async call(jobId: string, method: string, params?: Record<string, unknown>, 
             timeout?: number): Promise<unknown>;
  
  // Inter-subagent direct call (FR-2.1)
  async directCall(toJobId: string, method: string, 
                   params?: Record<string, unknown>): Promise<unknown>;
  
  // Pub/Sub for FR-2.2
  subscribe(topic: string, handler: (message: RpcNotification) => void): () => void;
  publish(topic: string, message: RpcNotification): void;
  
  // Heartbeat monitoring (C-4)
  startHeartbeat(jobId: string): void;
  stopHeartbeat(jobId: string): void;
}
```

**Heartbeat Protocol (C-4):**
```typescript
interface HeartbeatMonitor {
  jobId: string;
  seq: number;
  timer: NodeJS.Timeout;
  missed: number;
  onDead: (jobId: string) => void;
}

async function startHeartbeat(jobId: string): Promise<void> {
  const monitor: HeartbeatMonitor = {
    jobId,
    seq: 0,
    timer: setInterval(async () => {
      try {
        await router.call(jobId, 'session.heartbeat', { seq: monitor.seq });
        monitor.missed = 0;
        monitor.seq++;
      } catch {
        monitor.missed++;
        if (monitor.missed >= HEARTBEAT_CONSTANTS.MAX_MISSED) {
          clearInterval(monitor.timer);
          monitor.onDead(jobId);
        }
      }
    }, HEARTBEAT_CONSTANTS.INTERVAL_MS)
  };
}
```

**Acceptance Criteria:**
- [ ] `call()` sends request to specified jobId, returns result or throws error
- [ ] `directCall()` enables subagent-to-subagent RPC
- [ ] Retry logic: 3x with exponential backoff (100ms, 500ms, 1000ms) per §7.4
- [ ] Timeout returns `RpcErrorCode.Timeout` with method name and jobId
- [ ] Pub/sub: multiple handlers per topic supported
- [ ] `subscribe()` returns unsubscribe function
- [ ] Heartbeat: pings sent every 10s, subagent marked dead after 30s silence (C-4)

---

### Phase 3: Tmux Integration

#### Task 3.1: Tmux Bridge (`rpc/tmux-bridge.ts`)
**Exact File:** `pi-subagentura/rpc/tmux-bridge.ts`

**Responsibilities:**
- Check tmux availability (NFR-5.1)
- Create tmux sessions via raw CLI
- Spawn entry script in tmux pane
- Handle session lifecycle (create, kill, attach)
- **MANDATORY** session exit detection via tmux hooks (C-2)
- Orphan cleanup

**Exit Notification Mechanism (C-2 - MANDATORY):**
tmux hooks are the PRIMARY exit notification mechanism, not optional.

```bash
# CRITICAL: Set tmux hooks to capture session lifecycle events
# These hooks fire on session close (normal or crash), guaranteeing detection

# Hook for when ANY session closes
tmux set-hook -g session-closed 'if -F "#{session_name}" != "" { display-message "SESSION_CLOSED #{session_name} #{session_pid} #{?session_exited_flag,crash,normal}" }'

# Alternative: hook pane process exit
tmux set-hook -g pane-ended 'if -F "#{pane_dead_flag}" == "1" { display-message "PANE_DEAD #{session_name} #{pane_pid}" }'
```

```typescript
export class TmuxBridge {
  private socketDir: string;
  private tmuxHooksEnabled: boolean;
  
  constructor(socketDir?: string);
  
  // System check
  async isTmuxAvailable(): Promise<boolean>;
  
  // Session management
  async createSession(config: TmuxSessionConfig): Promise<{ sessionId: string, processId: number }>;
  async killSession(sessionId: string): Promise<void>;
  async attachToSession(sessionId: string): Promise<void>;
  
  // Session exit detection (C-2 - MANDATORY)
  setupTmuxHooks(): void;  // Enable tmux hooks for crash detection
  onSessionExit(sessionId: string, handler: (event: TmuxExitEvent) => void): void;
  
  // Orphan cleanup (NFR-2.3, O-2)
  async cleanupOrphans(): Promise<number>;  // Returns count cleaned
  
  // Get pane PID for a session
  async getSessionPid(sessionId: string): Promise<number>;
}
```

**tmux Server Crash Behavior (E-1):**
When the tmux server crashes:
1. All tmux sessions become detached
2. tmux hooks do NOT fire (server is dead)
3. Socket connections will eventually fail (EOF)
4. Fallback crash detection: polling `tmux list-sessions` every 5s
5. If tmux server returns but sessions are gone → treat as crash

```typescript
async detectZombieSessions(): Promise<string[]> {
  const registrySessions = new Set(this.registry.list().map(e => e.tmuxSessionId));
  const tmuxSessions = await this.listTmuxSessions();
  
  // Sessions in tmux but not in registry = potential orphans
  // Sessions in registry but not in tmux = crashed sessions (emit event)
  const orphans: string[] = [];
  for (const tmuxSession of tmuxSessions) {
    if (!registrySessions.has(tmuxSession)) {
      orphans.push(tmuxSession);
    }
  }
  return orphans;
}
```

**Tmux Commands Used:**
```bash
# Create session with hook setup
tmux new-session -d -s <sessionName> -n pi-subagent "<entryCommand>"
tmux set-hook -g session-closed 'if -F "#{session_name}" != "" { display-message "SESSION_CLOSED #{session_name} #{session_pid}" }'

# Check if session exists
tmux list-sessions -F '#{session_name}' | grep -q <sessionName>

# Kill session
tmux kill-session -t <sessionName>

# Attach for debugging
tmux attach -t <sessionName>

# List sessions with pane PID
tmux list-panes -t <sessionName> -F '#{pane_pid}'

# Check if pane is dead
tmux list-panes -t <sessionName> -F '#{pane_dead_flag}'
```

**Session Naming:** `pi-subagentura:<jobId>`  
**Socket Directory:** `/tmp/pi-subagentura/` (created atomically with 0700)

**Error Handling:**
- tmux not found → `TmuxNotFoundError` with installation instructions
- Session creation failure → specific error with session name
- Session already exists → `EEXIST` handled gracefully

**Acceptance Criteria:**
- [ ] `isTmuxAvailable()` returns `false` with clear error if tmux not installed
- [ ] `createSession()` creates tmux session and spawns entry script
- [ ] `setupTmuxHooks()` enabled on startup (C-2)
- [ ] `killSession()` terminates tmux session and cleans socket
- [ ] Session exit handler invoked with exit code for both normal AND crash exits (C-2)
- [ ] `cleanupOrphans()` finds and removes orphaned sessions (O-2)
- [ ] Crash detection: exit code !== 0 triggers error status (NFR-2.2)
- [ ] **Startup time < 2s**: tmux session creation + subagent startup completes in <2s (NFR-1.2)

---

#### Task 3.2: Subagent RPC Client Entry Script (`entry/subagent-rpc-client.ts`)
**Exact File:** `pi-subagentura/entry/subagent-rpc-client.ts`

**Execution Model Clarification:**
- Entry script runs inside tmux subprocess
- Acts as **RPC client** (NOT server) — connects to parent's socket server
- Entry script is a bootstrapper that initializes the agent logic and RPC client
- Agent logic lives in the subagent process; entry script initializes it

**Build Step:** TypeScript must be compiled to JavaScript before tmux execution.

**Entry Point (CLI):**
```bash
node entry/subagent-rpc-client.js --socket=<parentSocketPath> --jobId=<jobId> [--entryScript=<agentEntryPath>]
```

**Message Loop:**
```
1. Parse --socket and --jobId arguments
2. Connect to parent socket (net.Socket)
3. Send "ready" notification to parent
4. Loop: receive JSON-RPC request → process → send response
5. On completion/error: send "done" notification with result
6. Clean exit
```

**Graceful Shutdown Handling (C-1, E-4):**
```typescript
async function main() {
  const socketPath = parseArgs().socket;
  const jobId = parseArgs().jobId;
  
  // Connect to parent's RPC server
  const client = new RpcClient(socketPath);
  await client.connect();
  
  // Register default handlers
  client.registerHandler('agent.prompt', handleAgentPrompt);
  client.registerHandler('agent.status', handleAgentStatus);
  client.registerHandler('tools.list', handleToolsList);
  client.registerHandler('tools.execute', handleToolsExecute);
  
  // CRITICAL: Handle session.shutdown notification (C-1)
  client.registerHandler('session.shutdown', async (params) => {
    // Log shutdown request
    log('info', 'Shutdown requested', { correlationId: params.correlationId });
    
    // Send acknowledge and cleanup
    await client.sendNotification('session.shutdown.ack', { 
      jobId, 
      correlationId: params.correlationId 
    });
    
    // Perform graceful shutdown
    process.emit('SIGTERM');  // Trigger graceful cleanup
    return { acknowledged: true };
  });
  
  // CRITICAL: Handle session.heartbeat ping (C-4)
  client.registerHandler('session.heartbeat', async (params) => {
    return { 
      seq: params.seq,
      correlationId: params.correlationId 
    };
  });
  
  // CRITICAL: Handle signals properly (E-4)
  setupSignalHandlers(client);
  
  // Notify parent we're ready
  await client.sendNotification('session.ready', { jobId });
  
  // Message loop - handle incoming requests
  await client.messageLoop();
  
  // Send done notification
  await client.sendNotification('session.done', { jobId, exitCode: 0 });
}

function setupSignalHandlers(client: RpcClient) {
  const shutdown = async (signal: string) => {
    log('info', `Received ${signal}, initiating graceful shutdown`, { jobId });
    await client.sendNotification('session.shutdown.starting', { jobId, signal });
    await client.disconnect();
    process.exit(0);
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}
```

**Signal Delivery (E-4):**
When tmux terminates a session:
1. tmux sends SIGHUP to the process group
2. Entry script's `process.on('SIGHUP')` handler fires
3. Handler sends `session.shutdown.starting` notification
4. Cleanup runs, graceful disconnect
5. Process exits cleanly

If process doesn't handle signal within 5s, tmux sends SIGKILL.

**Acceptance Criteria:**
- [ ] Accepts `--socket` and `--jobId` CLI arguments
- [ ] Connects to parent socket and sends ready notification
- [ ] Processes JSON-RPC requests and returns responses
- [ ] Handles `agent.prompt`, `agent.status`, `tools.list`, `tools.execute` methods
- [ ] **Handles `session.shutdown` notification and exits gracefully (C-1)**
- [ ] **Handles `session.heartbeat` ping and responds (C-4)**
- [ ] **Properly handles SIGTERM, SIGINT, SIGHUP signals (E-4)**
- [ ] Sends "done" notification on completion
- [ ] Exits cleanly with code 0 on success, >0 on error

---

#### Task 3.3: Build Step for Entry Script
**Task:** Add TypeScript compilation step for entry script

**Files:**
- `entry/subagent-rpc-client.ts` → compiled to `entry/subagent-rpc-client.js`

**Build Tool:** esbuild (single authoritative build tool - M-1)

**Implementation:**
```bash
# In package.json scripts:
"build:entry": "esbuild entry/subagent-rpc-client.ts --outfile=entry/subagent-rpc-client.js --platform=node --target=node18 --format=cjs"
```

**Acceptance Criteria:**
- [ ] `npm run build:entry` produces `entry/subagent-rpc-client.js`
- [ ] Compiled JS is executable by Node.js
- [ ] Build runs before tmux session creation (Task 4.1)
- [ ] TypeScript compilation completes in <5s

---

### Phase 4: Tool Implementations

#### Task 4.1: `spawn_rpc_subagent` Tool (`tools/spawn-rpc.ts`)
**Exact File:** `pi-subagentura/tools/spawn-rpc.ts`

**Tool Definition:**
```typescript
const SpawnRpcParams = Type.Object({
  task: Type.String({ description: "Task to delegate to the sub-agent" }),
  persona: Type.Optional(Type.String({ description: "Optional system prompt" })),
  model: Type.Optional(Type.String({ description: "Model override" })),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
  expose: Type.Optional(Type.Array(Type.String(), { description: "Tools to expose" })),
  timeout: Type.Optional(Type.Number({ description: "Max execution time in ms" }))
});

const SpawnRpcResult = Type.Object({
  jobId: Type.String(),
  socketPath: Type.String(),
  exposedTools: Type.Array(Type.String()),
  correlationId: Type.String(),  // For observability
  message: Type.String()
});
```

**Implementation Steps:**
1. Validate tmux availability (via `TmuxBridge.isTmuxAvailable()`)
2. Generate jobId (use existing UUID generator)
3. **Ensure socket directory exists atomically with 0700 permissions (C-3)**
4. Generate correlationId for observability tracing (O-1)
5. **Build entry script** (`npm run build:entry`)
6. Call `TmuxBridge.createSession({ jobId, socketDir, entryScriptPath: 'entry/subagent-rpc-client.js', cwd, timeout, correlationId })`
7. Register service in `RpcServiceRegistry`
8. **Start heartbeat monitoring (C-4)**
9. Return `{ jobId, socketPath: /tmp/pi-subagentura/<jobId>.sock, exposedTools, correlationId, message }`

**Acceptance Criteria:**
- [ ] Returns valid jobId and socketPath
- [ ] Tmux session created with correct name
- [ ] Entry script compiled and spawned in tmux pane
- [ ] Service registered in registry
- [ ] Error: clear message if tmux not installed
- [ ] Timeout handled correctly
- [ ] **Startup time < 2s** (NFR-1.2): from spawn_rpc_subagent call to "ready" notification received

---

#### Task 4.2: `call_subagent_rpc` Tool (`tools/call-rpc.ts`)
**Exact File:** `pi-subagentura/tools/call-rpc.ts`

**Tool Definition:**
```typescript
const CallRpcParams = Type.Object({
  jobId: Type.String({ description: "Target subagent job ID" }),
  method: Type.String({ description: "RPC method name" }),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  timeout: Type.Optional(Type.Number({ description: "Call timeout in ms", default: 30000 }))
});

const CallCallResult = Type.Object({
  result: Type.Unknown(),
  correlationId: Type.Optional(Type.String())
});
```

**Implementation:**
1. Lookup socket path via `RpcServiceRegistry.lookup(jobId)`
2. If not found, return error `RpcErrorCode.SessionNotFound`
3. Call `RpcRouter.call(jobId, method, params, timeout)`
4. Return result or error

**Concurrent Calls (E-5):**
- Concurrent calls to the same subagent ARE allowed
- No ordering guarantees by default
- Each call gets its own correlationId
- Client is responsible for ordering if needed (via params.sequence)

**Backpressure Handling (C-5):**
When receiving streaming responses:
- Consumer reads chunks and tracks buffer level
- When buffer exceeds STREAM_CONSTANTS.MAX_BUFFERED_CHUNKS, send `stream.control` with `pause`
- Resume when buffer drops to STREAM_CONSTANTS.STREAM_HIGH_WATER

```typescript
// Backpressure signaling (C-5)
const STREAM_CONSTANTS = {
  CHUNK_SIZE: 64 * 1024,                // 64KB chunks
  MAX_BUFFERED_CHUNKS: 16,               // Pause after 16 chunks (1MB total)
  STREAM_HIGH_WATER: 16,                // Resume when at or below this level
};
```

**Acceptance Criteria:**
- [ ] Returns result for valid jobId + method
- [ ] Returns error for non-existent jobId
- [ ] Returns timeout error if call exceeds timeout
- [ ] Retry: 3x with exponential backoff on connection refused
- [ ] **Latency < 50ms** (NFR-1.1): end-to-end call completes in <50ms
- [ ] **Streaming support**: large responses streamed via chunks with backpressure (C-5)
- [ ] Concurrent calls allowed (E-5)

---

#### Task 4.3: `list_rpc_subagents` Tool (`tools/list-rpc.ts`)
**Exact File:** `pi-subagentura/tools/list-rpc.ts`

**Tool Definition:**
```typescript
const ListRpcParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Filter by jobId substring" }))
});
```

**Implementation:**
1. Call `RpcServiceRegistry.list(filter)`
2. Return formatted list

**Acceptance Criteria:**
- [ ] Returns array of all registered RPC subagents
- [ ] Filter works correctly (case-insensitive substring match)
- [ ] Status reflects actual state (running/done/error/dead)
- [ ] Empty array returned when no subagents active

---

#### Task 4.4: `kill_rpc_subagent` Tool (`tools/kill-rpc.ts`)
**Exact File:** `pi-subagentura/tools/kill-rpc.ts`

**Tool Definition:**
```typescript
const KillRpcParams = Type.Object({
  jobId: Type.String({ description: "Subagent job ID to terminate" }),
  force: Type.Optional(Type.Boolean({ description: "Force kill", default: false }))
});
```

**Implementation:**
1. Lookup session via `RpcServiceRegistry.lookup(jobId)`
2. If `force`:
   - Send SIGKILL via tmux
3. Else (graceful shutdown - C-1):
   - Send `session.shutdown` notification via RPC
   - Wait for `session.shutdown.ack` (max 5s timeout)
   - If no ack, fall back to force kill
4. Call `TmuxBridge.killSession(sessionId)`
5. Cleanup socket file
6. Unregister from `RpcServiceRegistry`
7. Stop heartbeat monitoring

**Acceptance Criteria:**
- [ ] Graceful kill: sends `session.shutdown`, waits for ack (C-1)
- [ ] Force kill: immediately terminates tmux session
- [ ] Socket file removed after kill
- [ ] Returns `{ jobId, killed: true }`
- [ ] Returns error for non-existent jobId

---

#### Task 4.5: Tools Barrel Export (`tools/mod.ts`)
**Exact File:** `pi-subagentura/tools/mod.ts`

**Implementation:**
```typescript
export { spawn_rpc_subagent } from './spawn-rpc.ts';
export { call_subagent_rpc } from './call-rpc.ts';
export { list_rpc_subagents } from './list-rpc.ts';
export { kill_rpc_subagent } from './kill-rpc.ts';
```

**Acceptance Criteria:**
- [ ] All tools re-exported
- [ ] Tool definitions registered in parent extension

---

### Phase 5: Integration & Registration

#### Task 5.1: RPC Module Barrel (`rpc/mod.ts`)
**Exact File:** `pi-subagentura/rpc/mod.ts`

```typescript
export * from './types.ts';
export * from './transport.ts';
export * from './server.ts';
export * from './registry.ts';
export * from './router.ts';
export * from './tmux-bridge.ts';

export { RpcServiceRegistry } from './registry.ts';
export { TmuxBridge } from './tmux-bridge.ts';
```

**Acceptance Criteria:**
- [ ] All RPC modules exported
- [ ] No circular dependencies
- [ ] TypeScript compilation succeeds

---

#### Task 5.2: Main Extension Registration (`subagent.ts`)
**Exact File:** `pi-subagentura/subagent.ts`

**Changes:**
1. Import new RPC tools
2. Register `spawn_rpc_subagent`, `call_subagent_rpc`, `list_rpc_subagents`, `kill_rpc_subagent` tools
3. Initialize `RpcServiceRegistry` singleton
4. Add tmux availability check on extension load
5. **Setup tmux hooks on startup (C-2)**
6. **Start periodic orphan cleanup (O-2)**

**Acceptance Criteria:**
- [ ] New tools appear in tool registry
- [ ] Tmux availability checked on load, warning logged if missing
- [ ] Existing `subagent_with_context`, `subagent_isolated` unchanged

---

#### Task 5.3: Shared Helpers Updates (`helpers.ts`)
**Exact File:** `pi-subagentura/helpers.ts`

**Potential Changes:**
- Add `generateSocketPath(jobId: string): string` helper
- Add `ensureSocketDir(): Promise<void>` helper (atomic, with mode 0o700)

**Acceptance Criteria:**
- [ ] Helpers shared between in-process and RPC modes
- [ ] No breaking changes to existing helpers

---

### Phase 6: Testing

#### Task 6.1: Unit Tests
**Files:**
- `rpc/types.test.ts`
- `rpc/transport.test.ts`
- `rpc/server.test.ts`
- `rpc/registry.test.ts`
- `rpc/router.test.ts`

**Test Coverage:**
- JSON-RPC request/response parsing
- Service registration/unregistration
- Method routing
- Error code handling
- Request validation limits (S-3)
- Batch request error handling (M-3)
- Heartbeat protocol (C-4)

**Acceptance Criteria:**
- [ ] All unit tests pass
- [ ] Mock tmux/socket for isolation
- [ ] No integration tests (avoid tmux dependency in unit tests)

---

#### Task 6.2: Integration Tests
**Files:**
- `rpc/tmux-bridge.test.ts` (requires tmux)
- `rpc/e2e.test.ts` (requires tmux)

**E2E Flow:**
```
1. spawn_rpc_subagent → creates tmux session
2. Wait for "ready" notification
3. call_subagent_rpc with agent.prompt
4. list_rpc_subagents → verify appears
5. kill_rpc_subagent → verify cleanup
```

**Failure Scenario Tests (O-4):**
- What happens when tmux is killed externally? (E-1)
- What happens when the parent process is killed? (E-2)
- tmux server crash behavior (E-1)
- Signal delivery verification (E-4)
- Concurrent calls to same subagent (E-5)

**Acceptance Criteria:**
- [ ] E2E test passes with tmux available
- [ ] Skipped gracefully if tmux not available
- [ ] Socket directory cleaned after test
- [ ] **Failure scenario tests cover crash/kill scenarios (O-4)**

---

### Phase 7: Observability (O-1)

#### Task 7.1: Observability Implementation

**Log Events (O-1):**
All log events include:
```typescript
interface LogEvent {
  timestamp: number;       // Unix timestamp ms
  level: "debug" | "info" | "warn" | "error";
  event: string;           // Event name (e.g., "session.created", "rpc.call")
  correlationId?: string;  // For distributed tracing
  jobId?: string;          // Associated job
  data?: Record<string, unknown>;
}
```

**Required Log Events:**
| Event | Level | Description |
|-------|-------|--------------|
| `session.created` | info | Tmux session created |
| `session.ready` | info | Subagent sent ready notification |
| `session.shutdown` | info | Graceful shutdown requested |
| `session.dead` | warn | Heartbeat detected dead subagent |
| `session.crashed` | error | tmux hook signaled crash |
| `session.cleanup` | info | Orphan cleanup performed |
| `rpc.call` | debug | RPC call initiated (correlationId, method, jobId) |
| `rpc.response` | debug | RPC response received (correlationId, duration) |
| `rpc.error` | error | RPC call failed (correlationId, error) |
| `stream.chunk` | debug | Streaming chunk sent/received |
| `stream.pause` | debug | Backpressure pause signal |
| `stream.resume` | debug | Backpressure resume signal |

**Correlation IDs (O-1):**
- Every RPC call includes a `correlationId` field
- Correlation IDs are UUIDs generated at call site
- Logs capture correlation ID for end-to-end tracing
- Stream operations inherit correlation ID from parent call

**Orphan Cleanup Schedule (O-2):**
```typescript
// Cleanup runs:
// 1. On extension load (startup sweep)
// 2. Every 5 minutes (periodic sweep)
const CLEANUP_SCHEDULE = {
  STARTUP_SWEEP: true,
  PERIODIC_INTERVAL_MS: 5 * 60 * 1000,  // 5 minutes
};

// Orphan definition:
// - tmux session exists for our naming convention (pi-subagentura:*)
// - BUT no corresponding entry in RpcServiceRegistry
// - OR entry exists but is marked "dead"

async function cleanupOrphans(): Promise<number> {
  const ourSessions = await tmux.listSessions()
    .filter(name => name.startsWith('pi-subagentura:'));
  
  for (const session of ourSessions) {
    const jobId = extractJobId(session.name);
    const entry = registry.lookup(jobId);
    
    if (!entry || entry.status === 'dead') {
      // Safe to clean: we created it but it's not tracked or is dead
      await tmux.killSession(session.name);
      log('info', 'session.cleanup', { jobId, session: session.name });
      cleaned++;
    }
  }
  return cleaned;
}
```

**Acceptance Criteria:**
- [ ] Log events emitted for all required events
- [ ] Correlation IDs present on all RPC calls
- [ ] Orphan cleanup runs on startup and periodically
- [ ] Failure scenario tests verify observability output

---

### Phase 8: Documentation

#### Task 8.1: RPC Mode Documentation (`docs/rpc-mode.md`)
**Exact File:** `pi-subagentura/docs/rpc-mode.md`

**Contents:**
- Overview of RPC mode
- How to enable/use
- Tool reference (all 4 new tools)
- **Graceful shutdown protocol (C-1)**
- **Heartbeat mechanism (C-4)**
- **Backpressure signaling (C-5)**
- **Observability and logging (O-1)**
- **Orphan cleanup schedule (O-2)**
- **Signal handling (E-4)**
- **Concurrent call behavior (E-5)**
- Debugging instructions (tmux attach)
- **Parent restart recovery (E-2)**
- Troubleshooting guide
- Examples

**Acceptance Criteria:**
- [ ] Clear getting-started guide
- [ ] All 4 tools documented with examples
- [ ] Debug instructions for tmux
- [ ] Error messages and resolutions
- [ ] All edge cases documented

---

## 3. Dependency Graph

```
[Phase 1: Setup]
    │
    ├── Task 1.1: Add Dependencies
    │       └── depends on: package.json
    │
    └── Task 1.2: Create RPC Directory
            │
            └── creates: rpc/*.ts (empty shells)

[Phase 2: Core RPC Infrastructure - Sequential]
    │
    ├── Task 2.1: rpc/types.ts
    │       └── dependencies: None (base types, shared)
    │
    ├── Task 2.2: rpc/transport.ts
    │       └── dependencies: rpc/types.ts
    │
    ├── Task 2.3: rpc/server.ts
    │       └── dependencies: rpc/types.ts, rpc/transport.ts
    │
    ├── Task 2.4: rpc/registry.ts
    │       └── dependencies: rpc/types.ts
    │
    └── Task 2.5: rpc/router.ts
            └── dependencies: rpc/types.ts, rpc/transport.ts, rpc/registry.ts

[Phase 3: Tmux Integration - Parallel with Phase 2]
    │
    ├── Task 3.1: rpc/tmux-bridge.ts
    │       └── dependencies: rpc/types.ts, rpc/transport.ts
    │
    └── Task 3.2: entry/subagent-rpc-client.ts
            └── dependencies: rpc/types.ts (NOT rpc/server.ts!)
            
[Phase 3.3: Build Step]
    └── Task 3.3: Build Entry Script (esbuild ONLY)
            └── dependencies: Task 3.2 complete

[Phase 4: Tool Implementations - After Phase 2 & 3]
    │
    ├── Task 4.1: tools/spawn-rpc.ts
    │       └── dependencies: rpc/tmux-bridge.ts, rpc/registry.ts, Task 3.3 (build)
    │
    ├── Task 4.2: tools/call-rpc.ts
    │       └── dependencies: rpc/router.ts, rpc/registry.ts
    │
    ├── Task 4.3: tools/list-rpc.ts
    │       └── dependencies: rpc/registry.ts
    │
    ├── Task 4.4: tools/kill-rpc.ts
    │       └── dependencies: rpc/tmux-bridge.ts, rpc/registry.ts
    │
    └── Task 4.5: tools/mod.ts
            └── dependencies: Task 4.1-4.4 complete

[Phase 5: Integration - After Phase 4]
    │
    ├── Task 5.1: rpc/mod.ts
    │       └── dependencies: All rpc/*.ts complete
    │
    ├── Task 5.2: subagent.ts
    │       └── dependencies: tools/mod.ts, rpc/mod.ts
    │
    └── Task 5.3: helpers.ts (optional)
            └── dependencies: None (additive changes)

[Phase 6: Testing - After Phase 5]
    │
    ├── Task 6.1: Unit Tests
    │       └── dependencies: Phase 2 complete
    │
    └── Task 6.2: Integration Tests
            └── dependencies: Phase 5 complete

[Phase 7: Observability - After Phase 5]
    └── Task 7.1: Observability Implementation
            └── dependencies: Phase 2 & Phase 3 complete

[Phase 8: Documentation - After Implementation]
    └── Task 8.1: docs/rpc-mode.md
            └── dependencies: All implementation complete
```

**Execution Order (Critical Path):**
```
1. Task 1.1 (dependencies)
2. Task 1.2 (directory structure)
3. Task 2.1 (types) → Task 2.2 (transport) → Task 2.3 (server) → Task 2.4 (registry) → Task 2.5 (router)
4. Task 3.1 (tmux-bridge)
5. Task 3.2 (entry script client)
6. Task 3.3 (build entry script) - esbuild ONLY
7. Task 4.1-4.5 (tools)
8. Task 5.1-5.3 (integration)
9. Task 7.1 (observability)
10. Task 6.1-6.2 (tests)
11. Task 8.1 (docs)
```

---

## 4. Acceptance Criteria Per Task

| Task | ID | Acceptance Criteria |
|------|----|---------------------|
| 1.1 | AC-1.1 | npm install succeeds, dependencies resolvable |
| 1.1 | AC-1.2 | Only `json-rpc-2` and `esbuild` added (no `ws` dependency) |
| 1.2 | AC-1.3 | All rpc/*.ts files created, compile without errors |
| 2.1 | AC-2.1 | All types match spec, RpcErrorCode enum correct |
| 2.2 | AC-2.2 | Socket directory created ATOMICALLY with chmod 700 (C-3) |
| 2.2 | AC-2.3 | Transport uses Node.js `net` module, not WebSocket |
| 2.3 | AC-2.4 | JSON-RPC parse error returns -32700, method not found returns -32601 |
| 2.3 | AC-2.5 | Batch error handling follows JSON-RPC 2.0 spec (M-3) |
| 2.3 | AC-2.6 | Request validation enforces MAX_REQUEST_SIZE, MAX_DEPTH, MAX_STRING_LENGTH (S-3) |
| 2.3 | AC-2.7 | **Latency < 50ms**: end-to-end RPC call completes in <50ms (NFR-1.1) |
| 2.4 | AC-2.8 | register/unregister/list/lookup all work correctly |
| 2.4 | AC-2.9 | Concurrency-safe under concurrent async access |
| 2.4 | AC-2.10 | Separate from existing in-process job registry |
| 2.5 | AC-2.11 | call() returns result, directCall() enables inter-subagent RPC, retry works |
| 2.5 | AC-2.12 | Pub/sub: subscribe returns unsubscribe, multiple handlers per topic |
| 2.5 | AC-2.13 | Heartbeat: pings every 10s, subagent marked dead after 30s silence (C-4) |
| 3.1 | AC-3.1 | isTmuxAvailable() returns false with clear error if tmux absent |
| 3.1 | AC-3.2 | createSession() spawns entry script in tmux session |
| 3.1 | AC-3.3 | **tmux hooks MANDATORY** - setupTmuxHooks() enabled on startup (C-2) |
| 3.1 | AC-3.4 | Session exit handler invoked with exit code for normal AND crash exits (C-2) |
| 3.1 | AC-3.5 | **Startup < 2s**: from createSession to "ready" notification (NFR-1.2) |
| 3.1 | AC-3.6 | tmux server crash: detach detection + polling fallback (E-1) |
| 3.2 | AC-3.7 | Entry script connects to socket, sends ready, processes requests |
| 3.2 | AC-3.8 | Entry script does NOT import rpc/server.ts (client-only) |
| 3.2 | AC-3.9 | **Handles session.shutdown notification (C-1)** |
| 3.2 | AC-3.10 | **Handles session.heartbeat ping (C-4)** |
| 3.2 | AC-3.11 | **Handles SIGTERM, SIGINT, SIGHUP signals (E-4)** |
| 3.3 | AC-3.12 | `npm run build:entry` produces executable JS (esbuild ONLY - M-1) |
| 4.1 | AC-4.1 | spawn_rpc_subagent returns valid jobId, socketPath, exposedTools, correlationId |
| 4.2 | AC-4.2 | call_subagent_rpc sends request, receives response or timeout error |
| 4.2 | AC-4.3 | **Streaming support**: chunks with backpressure pause/resume (C-5) |
| 4.2 | AC-4.4 | **Concurrent calls allowed** (E-5) |
| 4.3 | AC-4.5 | list_rpc_subagents returns filtered list of active subagents |
| 4.4 | AC-4.6 | kill_rpc_subagent sends session.shutdown, waits for ack (C-1) |
| 4.4 | AC-4.7 | kill_rpc_subagent terminates session, cleans socket |
| 5.1 | AC-5.1 | rpc/mod.ts exports all modules without circular deps |
| 5.2 | AC-5.2 | New tools registered, tmux check on load |
| 5.2 | AC-5.3 | **tmux hooks setup on startup (C-2)** |
| 5.2 | AC-5.4 | **Orphan cleanup scheduled on startup and periodically (O-2)** |
| 6.1 | AC-6.1 | All unit tests pass |
| 6.2 | AC-6.2 | E2E test: spawn → call → list → kill flow works |
| 6.2 | AC-6.3 | **Failure scenario tests cover crash/kill/signal scenarios (O-4)** |
| 7.1 | AC-7.1 | **Observability: log events for all required events (O-1)** |
| 7.1 | AC-7.2 | **Correlation IDs on all RPC calls (O-1)** |
| 7.1 | AC-7.3 | **Orphan cleanup on startup and every 5 minutes (O-2)** |
| 8.1 | AC-8.1 | docs/rpc-mode.md complete with all edge cases documented |

---

## 5. Risk Register

### Risk R-001: tmux Not Available
| Field | Value |
|-------|-------|
| **Risk** | User attempts RPC mode without tmux installed |
| **Severity** | Medium |
| **Likelihood** | Medium (tmux not standard on all systems) |
| **Impact** | RPC mode fails, user confused |
| **Mitigation** | Check on extension load, clear error message with install instructions |
| **Owner** | Task 3.1 |
| **Status** | Planned |

### Risk R-002: Socket Path Conflicts
| Field | Value |
|-------|-------|
| **Risk** | Two jobs with same jobId (collision) or stale socket file |
| **Severity** | Medium |
| **Likelihood** | Low (UUID collision extremely rare) |
| **Impact** | Connection refused, RPC fails |
| **Mitigation** | Check socket existence before create, unlink stale sockets, use atomic mkdir with mode |
| **Owner** | Task 2.2 |
| **Status** | Planned |

### Risk R-003: Subagent Hangs on Startup
| Field | Value |
|-------|-------|
| **Risk** | Entry script hangs, never sends ready, parent waits forever |
| **Severity** | High |
| **Likelihood** | Medium |
| **Impact** | Parent blocks, job never starts |
| **Mitigation** | Implement startup timeout (5s default), kill session if timeout exceeded |
| **Owner** | Task 3.1, Task 3.2 |
| **Status** | Planned |

### Risk R-004: Zombie Tmux Sessions
| Field | Value |
|-------|-------|
| **Risk** | tmux sessions not cleaned up on crash or unclean exit |
| **Severity** | Medium |
| **Likelihood** | Medium (crash scenarios) |
| **Impact** | Resource leak, orphaned tmux sessions accumulate |
| **Mitigation** | tmux hooks MANDATORY for crash detection, orphan cleanup on startup + periodic sweep |
| **Owner** | Task 3.1 |
| **Status** | Planned |

### Risk R-005: Socket Permission Issues
| Field | Value |
|-------|-------|
| **Risk** | Socket directory or file created with wrong permissions |
| **Severity** | Medium |
| **Likelihood** | Low |
| **Impact** | RPC calls fail, permission denied |
| **Mitigation** | Atomic mkdir with explicit mode 0700, verify after creation |
| **Owner** | Task 2.2 |
| **Status** | Planned |

### Risk R-006: Memory/Resource Limits
| Field | Value |
|-------|-------|
| **Risk** | Unbounded RPC responses or streaming data exhaust memory |
| **Severity** | Medium |
| **Likelihood** | Low |
| **Impact** | OOM crash in subagent, affects parent via tmux crash isolation |
| **Mitigation** | MAX_REQUEST_SIZE limit (10MB), streaming chunk limits, timeout on calls |
| **Owner** | Task 2.3 |
| **Status** | Planned |

### Risk R-007: JSON-RPC Version Mismatch
| Field | Value |
|-------|-------|
| **Risk** | Parent/child disagree on protocol version or format |
| **Severity** | Low |
| **Likelihood** | Low |
| **Impact** | Parse errors, failed calls |
| **Mitigation** | Strict JSON-RPC 2.0 validation, clear error codes |
| **Owner** | Task 2.3 |
| **Status** | Planned |

### Risk R-008: Debugging Complexity
| Field | Value |
|-------|-------|
| **Risk** | Hard to debug RPC issues in distributed tmux environment |
| **Severity** | Low |
| **Likelihood** | Medium |
| **Impact** | Longer debugging time, harder reproduction |
| **Mitigation** | SUBAGENT_DEBUG_LOG_DIR coverage, tmux attach capability, structured logging with correlation IDs |
| **Owner** | All tasks |
| **Status** | Planned |

### Risk R-009: tmux Server Crash (E-1)
| Field | Value |
|-------|-------|
| **Risk** | tmux server itself crashes, leaving sessions orphaned |
| **Severity** | High |
| **Likelihood** | Low |
| **Impact** | All subagent sessions become detached, crash detection fails silently |
| **Mitigation** | tmux hooks + polling fallback. On tmux restart, detect missing sessions and emit crash events |
| **Owner** | Task 3.1 |
| **Status** | Planned |

### Risk R-010: Parent Process Restart (E-2)
| Field | Value |
|-------|-------|
| **Risk** | Parent process restarts (upgrade, crash), losing registry state |
| **Severity** | High |
| **Likelihood** | Medium |
| **Impact** | Existing tmux sessions continue running but parent has no record of them |
| **Mitigation** | On startup: scan tmux for our sessions, reconcile with registry, mark unmatched as "unknown" state |
| **Owner** | Task 3.1, Task 5.2 |
| **Status** | Planned |

### Risk R-011: tmux Hooks Silently Fail (A-1)
| Field | Value |
|-------|-------|
| **Risk** | tmux hooks are misconfigured or silently fail, breaking crash detection |
| **Severity** | High |
| **Likelihood** | Medium |
| **Impact** | Crash detection becomes unreliable, zombie sessions |
| **Mitigation** | PRIMARY: tmux hooks for crash detection. FALLBACK: polling + socket disconnect. Validate hooks on setup |
| **Owner** | Task 3.1 |
| **Status** | Planned |

---

## 6. Edge Cases Documented

### E-1: tmux Server Crash
**Behavior:**
1. tmux server crashes → all sessions become detached
2. tmux hooks do NOT fire (server is dead)
3. Socket connections will eventually fail (EOF)
4. Fallback crash detection: polling `tmux list-sessions` every 5s
5. If tmux server returns but sessions are gone → emit `session.crashed` event for each missing session
6. Orphan cleanup picks up any orphaned tmux sessions on next run

### E-2: Parent Process Restart
**Behavior:**
1. Parent process restarts
2. On extension load, `cleanupOrphans()` runs:
   - Scan tmux for sessions matching `pi-subagentura:*` prefix
   - For each session, check if registry has entry
   - Sessions in tmux but not in registry → mark as "unknown" or attempt re-attach
3. Re-connect to existing subagent sockets if possible
4. If socket fails, mark subagent as "dead" and cleanup tmux session

### E-3: Subagent Executes Fork()
**Acknowledged:** A subagent that calls `fork()` creates a child process that:
- Is NOT tracked in RpcServiceRegistry
- Is NOT killed when the tmux session is killed (tmux only kills immediate child)
- Could potentially orphan grandchildren

**Mitigation:** This is explicitly OUT OF SCOPE for v1. Subagents are assumed to be trusted code.

### E-4: Signal Delivery to Entry Script
**Behavior:**
1. tmux sends SIGHUP to terminate session
2. Entry script's `process.on('SIGHUP')` handler fires
3. Handler sends `session.shutdown.starting` notification to parent
4. Cleanup runs (close connections, flush buffers)
5. Process exits cleanly with code 0

If process doesn't handle signal within 5s, tmux sends SIGKILL (forced termination).

### E-5: Concurrent Calls to Same Subagent
**Behavior:**
- Concurrent calls to the same subagent ARE allowed
- No ordering guarantees by default
- Each call has its own correlationId for tracing
- Client is responsible for implementing ordering via request sequence numbers if needed
- Subagent processes requests independently (no mutex/lock)

---

## 7. File Manifest

All files relative to `pi-subagentura/`:

```
pi-subagentura/
├── package.json                    [MODIFY] Add json-rpc-2, esbuild dependencies (remove ws)
├── subagent.ts                     [MODIFY] Register new RPC tools, setup hooks, cleanup scheduler
├── helpers.ts                      [MODIFY] Add socket path helpers
│
├── rpc/
│   ├── mod.ts                     [NEW] Barrel export
│   ├── types.ts                   [NEW] RPC type definitions, constants (S-3, C-4, C-5)
│   ├── transport.ts               [NEW] Unix socket transport (net module, atomic mkdir)
│   ├── server.ts                  [NEW] JSON-RPC server (parent side, request validation)
│   ├── registry.ts                [NEW] Service registry (separate from jobRegistry)
│   ├── router.ts                 [NEW] RPC message routing, heartbeat monitoring
│   └── tmux-bridge.ts            [NEW] Tmux session management, MANDATORY hooks (C-2)
│
├── entry/
│   ├── subagent-rpc-client.ts     [NEW] Bootstrap script for tmux subagent (client)
│   └── subagent-rpc-client.js    [NEW] Compiled JS (built by esbuild via Task 3.3)
│
├── tools/
│   ├── mod.ts                     [MODIFY] Re-export new tools
│   ├── spawn-rpc.ts               [NEW] spawn_rpc_subagent tool
│   ├── call-rpc.ts                [NEW] call_subagent_rpc tool
│   ├── list-rpc.ts                [NEW] list_rpc_subagents tool
│   └── kill-rpc.ts                [NEW] kill_rpc_subagent tool (graceful shutdown)
│
├── test/
│   ├── rpc/
│   │   ├── types.test.ts         [NEW]
│   │   ├── transport.test.ts      [NEW]
│   │   ├── server.test.ts         [NEW]
│   │   ├── registry.test.ts      [NEW]
│   │   ├── router.test.ts         [NEW]
│   │   ├── tmux-bridge.test.ts   [NEW] Integration test
│   │   └── e2e.test.ts           [NEW] Integration test + failure scenarios
│   └── fixtures/
│       └── mock-rpc-agent.ts      [NEW]
│
└── docs/
    └── rpc-mode.md               [NEW] RPC mode documentation (all edge cases)
```

---

## 8. Implementation Notes

### Critical Ordering
1. **Task 2.1 (types)** must complete before any other RPC module
2. **Task 2.2 (transport)** and **Task 3.1 (tmux-bridge)** can be developed in parallel
3. **Task 3.2 (entry script)** depends only on Task 2.1 (types), NOT on Task 2.3 (server)
4. **Task 3.3 (build)** must run before Task 4.1 (spawn)
5. **Task 4 (tools)** depend on all Phase 2 and Phase 3 tasks complete
6. **Task 5.2 (registration)** is the integration point — test after all tools ready
7. **Task 7.1 (observability)** should be implemented alongside Phase 2 tasks

### Key Technical Decisions
- **Transport**: Node.js `net` module for UNIX sockets (NOT `ws` WebSocket library)
- **Tmux abstraction**: Raw CLI via `child_process.exec('tmux ...')` (no npm package)
- **Socket directory**: `/tmp/pi-subagentura/` — atomic creation with mode 0700
- **Session naming**: `pi-subagentura:<jobId>` — easily grep-able in `tmux list-sessions`
- **Entry script**: Compiled JS in `entry/subagent-rpc-client.js` — built via `esbuild`
- **Error propagation**: Structured JSON-RPC errors with codes per spec
- **Permission model**: Both directory AND socket file have chmod 0700
- **Crash detection**: tmux hooks MANDATORY, socket disconnect + polling fallback
- **Build tool**: esbuild ONLY (M-1)

### Execution Model Clarification
- **Parent process**: Runs `RpcServer` + `UnixSocketTransport` (server mode)
- **Subagent process (tmux)**: Runs RPC client (`subagent-rpc-client.js`) that connects to parent's socket
- Entry script is a **client** bootstrapper, not a server
- Entry script initializes agent logic and connects to parent

### Registry Separation
- `RpcServiceRegistry` tracks RPC-mode subagents only
- Existing `jobRegistry` (from `helpers.ts`) tracks in-process subagents
- They are separate, independent registries
- `get_subagent_status`/`get_subagent_result` work for in-process only
- RPC jobs use `RpcServiceRegistry.lookup(jobId).status`

### Testing Strategy
- **Unit tests**: Mock everything, no tmux required
- **Integration tests**: Require tmux, skip if not available
- **E2E test**: Full flow, requires full environment
- **Failure scenario tests**: tmux kill, parent kill, signal delivery

### Security Model
- **Intent**: Minimal security per spec §1.4 (local-only, no TLS)
- **Defense**: OS-level permissions (chmod 0700) on directory and sockets
- **Out of scope**: Token-based auth, rate limiting (intentionally minimal)
- **Request bounds**: MAX_REQUEST_SIZE=10MB, MAX_DEPTH=64, MAX_STRING_LENGTH=1024 (S-3)

---

*End of Implementation Plan*