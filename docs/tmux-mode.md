---
title: "Tmux Agent Mode"
keywords: [tmux, socket, ipc, multi-agent, subprocess, unix socket]
---

# Tmux Agent Mode

Spawn sub-agents in dedicated tmux windows with Unix domain socket IPC for parent↔subagent communication. Provides user visibility into agent execution.

## Architecture

```
┌─ pi (parent) ──────────────────────────────────────────────────────────────┐
│                                                                            │
│  createSocketServer() ──────────────────────────────────────────────────┐  │
│  │  Path: /tmp/pi-<uid>/agent-<uuid>.sock                              │  │
│  │  Mode: 0600 (user-only)                                             │  │
│  │                                                                      │  │
│  │  onMessage handler receives:                                        │  │
│  │    - progress (output stream)                                      │  │
│  │    - result (final output)                                           │  │
│  │    - error (error message)                                          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                   ▲                                        │
│                                   │ socket connection                       │
│  ┌─ tmux window: pi-agent-<uuid> ───────────────────────────────────┐   │
│  │                                                                      │   │
│  │  node tmux-agent-cli.js                                             │   │
│  │    │                                                                │   │
│  │    ├── Connects to parent socket                                    │   │
│  │    ├── Writes .ready marker                                         │   │
│  │    ├── Waits for task message                                       │   │
│  │    ├── Spawns: pi "<task>"                                          │   │
│  │    ├── Streams stdout via socket                                    │   │
│  │    └── Sends result/error on completion                             │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Unix Domain Sockets (not TCP)

| Aspect | Rationale |
|--------|-----------|
| **Path** | `/tmp/pi-<uid>/agent-<uuid>.sock` |
| **Permissions** | Mode 0600 (user-only read/write) |
| **Why not TCP** | Filesystem permissions protect access, no port conflicts |

### 2. Fresh pi Invocation

| Aspect | Rationale |
|--------|-----------|
| **How** | `tmux new-window -n <name> -c <cwd> node tmux-agent-cli.js ...` |
| **Why** | Clean slate, matches `subagent_isolated` semantics |
| **Visibility** | User sees live terminal output in tmux window |

### 3. Readiness Protocol

```
Subagent starts (tmux-agent-cli.js):
  1. Create socket directory: /tmp/pi-<uid>/
  2. Connect to parent socket
  3. Write readiness marker: /tmp/pi-<uid>/.ready
  4. Send progress: "[ready]"
  5. Wait for task message

Parent (tmux_spawn tool):
  1. Spawn tmux window with command
  2. Poll for .ready file (100ms intervals, 10s timeout)
  3. Wait for "[ready]" progress message
  4. Send task via JSON-RPC
  5. Stream progress updates via onUpdate callback
```

### 4. Socket Protocol (JSON-RPC 2.0)

**Parent → Subagent messages:**
```json
{ "jsonrpc": "2.0", "method": "task", "params": { "task": "..." }, "id": 1 }
{ "jsonrpc": "2.0", "method": "abort", "params": {}, "id": 2 }
{ "jsonrpc": "2.0", "method": "ping", "params": {}, "id": 3 }
```

**Subagent → Parent messages:**
```json
{ "jsonrpc": "2.0", "method": "progress", "params": { "output": "...", "turn": 1 }, "id": null }
{ "jsonrpc": "2.0", "method": "result", "params": { "output": "...", "usage": {...} }, "id": 1 }
{ "jsonrpc": "2.0", "method": "error", "params": { "message": "..." }, "id": 1 }
```

### 5. Lifecycle Ownership

| Phase | Action |
|-------|--------|
| **Create** | Parent creates tmux window, spawns subagent |
| **Run** | Subagent executes task, streams progress |
| **Complete** | Subagent sends `result`, exits cleanly |
| **Abort** | Parent sends `abort`, kills tmux window |
| **Timeout** | Parent disconnects after timeout, kills window |

### 6. Security

- Socket in user-specific temp dir (`/tmp/pi-<uid>/`)
- Socket mode 0600 (user-only)
- No authentication needed (same user process)
- Fresh pi invocation = no parent memory access

## Tool: `tmux_spawn`

```typescript
tmux_spawn({
  task: "Debug the race condition in helpers.ts",  // required
  name: "debug-helper",  // optional: tmux window name hint
  timeout: 60000,  // ms, default 60s
  cwd: "/path/to/project"  // optional, defaults to current
})
```

### Returns

| Status | Output |
|--------|--------|
| Success | `{ output: "...", details: { duration, usage, isError: false } }` |
| Timeout | `{ output: "Timeout after Nms", isError: true, details: {} }` |
| Error | `{ output: "Agent error: ..." or "tmux_spawn failed: ...", isError: true, details: {} }` |

## Files

| File | Purpose |
|------|---------|
| `tmux-agent.ts` | Socket server infrastructure (parent side) |
| `tmux-spawn.ts` | Registers `tmux_spawn` tool |
| `tmux-agent-cli.js` | Client script running in tmux window |
| `tmux-helper.ts` | TypeScript version of client helper |

## Testing

```bash
npm test
# Runs: 86 tests including tmux-spawn integration tests
```

## Limitations

- Requires `tmux` installed on system
- Unix domain sockets (Linux/macOS only, not Windows)
- Socket path limited to ~108 chars (Unix socket path limit)