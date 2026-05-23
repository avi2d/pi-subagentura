# Specification: RPC Mode with Tmux/Sugabent for Subagent Communication

## Context

The existing `pi-subagentura` extension spawns sub-agents **in-process** via `createAgentSession()` — all sub-agents run in the same Node.js process, communicate only via serialized conversation text, and the parent coordinates by collecting results after completion.

This specification defines an **alternative RPC execution mode** where sub-agents run as separate OS processes via tmux, can communicate with each other bidirectionally, and the parent can route/mediate their communication.

---

## 1. Requirements

### 1.1 Functional Requirements

| ID | Requirement | Description |
|----|-------------|-------------|
| FR-1.1 | New Execution Mode | Provide a `mode` parameter accepting `"inprocess"` (default) or `"rpc"` (new) |
| FR-1.2 | Tmux Spawning | In RPC mode, spawn each sub-agent as a separate tmux session via sugabent |
| FR-1.3 | RPC Endpoint | Each RPC-mode sub-agent exposes a UNIX domain socket for RPC calls |
| FR-1.4 | Discoverability | Parent can list active RPC sub-agents and their socket addresses |
| FR-2.1 | Inter-Subagent Calls | Sub-agents can send RPC calls to other sub-agents directly |
| FR-2.2 | Pub/Sub Events | Sub-agents can emit events that others can subscribe to |
| FR-2.3 | Message Routing | Parent can route messages between sub-agents |
| FR-2.4 | Bidirectional Streaming | Sub-agents can stream partial results in real-time |
| FR-3.1 | Lifecycle Management | Parent can start, monitor, cancel, and clean up RPC sub-agents |
| FR-3.2 | Session Cleanup | RPC sub-agents must clean up their tmux sessions on completion/error |
| FR-3.3 | Async Job Support | Existing async job workflow (`get_subagent_status`, `get_subagent_result`, `cancel_subagent`) works for RPC mode |
| FR-3.4 | Crash Isolation | RPC sub-agent crashes must not crash the parent process |
| FR-4.1 | Backward Compatibility | Default in-process behavior unchanged; no breaking changes |
| FR-4.2 | Existing Tools Work | `subagent_with_context`, `subagent_isolated` continue unchanged |
| FR-4.3 | Opt-in Mode | RPC mode is opt-in only |
| FR-5.1 | Sugabent Integration | Use sugabent as the tmux abstraction layer |
| FR-5.2 | Dependency | Sugabent added as a dependency |
| FR-5.3 | Configurable Transport | RPC transport layer configurable |

### 1.2 Non-Functional Requirements

| ID | Requirement | Description |
|----|-------------|-------------|
| NFR-1.1 | Low Latency | RPC call latency < 50ms for local UNIX sockets |
| NFR-1.2 | Fast Startup | Sub-agent startup in RPC mode < 2 seconds |
| NFR-1.3 | Memory Isolation | Separate V8 heap per sub-agent |
| NFR-2.1 | Fault Tolerance | Crashed RPC sub-agent does not crash/hang parent |
| NFR-2.2 | Crash Detection | Parent detects sub-agent crashes via tmux exit notification |
| NFR-2.3 | Orphan Cleanup | Orphaned tmux sessions garbage collected |
| NFR-3.1 | Status Channel | RPC sub-agents surface live status to parent |
| NFR-3.2 | Error Logging | RPC errors logged with context (jobId, method, error) |
| NFR-3.3 | Debug Coverage | Existing `SUBAGENT_DEBUG_LOG_DIR` covers RPC operations |
| NFR-4.1 | Socket Permissions | UNIX sockets use restricted permissions (chmod 700) |
| NFR-4.2 | Command Isolation | Sub-agents cannot execute arbitrary commands outside allocated session |
| NFR-5.1 | tmux Requirement | Fail gracefully with clear error if tmux absent |
| NFR-5.2 | Cross-Platform | Works on Linux and macOS |
| NFR-6.1 | Intuitive API | Minimal learning curve for existing users |
| NFR-6.2 | Actionable Errors | Error messages guide toward resolution |

### 1.3 Implicit Requirements

| ID | Requirement | Description |
|----|-------------|-------------|
| IR-1.1 | System Dependency | tmux must be installed |
| IR-1.2 | Library Dependency | sugabent added as project dependency |
| IR-2.1 | Agent Bootstrap | Sub-agents need entrypoint script for RPC socket connection |
| IR-2.2 | Protocol Handshake | Bootstrap handles RPC protocol handshake, message loop, result reporting |
| IR-3.1 | RPC Protocol | JSON-RPC 2.0 used for all RPC communication |
| IR-3.2 | Protocol Features | Support method calls, notifications, and streaming |
| IR-3.3 | Method Schema | Schema defined for subagent-specific methods |
| IR-4.1 | Process Supervision | Parent implements process supervision (crash detection, reaping) |
| IR-5.1 | Serialization | Objects passed between sub-agents serialized as JSON |
| IR-6.1 | Configuration | RPC mode configurable via env vars or config object |
| IR-7.1 | Registry Separation | RPC sub-agents use separate registry from in-process sessions |

### 1.4 Out of Scope

- Distributed/multi-host sub-agents
- TLS/mTLS for RPC transport
- Sub-agent-to-sub-agent authentication
- Horizontal scaling of parent agent
- Persistent sub-agents (daemon-style)
- WebAssembly or container-based isolation
- Built-in load balancing
- Graphical UI for topology visualization
- Sub-agent registry/service-discovery service
- Replacing in-process mode entirely

