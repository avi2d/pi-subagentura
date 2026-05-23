# RPC Mode Documentation

RPC mode enables subagents to run as isolated tmux sessions with bidirectional JSON-RPC 2.0 communication over Unix Domain Sockets. This provides process isolation, debuggability, and fault tolerance.

## Table of Contents

1. [Overview](#1-overview)
2. [How to Enable/Use](#2-how-to-enableuse)
3. [Tool Reference](#3-tool-reference)
4. [Graceful Shutdown Protocol (C-1)](#4-graceful-shutdown-protocol-c-1)
5. [Heartbeat Mechanism (C-4)](#5-heartbeat-mechanism-c-4)
6. [Backpressure Signaling (C-5)](#6-backpressure-signaling-c-5)
7. [Observability and Logging (O-1)](#7-observability-and-logging-o-1)
8. [Orphan Cleanup Schedule (O-2)](#8-orphan-cleanup-schedule-o-2)
9. [Signal Handling (E-4)](#9-signal-handling-e-4)
10. [Concurrent Call Behavior (E-5)](#10-concurrent-call-behavior-e-5)
11. [Debugging Instructions](#11-debugging-instructions)
12. [Parent Restart Recovery (E-2)](#12-parent-restart-recovery-e-2)
13. [Troubleshooting Guide](#13-troubleshooting-guide)
14. [Examples](#14-examples)

---

## 1. Overview

RPC mode provides remote procedure call capabilities between the main agent and subagents running in isolated tmux sessions. Each subagent runs in its own tmux session, exposing RPC endpoints via Unix Domain Sockets.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Main Agent Process                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Job Registry                               ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         ││
│  │  │ Job-A (tmux) │  │ Job-B (tmux) │  │ Job-C (tmux) │         ││
│  │  │ :8081/sock │  │ :8082/sock │  │ :8083/sock │         ││
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         ││
│  │         │                │                │                    ││
│  │         └────────────────┴────────────────┘                    ││
│  │                          │                                      ││
│  │              RPC Router / Message Broker                       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Key Benefits

- **Isolation**: Crash in one subagent doesn't corrupt parent or siblings
- **Debugging**: Attach `tmux attach -t <session>` to inspect any subagent live
- **Resource Limits**: Can apply per-subagent memory/CPU limits via cgroups (future)
- **Performance**: Unix sockets avoid TCP overhead (~0.5ms latency)

### System Requirements

- Node.js >= 18.0.0
- tmux >= 3.0
- Unix-like OS (Linux, macOS) - Unix socket support required

---

## 2. How to Enable/Use

### Prerequisites

RPC mode requires tmux to be installed on the system.

**macOS:**
```bash
brew install tmux
```

**Ubuntu/Debian:**
```bash
sudo apt-get install tmux
```

**CentOS/RHEL:**
```bash
sudo yum install tmux
```

### Usage

RPC mode is automatically available when tmux is installed. The 4 RPC tools appear alongside the existing subagent tools:

1. `spawn_rpc_subagent` - Spawn an isolated tmux subagent with RPC capability
2. `call_subagent_rpc` - Call a method on a remote RPC subagent
3. `list_rpc_subagents` - List all active RPC subagents
4. `kill_rpc_subagent` - Terminate an RPC subagent

### Socket Directory

RPC sockets are stored in `/tmp/pi-subagentura/` with permissions `0700` (owner-only access).

Socket path convention: `/tmp/pi-subagentura/<jobId>.sock`

### Tmux Session Naming

Sessions are named using the pattern: `pi-subagentura:<jobId>`

Example: `pi-subagentura:a1b2c3d4e5f67890`

---

## 3. Tool Reference

### 3.1 spawn_rpc_subagent

Spawns a subagent in an isolated tmux session with RPC capability.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | string | Yes | Task to delegate to the sub-agent |
| `persona` | string | No | Optional system prompt |
| `model` | string | No | Model override (e.g., `anthropic/claude-sonnet-4-5`) |
| `cwd` | string | No | Working directory override |
| `expose` | string[] | No | List of tools to expose via RPC (default: all public tools) |
| `timeout` | number | No | Max execution time in ms (default: no limit) |

**Returns:**
```typescript
{
  jobId: string;          // Unique job identifier
  socketPath: string;    // Unix socket path for communication
  exposedTools: string[]; // List of exposed RPC methods
  correlationId: string;  // Correlation ID for request tracking
  message: string;        // Human-readable status message
}
```

**Example:**
```typescript
// Spawn a simple RPC subagent
const result = await callTool("spawn_rpc_subagent", {
  task: "Analyze the code in /src for security issues",
  persona: "You are a security-focused code reviewer"
});

// Result:
// {
//   jobId: "abc123def456",
//   socketPath: "/tmp/pi-subagentura/abc123def456.sock",
//   exposedTools: ["agent.prompt", "agent.status", "tools.list", "tools.execute"],
//   correlationId: "xyz789",
//   message: "RPC subagent abc123def456 started in tmux session pi-subagentura:abc123def456"
// }
```

---

### 3.2 call_subagent_rpc

Calls a method on a remote RPC subagent.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `jobId` | string | Yes | Target subagent job ID |
| `method` | string | Yes | RPC method name (e.g., `agent.prompt`) |
| `params` | object | No | Method parameters as key-value object |
| `timeout` | number | No | Call timeout in ms (default: 30000) |

**Returns:**
```typescript
{
  result: unknown;       // Method return value
  correlationId?: string; // Correlation ID for request tracking
}
```

**Default RPC Methods:**

| Method | Description | Parameters |
|--------|-------------|------------|
| `agent.prompt` | Execute a prompt | `{ prompt: string, persona?: string }` |
| `agent.status` | Get agent status | `{}` |
| `tools.list` | List available tools | `{}` |
| `tools.execute` | Execute a tool | `{ name: string, args: Record<string, unknown> }` |

**Example:**
```typescript
// Call agent.prompt on a remote subagent
const result = await callTool("call_subagent_rpc", {
  jobId: "abc123def456",
  method: "agent.prompt",
  params: {
    prompt: "What files were modified in this commit?",
    persona: "You are a code analysis assistant"
  }
});
```

---

### 3.3 list_rpc_subagents

Lists all active RPC subagents.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `filter` | string | No | Filter by jobId substring |

**Returns:**
```typescript
{
  subagents: Array<{
    jobId: string;
    status: "running" | "done" | "error" | "dead";
    socketPath: string;
    exposedTools: string[];
    startedAt: number;  // Unix timestamp
  }>;
}
```

**Example:**
```typescript
// List all RPC subagents
const result = await callTool("list_rpc_subagents", {});

// List with filter
const filtered = await callTool("list_rpc_subagents", {
  filter: "abc123"
});
```

---

### 3.4 kill_rpc_subagent

Terminates an RPC subagent and cleans up its tmux session.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `jobId` | string | Yes | Subagent job ID to terminate |
| `force` | boolean | No | Force kill without graceful shutdown (default: false) |

**Returns:**
```typescript
{
  jobId: string;
  killed: boolean;
}
```

**Example:**
```typescript
// Graceful kill (tries session.shutdown first)
await callTool("kill_rpc_subagent", {
  jobId: "abc123def456"
});

// Force kill (immediate tmux kill-session)
await callTool("kill_rpc_subagent", {
  jobId: "abc123def456",
  force: true
});
```

---

## 4. Graceful Shutdown Protocol (C-1)

The graceful shutdown protocol ensures subagents can cleanly terminate, flush buffers, and acknowledge shutdown before process exit.

### Shutdown Sequence

```
Main Agent                          Subagent
    │                                  │
    │──session.shutdown───────────────>│
    │    correlationId: "abc123"       │
    │                                  │
    │                          ┌───────▼────────┐
    │                          │ 1. Log shutdown│
    │                          │ 2. Flush state │
    │                          │ 3. Send ack     │
    │                          └───────┬───────┘
    │<──session.shutdown.ack──────────┤
    │    jobId: "subagent-job"         │
    │    correlationId: "abc123"       │
    │                                  │
    │──(5s max wait)──────────────────>│
    │    (subagent exits)              │
    │                                  │
    │──kill-session───────────────────>│
    │    (if not already dead)         │
```

### Implementation Details

**In `kill-rpc.ts`:**
1. Send `session.shutdown` notification via RPC
2. Wait up to 5 seconds for acknowledgment
3. If `force: true`, skip to step 5
4. If graceful fails, fall through to force kill

**In `subagent-rpc-client.ts`:**
1. Receive `session.shutdown` notification
2. Log shutdown initiation
3. Send `session.shutdown.ack` notification back to parent
4. Perform cleanup (flush buffers, close connections)
5. Call `process.exit(0)`

### RPC Error Codes (Graceful Shutdown)

| Code | Name | Description |
|------|------|-------------|
| `-32000` | Timeout | Shutdown acknowledgment timeout |
| `-32002` | SessionNotFound | Target session doesn't exist |

### Example

```typescript
// Graceful shutdown - waits for acknowledgment
await callTool("kill_rpc_subagent", {
  jobId: "abc123",
  force: false  // default
});

// Force shutdown - no waiting
await callTool("kill_rpc_subagent", {
  jobId: "abc123",
  force: true
});
```

---

## 5. Heartbeat Mechanism (C-4)

The heartbeat mechanism monitors subagent liveness. Each subagent sends periodic pings, and missing responses marks the subagent as dead.

### Constants

```typescript
HEARTBEAT_CONSTANTS = {
  INTERVAL_MS: 10_000,    // Ping every 10 seconds
  TIMEOUT_MS: 30_000,     // Pong must arrive within 30 seconds
  MAX_MISSED: 3           // Mark dead after 3 missed pongs
};
```

### Heartbeat Flow

```
Parent                                Subagent
  │                                      │
  │──session.heartbeat──────────────────>│
  │    seq: 0                            │
  │    correlationId: "xyz"              │
  │                                      │
  │<───────────────────pong───────────────│
  │    seq: 0                            │
  │    correlationId: "xyz"              │
  │                                      │
  │──session.heartbeat──────────────────>│
  │    seq: 1                            │
  │                                      │
  │<───────────────────pong───────────────│
  │    seq: 1                            │
  │                                      │
  │        ... (every 10s) ...          │
  │                                      │
  │──session.heartbeat──────────────────>│
  │    seq: 3                            │
  │                                      │
  │    (no response after 30s)           │
  │                                      │
  │  [subagent marked as "dead"]        │
```

### Implementation

**In `router.ts` (`startHeartbeat`):**
1. Start interval timer (every 10 seconds)
2. On each tick, send `session.heartbeat` ping to subagent
3. Track sequence number (`seq`)
4. On successful pong, reset `missed` counter
5. On timeout (>30s without pong), increment `missed`
6. After 3 missed pongs (`MAX_MISSED`), mark subagent as dead
7. Call `registry.updateStatus(jobId, 'dead')`

**In `subagent-rpc-client.ts`:**
1. Register `session.heartbeat` handler
2. Return pong with same `seq` number
3. Log heartbeat activity

### RPC Heartbeat Types

```typescript
interface HeartbeatPing {
  jsonrpc: "2.0";
  method: "session.heartbeat";
  params: {
    seq: number;
    correlationId?: string;
  };
}

interface HeartbeatPong {
  jsonrpc: "2.0";
  method: "session.heartbeat";
  params: {
    seq: number;
    correlationId?: string;
  };
}
```

---

## 6. Backpressure Signaling (C-5)

Backpressure signaling prevents the parent from overwhelming subagents with requests when buffers fill up.

### Stream Constants

```typescript
STREAM_CONSTANTS = {
  CHUNK_SIZE: 64 * 1024,       // 64KB chunks for streaming responses
  MAX_BUFFERED_CHUNKS: 16,       // Backpressure threshold: pause after 16 chunks (1MB)
  STREAM_HIGH_WATER: 16,        // Resume when buffer drops to this level
};
```

### Stream Chunk Message

```typescript
interface StreamChunk {
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
```

### Stream Control Message

```typescript
interface StreamControl {
  jsonrpc: "2.0";
  method: "stream.control";
  params: {
    streamId: string;
    action: "pause" | "resume" | "cancel";
    correlationId?: string;
  };
}
```

### Backpressure Flow

```
Parent                                  Subagent
  │                                        │
  │───call────────────────────────────────>│
  │     method: "agent.prompt"              │
  │     params: { largeInput: "..." }       │
  │                                        │
  │<─────────────────────────chunk─────────│
  │     stream.chunk (index 0)             │
  │                                        │
  │<─────────────────────────chunk─────────│
  │     stream.chunk (index 1)             │
  │     ...                                 │
  │                                        │
  │<─────────────────────────chunk─────────│
  │     stream.chunk (index 15)  [FULL]    │
  │                                        │
  │     (buffer at MAX_BUFFERED_CHUNKS)     │
  │                                        │
  │────stream.control──────────────────────>│
  │       action: "pause"                  │
  │                                        │
  │     (parent pauses sending requests)   │
  │                                        │
  │────stream.control──────────────────────>│
  │       action: "resume"                 │
  │       (after buffer drains)            │
```

### Implementation

**In `router.ts`:**
1. Track buffered chunks per subagent
2. When buffer reaches `MAX_BUFFERED_CHUNKS`, pause new requests
3. Send `stream.control` with `action: "pause"`
4. When buffer drains to `STREAM_HIGH_WATER`, resume
5. Send `stream.control` with `action: "resume"`

---

## 7. Observability and Logging (O-1)

RPC mode emits structured log events for monitoring and debugging.

### Log Event Format

```typescript
interface LogEvent {
  timestamp: number;           // Unix timestamp (ms)
  level: "debug" | "info" | "warn" | "error";
  event: string;               // Event name
  correlationId?: string;      // Request correlation ID
  jobId?: string;              // Job ID if applicable
  data?: Record<string, unknown>; // Additional context
}
```

### Log Levels

| Level | Usage |
|-------|-------|
| `debug` | Detailed debugging info (method calls, params, responses) |
| `info` | General operational events (spawn, kill, connect, disconnect) |
| `warn` | Non-critical issues (retries, timeouts, hook failures) |
| `error` | Failures requiring attention (connection refused, crashes) |

### Log Events

| Event | Level | Description |
|-------|-------|-------------|
| `tool_call` | info | RPC tool invoked |
| `spawn` | info | New RPC subagent spawned |
| `kill` | info | RPC subagent terminated |
| `connect` | info | Socket connection established |
| `disconnect` | info | Socket connection closed |
| `heartbeat` | debug | Heartbeat ping/pong sent |
| `heartbeat.timeout` | warn | Heartbeat response timeout |
| `shutdown` | info | Graceful shutdown initiated |
| `shutdown.ack` | debug | Shutdown acknowledgment received |
| `orphan.cleanup` | info | Orphaned session cleaned up |

### JSON Output

Logs are written to stderr as JSON objects:

```json
{"timestamp":1700000000000,"level":"info","event":"spawn","jobId":"abc123","data":{"socketPath":"/tmp/pi-subagentura/abc123.sock"}}
{"timestamp":1700000001000,"level":"debug","event":"heartbeat","jobId":"abc123","data":{"seq":0}}
{"timestamp":1700000005000,"level":"warn","event":"heartbeat.timeout","jobId":"abc123","data":{"missed":1}}
```

### Accessing Logs

```bash
# View logs from pi agent
tail -f /tmp/pi-agent-*.log

# Search for RPC events
grep '"event":"spawn"' /tmp/pi-agent-*.log

# Filter by jobId
grep '"jobId":"abc123"' /tmp/pi-agent-*.log
```

---

## 8. Orphan Cleanup Schedule (O-2)

Orphan cleanup detects and removes zombie tmux sessions that are no longer tracked by the registry.

### Detection Logic

1. List all tmux sessions matching `pi-subagentura:*`
2. Compare against RPC registry entries
3. Sessions in tmux but not in registry are orphans

### Cleanup Schedule

| Phase | Timing | Description |
|-------|--------|-------------|
| Initial | On startup | Clean existing orphans immediately |
| Periodic | Every 5 minutes | Run cleanup sweep |

### Implementation

**In `tmux-bridge.ts`:**
```typescript
startOrphanCleanup(registryJobIdsFn: () => Set<string>): void {
  // Initial cleanup on startup
  this.cleanupOrphans(registryJobIdsFn()).catch(console.error);

  // Periodic cleanup every 5 minutes
  this.orphanCleanupInterval = setInterval(async () => {
    await this.cleanupOrphans(registryJobIdsFn());
  }, 5 * 60 * 1000);
}
```

### Manual Cleanup

```bash
# List all pi-subagentura sessions
tmux list-sessions -F '#{session_name}' | grep pi-subagentura

# Kill a specific orphan
tmux kill-session -t pi-subagentura:orphan-job-id

# Kill all pi-subagentura sessions (use with caution)
for session in $(tmux list-sessions -F '#{session_name}' | grep pi-subagentura); do
  tmux kill-session -t "$session"
done
```

### Reasons for Orphans

1. **Parent crash**: Parent process died without killing subagents
2. **Network partition**: Parent couldn't reach subagent for extended period
3. **tmux server restart**: tmux server crashed, sessions became detached
4. **Manual intervention**: User killed parent but not subagents

---

## 9. Signal Handling (E-4)

Subagents handle OS signals to ensure graceful shutdown and proper cleanup.

### Signal Types Handled

| Signal | Description | Action |
|--------|-------------|--------|
| `SIGTERM` | Termination request | Graceful shutdown, exit 0 |
| `SIGINT` | Interrupt (Ctrl+C) | Graceful shutdown, exit 0 |
| `SIGHUP` | Hang up | Graceful shutdown, exit 0 |

### Signal Handler Implementation

**In `subagent-rpc-client.ts`:**
```typescript
function setupSignalHandlers(client: RpcClient): void {
  const shutdown = async (signal: string): Promise<void> => {
    log('info', `Received ${signal}, initiating graceful shutdown`);

    try {
      // Notify parent of shutdown initiation
      await client.sendNotification('session.shutdown.starting', {
        jobId: currentJobId,
        signal
      });
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
```

### Shutdown Sequence on Signal

```
1. Signal received
2. Log shutdown initiation
3. Send session.shutdown.starting notification to parent
4. Flush any pending writes
5. Close RPC connection
6. process.exit(0)
```

### Parent Signal Propagation

When the parent receives a signal (e.g., user presses Ctrl+C):
1. Parent initiates graceful shutdown of all RPC subagents
2. Parent waits for acknowledgments (up to 5 seconds each)
3. Parent sends SIGTERM to any remaining subagent tmux sessions
4. Parent exits

---

## 10. Concurrent Call Behavior (E-5)

RPC mode handles concurrent calls to the same subagent using connection pooling and request multiplexing.

### Connection Behavior

| Scenario | Behavior |
|----------|----------|
| First call to jobId | Create new socket connection |
| Subsequent calls to same jobId | Reuse existing connection |
| Connection lost | Retry with exponential backoff (3 attempts) |
| Max concurrent connections | No limit (but one per jobId) |

### Retry Logic

```typescript
const backoffMs = [100, 500, 1000];  // Exponential backoff

for (let attempt = 0; attempt < maxRetries; attempt++) {
  try {
    const result = await rpcRouter.call(jobId, method, params, timeout);
    return result;
  } catch (err) {
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, backoffMs[attempt]));
      await rpcRouter.connect(jobId, socketPath);
    }
  }
}
```

### Request Multiplexing

Since JSON-RPC 2.0 uses newline-delimited messages, multiple requests can be sent on the same connection:

```typescript
// These can be sent concurrently on the same socket
await Promise.all([
  callSubagentRpc({ jobId, method: "tools.list" }),
  callSubagentRpc({ jobId, method: "agent.status" }),
  callSubagentRpc({ jobId, method: "agent.prompt", params: { prompt: "task1" } }),
  callSubagentRpc({ jobId, method: "agent.prompt", params: { prompt: "task2" } }),
]);
```

### Request Correlation

Each request includes a `correlationId` for tracing:

```typescript
const request = {
  jsonrpc: "2.0",
  id: "unique-id",
  method: "agent.prompt",
  params: {
    prompt: "...",
    correlationId: "trace-id"  // For log correlation
  }
};
```

### Batch Requests

JSON-RPC 2.0 batch requests are supported:

```typescript
// Send batch request
const batch = [
  { jsonrpc: "2.0", id: 1, method: "agent.status", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools.list", params: {} }
];
// Send as newline-delimited JSON on socket
```

---

## 11. Debugging Instructions

### Attach to Tmux Session

To inspect a running RPC subagent:

```bash
# List all pi-subagentura sessions
tmux list-sessions -F '#{session_name}' | grep pi-subagentura

# Attach to a specific session
tmux attach -t pi-subagentura:<jobId>

# Example
tmux attach -t pi-subagentura:abc123def456

# If not in a terminal (tmux requires terminal):
# Use the send-keys feature
tmux send-keys -t pi-subagentura:abc123 'echo "debug checkpoint"' Enter
```

### Quick Session List

```bash
# Show all RPC subagent sessions with status
for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep pi-subagentura); do
  jobId="${session#pi-subagentura:}"
  panes=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null | wc -l)
  echo "$session (PID count: $panes)"
done
```

### Inspect Socket

```bash
# Check if socket exists
ls -la /tmp/pi-subagentura/*.sock

# Check socket permissions
stat /tmp/pi-subagentura/<jobId>.sock

# Test socket connectivity (requires netcat or socat)
nc -U /tmp/pi-subagentura/<jobId>.sock
```

### Debug Mode

Enable debug logging:

```bash
# Run pi with debug output
PI_LOG_LEVEL=debug pi

# Or filter for RPC events
PI_LOG_LEVEL=debug pi 2>&1 | grep -i rpc
```

### Manual RPC Call

Test RPC communication manually:

```bash
# Using socat (if available)
echo '{"jsonrpc":"2.0","id":"1","method":"agent.status","params":{}}' | socat - UNIX-CONNECT:/tmp/pi-subagentura/<jobId>.sock
```

### Common Debug Commands

| Command | Purpose |
|---------|---------|
| `tmux list-sessions` | List all tmux sessions |
| `tmux attach -t <session>` | Attach to session for live inspection |
| `tmux capture-pane -t <session>` | Capture current pane contents |
| `tmux send-keys -t <session> <cmd>` | Send command to session |
| `tmux kill-session -t <session>` | Kill a session |
| `ls -la /tmp/pi-subagentura/` | List socket files |
| `tail -f /tmp/pi-agent*.log` | Watch agent logs |

---

## 12. Parent Restart Recovery (E-2)

When the parent process restarts, RPC subagents from the previous session become orphaned and must be recovered or cleaned up.

### Recovery Options

#### Option 1: Automatic Cleanup (Default)

On startup, the parent runs orphan cleanup automatically:

```typescript
// In subagent.ts initialization
tmuxBridge.startOrphanCleanup(() => {
  const jobIds = new Set<string>();
  for (const entry of rpcRegistry.list()) {
    jobIds.add(entry.jobId);
  }
  return jobIds;
});
```

#### Option 2: Reconnect to Existing Subagents

To maintain running subagents across parent restarts:

1. Before restart, serialize the job registry
2. After restart, restore registry and reconnect sockets
3. Resume communication with existing subagents

```typescript
// Serialize on shutdown
const serializedRegistry = JSON.stringify([...rpcRegistry.list()]);

// Restore on startup
const entries = JSON.parse(serializedRegistry);
for (const entry of entries) {
  rpcRegistry.register(entry);
  // Reconnect to socket
  await rpcRouter.connect(entry.jobId, entry.socketPath);
}
```

#### Option 3: Graceful Handover

Use `session.shutdown` to cleanly terminate subagents before restart:

```bash
# Kill all RPC subagents gracefully before restart
pi-restart --graceful
```

### tmux Server Crash Recovery

If the tmux server crashes, sessions become detached. The recovery process:

1. Detect detached sessions via `tmux list-sessions`
2. Compare with registry
3. Kill orphaned sessions
4. Restart parent with clean state

```typescript
// Detect detached sessions
async detectDetachedSessions(registryJobIds: Set<string>): Promise<string[]> {
  const tmuxSessions = await this.listSessions();
  const detached: string[] = [];

  for (const jobId of registryJobIds) {
    const sessionName = `pi-subagentura:${jobId}`;
    if (!tmuxSessions.includes(sessionName)) {
      detached.push(jobId);
    }
  }
  return detached;
}
```

---

## 13. Troubleshooting Guide

### Common Issues

#### Issue: "tmux is not installed"

**Symptoms:**
```
Error: tmux is not installed. RPC mode requires tmux.
```

**Solution:**
```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux

# CentOS/RHEL
sudo yum install tmux
```

#### Issue: "Session not found"

**Symptoms:**
```
Error: Session not found: abc123def456
```

**Possible Causes:**
1. Subagent already terminated
2. Wrong jobId used
3. Registry out of sync with tmux

**Solutions:**
```typescript
// List all subagents to verify jobId
const subagents = await callTool("list_rpc_subagents", {});

// Check tmux sessions
tmux list-sessions -F '#{session_name}' | grep pi-subagentura

// Force cleanup if orphaned
tmux kill-session -t pi-subagentura:abc123def456
```

#### Issue: "Connection refused"

**Symptoms:**
```
Error: connect ECONNREFUSED /tmp/pi-subagentura/abc123.sock
```

**Possible Causes:**
1. Subagent not yet ready
2. Socket file deleted prematurely
3. Permission issue on socket directory

**Solutions:**
```bash
# Check socket directory permissions
ls -la /tmp/pi-subagentura/

# Recreate directory if needed
mkdir -m 700 /tmp/pi-subagentura

# Wait longer before reconnecting
```

#### Issue: "RPC call timeout"

**Symptoms:**
```
Error: RPC timeout: agent.prompt for job abc123
```

**Possible Causes:**
1. Subagent hung or stuck
2. Network/latency issue
3. Subagent processing long-running task

**Solutions:**
```typescript
// Increase timeout
await callTool("call_subagent_rpc", {
  jobId: "abc123",
  method: "agent.prompt",
  params: { prompt: "..." },
  timeout: 60000  // 60 seconds
});

// Or kill and respawn
await callTool("kill_rpc_subagent", { jobId: "abc123", force: true });
```

#### Issue: "Heartbeat timeout - subagent dead"

**Symptoms:**
```
Warning: Subagent abc123 did not send ready notification within 5s
```

**Possible Causes:**
1. Subagent process died immediately after spawn
2. esbuild build failed
3. Entry script error

**Solutions:**
```bash
# Attach to session to see error
tmux attach -t pi-subagentura:abc123

# Check pane contents
tmux capture-pane -t pi-subagentura:abc123

# Rebuild entry script manually
cd /path/to/project
npx esbuild entry/subagent-rpc-client.ts --outfile=entry/subagent-rpc-client.js --platform=node --target=node18 --format=cjs
```

#### Issue: "Socket directory permissions incorrect"

**Symptoms:**
```
Error: Socket directory permissions incorrect: 40755
```

**Solution:**
```bash
# Fix permissions
chmod 700 /tmp/pi-subagentura

# Verify
ls -la /tmp/ | grep pi-subagentura
# Should show: drwx------ (0700)
```

#### Issue: "Method not found"

**Symptoms:**
```
Error: Method not found: custom.method
```

**Solution:**
The subagent only exposes default methods unless custom handlers are registered. Use the default methods:
- `agent.prompt`
- `agent.status`
- `tools.list`
- `tools.execute`

#### Issue: Zombie Sessions

**Symptoms:**
Sessions exist in tmux but not in registry, causing conflicts on respawn.

**Solution:**
```bash
# List all pi-subagentura sessions
tmux list-sessions -F '#{session_name}' | grep pi-subagentura

# Kill zombie sessions manually
tmux kill-session -t pi-subagentura:zombie-job-id

# Or use the cleanup command
pi-cleanup-orphans
```

### Debug Checklist

1. **Verify tmux is installed:**
   ```bash
   tmux -V
   ```

2. **Check socket directory:**
   ```bash
   ls -la /tmp/pi-subagentura/
   ```

3. **List active sessions:**
   ```bash
   tmux list-sessions -F '#{session_name}'
   ```

4. **Attach to session for live debugging:**
   ```bash
   tmux attach -t pi-subagentura:<jobId>
   ```

5. **Check agent logs:**
   ```bash
   tail -100 /tmp/pi-agent*.log | grep rpc
   ```

6. **Test socket connectivity:**
   ```bash
   nc -U /tmp/pi-subagentura/<jobId>.sock
   ```

---

## 14. Examples

### Example 1: Basic RPC Spawn and Call

```typescript
// Spawn an RPC subagent
const spawnResult = await callTool("spawn_rpc_subagent", {
  task: "Review the security of this authentication module",
  persona: "You are a security-focused code reviewer"
});

console.log("Spawned:", spawnResult.details.jobId);

// Call methods on the subagent
const statusResult = await callTool("call_subagent_rpc", {
  jobId: spawnResult.details.jobId,
  method: "agent.status"
});

const toolsResult = await callTool("call_subagent_rpc", {
  jobId: spawnResult.details.jobId,
  method: "tools.list"
});

// Execute a prompt
const promptResult = await callTool("call_subagent_rpc", {
  jobId: spawnResult.details.jobId,
  method: "agent.prompt",
  params: {
    prompt: "List the main security concerns in OAuth2 implementations",
    persona: "You are a security expert"
  }
});

// Cleanup
await callTool("kill_rpc_subagent", {
  jobId: spawnResult.details.jobId
});
```

### Example 2: Concurrent Subagents

```typescript
// Spawn multiple subagents in parallel
const jobIds = await Promise.all([
  callTool("spawn_rpc_subagent", {
    task: "Analyze /src/api for performance issues",
    persona: "You are a performance analyst"
  }),
  callTool("spawn_rpc_subagent", {
    task: "Analyze /src/db for query optimization opportunities",
    persona: "You are a database expert"
  }),
  callTool("spawn_rpc_subagent", {
    task: "Analyze /src/security for vulnerabilities",
    persona: "You are a security auditor"
  })
]);

// Wait for all to complete
const results = await Promise.all(
  jobIds.map(j => callTool("call_subagent_rpc", {
    jobId: j.details.jobId,
    method: "agent.prompt",
    params: { prompt: "Provide your analysis summary" }
  }))
);

// Aggregate results
console.log("All analyses complete:", results);

// Cleanup all
for (const j of jobIds) {
  await callTool("kill_rpc_subagent", { jobId: j.details.jobId });
}
```

### Example 3: Monitoring Subagent Health

```typescript
// Spawn with timeout
const spawnResult = await callTool("spawn_rpc_subagent", {
  task: "Run long-running data analysis",
  timeout: 300000  // 5 minute timeout
});

// Periodically check status
let isRunning = true;
while (isRunning) {
  const status = await callTool("call_subagent_rpc", {
    jobId: spawnResult.details.jobId,
    method: "agent.status"
  });
  
  if (status.result.status !== "running") {
    isRunning = false;
  } else {
    console.log("Still running...");
    await sleep(10000);  // Wait 10 seconds
  }
}

// Get final result
const finalResult = await callTool("call_subagent_rpc", {
  jobId: spawnResult.details.jobId,
  method: "agent.prompt",
  params: { prompt: "Return your final analysis" }
});
```

### Example 4: Error Recovery

```typescript
async function robustCall(jobId: string, method: string, params?: object) {
  const maxRetries = 3;
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callTool("call_subagent_rpc", {
        jobId,
        method,
        params,
        timeout: 30000
      });
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt + 1} failed:`, err.message);
      
      if (err.message.includes("Session not found")) {
        throw new Error(`Subagent ${jobId} no longer exists`);
      }
      
      if (attempt < maxRetries - 1) {
        await sleep(500 * Math.pow(2, attempt));  // Exponential backoff
      }
    }
  }
  
  throw lastError;
}

// Usage
try {
  const result = await robustCall("abc123", "agent.prompt", {
    prompt: "What is the status?"
  });
} catch (err) {
  console.error("All retries exhausted:", err.message);
  // Consider respawning or alerting
}
```

### Example 5: Debugging Session Attach

```bash
#!/bin/bash
# Debug script to attach to RPC subagent

JOB_ID=$1
if [ -z "$JOB_ID" ]; then
  echo "Usage: $0 <jobId>"
  exit 1
fi

SESSION_NAME="pi-subagentura:$JOB_ID"

echo "=== Session Info ==="
tmux list-sessions | grep "$SESSION_NAME" || echo "Session not found"

echo ""
echo "=== Last 20 Lines of Pane ==="
tmux capture-pane -t "$SESSION_NAME" -p -20 2>/dev/null || echo "Could not capture pane"

echo ""
echo "=== Attach with: ==="
echo "tmux attach -t $SESSION_NAME"
echo ""
echo "=== Send test command: ==="
echo "tmux send-keys -t $SESSION_NAME 'echo test' Enter"
```

---

## Appendix A: RPC Error Codes

| Code | Name | Description |
|------|------|-------------|
| `-32700` | Parse error | Invalid JSON received |
| `-32600` | Invalid Request | Batch request empty |
| `-32601` | MethodNotFound | RPC method doesn't exist |
| `-32602` | InvalidParams | Invalid method parameters |
| `-32603` | InternalError | Internal RPC error |
| `-32000` | Timeout | RPC call timeout |
| `-32001` | ConnectionRefused | Socket connection refused |
| `-32002` | SessionNotFound | tmux session not found |
| `-32003` | RequestTooLarge | Request exceeds 10MB limit |
| `-32004` | InvalidMethodName | Method name contains invalid characters |
| `-32005` | SubagentDead | Subagent heartbeat timeout |

## Appendix B: File Structure

```
pi-subagentura/
├── subagent.ts              # Extension entry point, tool registrations
├── helpers.ts               # Shared helpers
├── rpc/
│   ├── mod.ts              # RPC module barrel export
│   ├── types.ts           # RpcSubagentJob, RpcRequest, RpcResponse
│   ├── router.ts          # RpcRouter class
│   ├── server.ts          # JsonRpcServer class
│   ├── transport.ts       # UnixSocketTransport class
│   ├── registry.ts        # RpcServiceRegistry class
│   └── tmux-bridge.ts     # TmuxProcessBridge class
├── tools/
│   ├── mod.ts            # Re-exports all tools
│   ├── spawn-rpc.ts      # spawn_rpc_subagent tool
│   ├── call-rpc.ts       # call_subagent_rpc tool
│   ├── list-rpc.ts       # list_rpc_subagents tool
│   └── kill-rpc.ts       # kill_rpc_subagent tool
└── entry/
    └── subagent-rpc-client.ts  # Entry script for tmux subagents
```

---

*End of RPC Mode Documentation*