# Technical Specification: RPC Mode with Tmux Subagents

## 1. Overview

**Project:** `pi-subagentura` — Pi package for spawning in-process sub-agents

**Feature:** Add RPC mode enabling subagents to communicate with each other via tmux-based IPC (Inter-Process Communication).

**Current State:** Subagents run in-process via `createAgentSession`, with async job tracking and one-way notification delivery.

**Target State:** Subagents can spawn as independent tmux sessions, expose RPC endpoints, and call tools on each other bidirectionally.

---

## 2. Tech Stack Decisions

### 2.1 Core Technologies

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Process Isolation | **tmux** | Native multiplexor, available on most Linux/macOS systems; enables separate sessions per subagent |
| RPC Protocol | **JSON-RPC 2.0 over Unix Domain Sockets** | Simple, language-agnostic; avoids HTTP overhead; uses filesystem permissions for security |
| Message Serialization | **TypeScript-native JSON** | Leverages existing codebase patterns; no additional serialization deps |
| Service Discovery | **In-memory registry + filesystem socket paths** | Co-located with job registry; socket paths derived from jobId |
| Error Handling | **Structured error propagation** | JSON-RPC error codes; preserves stack traces in development |

### 2.2 Architecture Pattern

**Pattern:** Remote Procedure Call (RPC) with Actor-inspired message routing

```
┌─────────────────────────────────────────────────────────────────┐
│                      Main Agent Process                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Job Registry                               ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         ││
│  │  │ Job-A (tmux) │  │ Job-B (tmux) │  │ Job-C (tmux) │         ││
│  │  │ :8081/socket │  │ :8082/socket │  │ :8083/socket │         ││
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         ││
│  │         │                │                │                    ││
│  │         └────────────────┴────────────────┘                    ││
│  │                          │                                      ││
│  │              RPC Router / Message Broker                       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Why tmux + JSON-RPC over Unix Sockets?

1. **Isolation:** Crash in one subagent doesn't corrupt parent or siblings
2. **Resource Limits:** Can apply per-subagent memory/CPU limits via cgroups (future)
3. **Debugging:** Attach `tmux attach -t <session>` to inspect any subagent live
4. **Simplicity:** No external dependencies; tmux is battle-tested
5. **Performance:** Unix sockets avoid TCP overhead; ~0.5ms latency for local IPC

---

## 3. Architecture Overview

### 3.1 Layer Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      Presentation Layer                           │
│  • Tool definitions (RPC spawn, call, list, kill)                 │
│  • Schema definitions (TypeBox)                                    │
│  • Render functions (TUI output)                                  │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│                      Application Layer                            │
│  • TmuxSessionManager: spawn/kill tmux sessions                   │
│  • RpcRouter: message routing between subagents                   │
│  • JobLifecycle: async job state transitions                       │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│                      RPC Infrastructure Layer                      │
│  • JsonRpcServer: handles JSON-RPC requests                       │
│  • UnixSocketTransport: accepts connections, manages sockets      │
│  • ServiceRegistry: tracks exposed methods per subagent            │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│                      Tmux Integration Layer                       │
│  • TmuxProcessBridge: spawns Node.js scripts in tmux panes        │
│  • SocketLifecycle: creates/deletes Unix socket files             │
│  • SessionLifecycle: create/attach/detach tmux sessions           │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Interactions

```
Main Agent
    │
    ├──[spawn_rpc_subagent]──► TmuxSessionManager
    │                              │
    │                         TmuxProcessBridge
    │                              │
    │                         tmux new-session
    │                              │
    │                         [Node.js script: subagent-rpc-entry.ts]
    │                                    │
    │                             JsonRpcServer (Unix socket)
    │                                    │
    │                             ServiceRegistry (exposes tools)
    │
    ├──[call_subagent_rpc]──► RpcRouter
    │                              │
    │                         lookup socket by jobId
    │                              │
    │                         send JSON-RPC request
    │                              │
    │                         wait for response
    │
    └──[list_rpc_subagents]──► JobRegistry
                                  │
                             filter by mode === "rpc"
```

### 3.3 Execution Modes

| Mode | Spawn Mechanism | Communication | Use Case |
|------|-----------------|---------------|----------|
| `in-process` (default) | `createAgentSession()` | Direct function call | Single-process, low latency |
| `tmux` (new) | `tmux new-session` | JSON-RPC over Unix socket | Isolated, debuggable, fault-tolerant |

---

## 4. File Structure

```
pi-subagentura/
├── subagent.ts                    # Extension entry point, tool registrations
├── helpers.ts                    # Shared helpers (existing)
├── rpc/
│   ├── mod.ts                    # RPC module barrel export
│   ├── types.ts                  # RPC-specific types
│   ├── router.ts                 # RPC message routing
│   ├── server.ts                 # JSON-RPC server implementation
│   ├── transport.ts              # Unix socket transport
│   ├── registry.ts               # Subagent service registry
│   └── tmux-bridge.ts            # Tmux process spawning
├── tools/
│   ├── spawn-rpc.ts              # spawn_rpc_subagent tool
│   ├── call-rpc.ts               # call_subagent_rpc tool
│   ├── list-rpc.ts               # list_rpc_subagents tool
│   └── kill-rpc.ts               # kill_rpc_subagent tool
└── test/
    └── rpc.test.ts               # RPC mode tests