---

## 2. Tech Stack Decisions

### 2.1 Core Technologies

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Process Isolation | **tmux** | Native multiplexor, available on Linux/macOS; enables separate sessions per subagent |
| RPC Protocol | **JSON-RPC 2.0 over Unix Domain Sockets** | Simple, language-agnostic; avoids HTTP overhead; filesystem permissions for security |
| Message Serialization | **TypeScript-native JSON** | Leverages existing patterns; no additional deps |
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
│  • Tool definitions (RPC spawn, call, list, kill)                │
│  • Schema definitions (TypeBox)                                   │
│  • Render functions (TUI output)                                 │
└──────────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────────────────────────────────────────┐
│                      Application Layer                            │
│  • TmuxSessionManager: spawn/kill tmux sessions                  │
│  • RpcRouter: message routing between subagents                 │
│  • JobLifecycle: async job state transitions                     │
└──────────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────────────────────────────────────────┐
│                      RPC Infrastructure Layer                    │
│  • JsonRpcServer: handles JSON-RPC requests                       │
│  • UnixSocketTransport: accepts connections, manages sockets     │
│  • ServiceRegistry: tracks exposed methods per subagent           │
└──────────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────────────────────────────────────────┐
│                      Tmux Integration Layer                      │
│  • TmuxProcessBridge: spawns Node.js scripts in tmux panes      │
│  • SocketLifecycle: creates/deletes Unix socket files             │
│  • SessionLifecycle: create/attach/detach tmux sessions          │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Execution Modes

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
│   ├── mod.ts                    # Re-exports all tools
│   ├── spawn-rpc.ts              # spawn_rpc_subagent tool
│   ├── call-rpc.ts               # call_subagent_rpc tool
│   ├── list-rpc.ts               # list_rpc_subagents tool
│   └── kill-rpc.ts              # kill_rpc_subagent tool
├── entry/
│   └── subagent-rpc-entry.ts     # Entry script for tmux-launched subagents
├── test/
│   ├── rpc.test.ts               # Integration tests
│   └── fixtures/
│       └── mock-rpc-agent.ts     # Mock agent for testing
└── docs/
    └── rpc-mode.md               # RPC mode documentation
```

---

## 5. Dependencies

### 5.1 New Dependencies

```json
{
  "dependencies": {
    "ws": "^8.18.0",
    "json-rpc-2": "^0.2.1"
  }
}
```

| Package | Version | Purpose |
|---------|---------|---------|
| `ws` | ^8.18.0 | WebSocket server for Unix socket adapter |
| `json-rpc-2` | ^0.2.1 | JSON-RPC 2.0 protocol implementation |

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

### 5.3 System Requirements

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
rpc/server.test.ts        // JSON-RPC parsing

// Integration tests (require tmux)
rpc/tmux-bridge.test.ts   // Session creation/deletion
rpc/e2e.test.ts           // Full spawn → call → kill flow
```

---

## Acceptance Criteria

1. **AC-1**: `spawn_rpc_subagent` creates a new tmux session and returns a valid jobId and socketPath
2. **AC-2**: `call_subagent_rpc` successfully sends a JSON-RPC request to a running RPC subagent and receives a response
3. **AC-3**: RPC subagents can call methods on other RPC subagents via the router
4. **AC-4**: `list_rpc_subagents` returns accurate list of active RPC subagents with correct status
5. **AC-5**: `kill_rpc_subagent` terminates the tmux session and cleans up the socket file
6. **AC-6**: A crashed RPC subagent does not crash or hang the parent agent
7. **AC-7**: All existing subagent tools continue to work without modification
8. **AC-8**: RPC mode fails gracefully with a clear error if tmux is not installed

---

## Requirement Coverage Map

| Requirement ID | Implementation File(s) |
|----------------|------------------------|
| FR-1.1 - FR-1.4 | `tools/spawn-rpc.ts`, `rpc/tmux-bridge.ts` |
| FR-2.1 - FR-2.4 | `rpc/router.ts`, `rpc/server.ts` |
| FR-3.1 - FR-3.4 | `rpc/tmux-bridge.ts`, `rpc/registry.ts` |
| FR-4.1 - FR-4.3 | All RPC files (backward compatible) |
| FR-5.1 - FR-5.3 | `rpc/tmux-bridge.ts`, `rpc/transport.ts` |
| NFR-1.1 - NFR-1.3 | Process isolation via tmux |
| NFR-2.1 - NFR-2.3 | `rpc/tmux-bridge.ts`, error handling |
| NFR-3.1 - NFR-3.3 | Status channel in `rpc/server.ts` |
| NFR-4.1 - NFR-4.2 | `rpc/transport.ts`, socket permissions |
| NFR-5.1 - NFR-5.2 | System check in `rpc/tmux-bridge.ts` |
| NFR-6.1 - NFR-6.2 | API design, error messages |
| IR-2.1 - IR-2.2 | `entry/subagent-rpc-entry.ts` |
| IR-3.1 - IR-3.3 | `rpc/types.ts`, `rpc/server.ts` |
| IR-4.1 | `rpc/tmux-bridge.ts` |
| IR-5.1 | JSON serialization (built-in) |
| IR-6.1 | Config via env vars |
| IR-7.1 | `rpc/registry.ts` (separate from existing) |