```

### 4.1 Directory Tree (Full)

```
pi-subagentura/
├── subagent.ts                    # Extension entry (existing)
├── helpers.ts                    # Shared helpers (existing)
├── rpc/
│   ├── mod.ts                    # Re-exports all RPC types/functions
│   ├── types.ts                 # RpcSubagentJob, RpcRequest, RpcResponse
│   ├── router.ts                # RpcRouter class
│   ├── server.ts                # JsonRpcServer class
│   ├── transport.ts             # UnixSocketTransport class
│   ├── registry.ts              # RpcServiceRegistry class
│   └── tmux-bridge.ts           # TmuxProcessBridge class
├── tools/
│   ├── mod.ts                   # Re-exports all tools
│   ├── spawn-rpc.ts             # spawn_rpc_subagent tool definition
│   ├── call-rpc.ts              # call_subagent_rpc tool definition
│   ├── list-rpc.ts              # list_rpc_subagents tool definition
│   └── kill-rpc.ts              # kill_rpc_subagent tool definition
├── entry/
│   └── subagent-rpc-entry.ts    # Entry script for tmux-launched subagents
├── test/
│   ├── rpc.test.ts              # Integration tests
│   └── fixtures/
│       └── mock-rpc-agent.ts    # Mock agent for testing
├── docs/
│   └── rpc-mode.md              # RPC mode documentation
└── package.json                  # Dependencies update
```

---

## 5. Dependencies

### 5.1 New Dependencies

```json
{
  "dependencies": {
    "ws": "^8.18.0",
    "json-rpc-2": "^0.2.1",
    "typescript": "^5.7.2"
  }
}
```

| Package | Version | Purpose |
|---------|---------|---------|
| `ws` | ^8.18.0 | WebSocket server for Unix socket adapter |
| `json-rpc-2` | ^0.2.1 | JSON-RPC 2.0 protocol implementation (optional, can implement manually) |

### 5.2 Updated Peer Dependencies

```json
{
  "peerDependencies": {
    "@mariozechner/pi-agent-core": "*",
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "typebox": "*",
    "tmux": "*"  // New: system binary check
  }
}
```

### 5.3 Dev Dependencies (No Change)

```json
{
  "devDependencies": {
    "@types/node": "^22.0.0",
    "prettier": "^3.8.3",
    "typescript": "^6.0.3",
    "vitest": "^3.0.0"
  }
}
```

### 5.4 System Requirements

| Requirement | Minimum | Purpose |
|------------|---------|---------|
| Node.js | >= 18.0.0 | Current requirement |
| tmux | >= 3.0 | Spawning isolated sessions |
| Unix-like OS | Linux, macOS | Unix socket support |

---

## 6. API Definitions

### 6.1 Tool: `spawn_rpc_subagent`

Spawns a subagent in an isolated tmux session with RPC capability.

```typescript
const SpawnRpcParams = Type.Object({
  task: Type.String({ description: "Task to delegate to the sub-agent" }),
  persona: Type.Optional(
    Type.String({ description: "Optional system prompt" })
  ),
  model: Type.Optional(
    Type.String({ description: "Model override (e.g., 'anthropic/claude-sonnet-4-5')" })
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory override" })
  ),
  expose: Type.Optional(
    Type.Array(Type.String(), {
      description: "List of tools to expose via RPC (default: all public tools)"
    })
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Max execution time in ms (default: no limit)" })
  )
});

Tool: spawn_rpc_subagent
Parameters: SpawnRpcParams
Returns: {
  jobId: string,
  socketPath: string,
  exposedTools: string[],
  message: string
}
```

### 6.2 Tool: `call_subagent_rpc`

Calls a method on a remote RPC subagent.

```typescript
const CallRpcParams = Type.Object({
  jobId: Type.String({ description: "Target subagent job ID" }),
  method: Type.String({ description: "RPC method name (e.g., 'tools.execute')" }),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Method parameters as key-value object"
    })
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Call timeout in ms (default: 30000)" })
  )
});

Tool: call_subagent_rpc
Parameters: CallRpcParams
Returns: {
  result: unknown,
  error?: { code: number, message: string }
}
```

### 6.3 Tool: `list_rpc_subagents`

Lists all active RPC subagents.

```typescript
const ListRpcParams = Type.Object({
  filter: Type.Optional(
    Type.String({ description: "Filter by jobId substring" })
  )
});

Tool: list_rpc_subagents
Parameters: ListRpcParams
Returns: {
  subagents: Array<{
    jobId: string,
    status: "running" | "done" | "error",
    socketPath: string,
    exposedTools: string[],
    startedAt: number
  }>
}
```

### 6.4 Tool: `kill_rpc_subagent`

Terminates an RPC subagent and cleans up its tmux session.

```typescript
const KillRpcParams = Type.Object({
  jobId: Type.String({ description: "Subagent job ID to terminate" }),
  force: Type.Optional(
    Type.Boolean({ description: "Force kill without graceful shutdown (default: false)" })
  )
});

Tool: kill_rpc_subagent
Parameters: KillRpcParams
Returns: {
  jobId: string,
  killed: boolean
}
```

### 6.5 Internal Types

```typescript
// RPC Message Types
interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Job State Extension
interface RpcJobState extends JobState {
  mode: "rpc";
  socketPath: string;
  exposedTools: string[];
  tmuxSessionId: string;
  processId?: number;
}

// Error Codes
enum RpcErrorCode {
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  Timeout = -32000,
  ConnectionRefused = -32001,
  SessionNotFound = -32002
}
```

---

## 7. Implementation Notes

### 7.1 Tmux Session Naming Convention

```
pi-subagentura:<jobId>
Example: pi-subagentura:a1b2c3d4e5f67890
```

Socket path convention:
```
/tmp/pi-subagentura/<jobId>.sock
```

### 7.2 RPC Method Registry

Default exposed methods:

| Method | Description | Parameters |
|--------|-------------|------------|
| `agent.prompt` | Execute a prompt | `{ prompt: string, persona?: string }` |
| `agent.status` | Get agent status | `{}` |
| `tools.list` | List available tools | `{}` |
| `tools.execute` | Execute a tool | `{ name: string, args: Record<string, unknown> }` |

### 7.3 Lifecycle

```
[spawn_rpc_subagent]
    │
    ├─► TmuxSessionManager.create(jobId)
    │       │
    │       ├─► create socket directory
    │       ├─► create tmux session: tmux new-session -s <name> -d
    │       └─► spawn entry script in tmux pane
    │
    ├─► RpcServiceRegistry.register(jobId, { socketPath, exposedTools })
    │
    └─► return { jobId, socketPath, ... }

[call_subagent_rpc]
    │
    ├─► RpcRouter.lookup(jobId) → socketPath
    │
    ├─► UnixSocketTransport.connect(socketPath)
    │
    ├─► send RpcRequest
    │
    └─► await RpcResponse

[kill_rpc_subagent]
    │
    ├─► RpcRouter.lookup(jobId) → sessionId
    │
    ├─► tmux kill-session -t <sessionId>
    │
    ├─► cleanup socket file
    │
    └─► RpcServiceRegistry.unregister(jobId)
```

### 7.4 Error Handling Strategy

1. **Connection refused:** Retry 3x with exponential backoff (100ms, 500ms, 1000ms)
2. **Timeout:** Return `RpcErrorCode.Timeout` with method name and jobId
3. **Session not found:** Mark job as `error`, notify via existing notification system
4. **Internal error:** Propagate JSON-RPC error with stack trace in development mode

### 7.5 Security Considerations

1. **Socket permissions:** `chmod 700` on socket directory (owner only)
2. **tmux session isolation:** Each session runs with minimal privileges
3. **No network exposure:** Unix sockets are local-only
4. **Input validation:** All RPC params validated via TypeBox before execution

---

## 8. Backward Compatibility

- Existing `subagent_with_context` and `subagent_isolated` tools remain unchanged
- `spawn_rpc_subagent` is an **additive** feature (no breaking changes)
- Existing async job lifecycle (`get_subagent_status`, etc.) continues to work
- RPC subagents are tracked in a **separate** registry to avoid polluting existing job registry

---

## 9. Future Considerations (Out of Scope for v1)

1. **cgroups integration** for per-subagent resource limits
2. **WebSocket gateway** for non-Unix systems (Windows support)
3. **gRPC fallback** for cross-machine subagent communication
4. **Service mesh** for automatic service discovery
5. **Metrics export** to Prometheus/DataDog

---

## 10. Testing Strategy

```typescript
// Unit tests
rpc/router.test.ts        // Message routing logic
rpc/registry.test.ts      // Service registration
rpc/server.test.ts       // JSON-RPC parsing

// Integration tests (require tmux)
rpc/tmux-bridge.test.ts   // Session creation/deletion
rpc/e2e.test.ts          // Full spawn → call → kill flow
```

---

*End of Technical Specification*