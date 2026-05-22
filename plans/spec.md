# Tmux Agent Mode — Updated Specification

## Overview

Spawn sub-agents in dedicated tmux windows with Unix domain socket IPC for parent↔subagent communication. Provides user visibility into agent execution.

## Architecture

```
┌─ pi (parent) ─────────────────────────────────────────────┐
│  tmux_spawn tool creates:                                 │
│                                                             │
│  ┌─ tmux window: pi-agent-<uuid> ─────────────────────┐    │
│  │  pi --tmux-mode (fresh invocation)                │    │
│  │         ↓                                          │    │
│  │  Unix socket: /tmp/pi-<user>/agent-<uuid>.sock   │    │
│  └────────────────────────────────────────────────────┘    │
│                           ↑                                 │
│                     parent connects                        │
└────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Unix Domain Sockets (not TCP)
- **Why**: Filesystem permissions protect access (same user only)
- **Path**: `/tmp/pi-<uid>/agent-<uuid>.sock`
- **No port conflicts**

### 2. Fresh pi Invocation (not same process)
- **Why**: Clean slate, matches `subagent_isolated` semantics
- **How**: `tmux send-keys 'pi --tmux --task "<task>"'`
- **Config**: Must pass API keys via env vars inherited from parent

### 3. Readiness Protocol
```
Subagent pi starts:
  1. Creates socket directory (/tmp/pi-<uid>/)
  2. Creates Unix socket
  3. Writes .ready file (signals "listening")
  4. Waits for connections

Parent:
  1. Spawns tmux window
  2. Polls for .ready file (100ms intervals, 10s timeout)
  3. Reads socket path from .ready file
  4. Connects as client
  5. Sends task via JSON-RPC
```

### 4. Socket Protocol (JSON-RPC 2.0)

**Parent → Subagent messages:**
```json
{ "jsonrpc": "2.0", "method": "task", "params": { "task": "...", "context": {} }, "id": 1 }
{ "jsonrpc": "2.0", "method": "abort", "params": {}, "id": 2 }
{ "jsonrpc": "2.0", "method": "ping", "params": {}, "id": 3 }
```

**Subagent → Parent messages:**
```json
{ "jsonrpc": "2.0", "method": "progress", "params": { "output": "...", "tool": "...", "turn": 1 }, "id": null }
{ "jsonrpc": "2.0", "method": "result", "params": { "output": "...", "usage": {...}, "isError": false }, "id": 1 }
{ "jsonrpc": "2.0", "method": "error", "params": { "message": "..." }, "id": 1 }
```

### 5. Lifecycle Ownership

| Phase | Action |
|-------|--------|
| Create | Parent creates tmux window, spawns subagent pi |
| Run | Subagent owns execution, sends progress |
| Complete | Subagent sends `result`, exits cleanly, parent kills tmux window |
| Abort | Parent sends `abort`, waits 5s, then `tmux kill-window` |
| Timeout | Parent disconnects after 60s (configurable), kills window |

### 6. Security

- Socket in user-specific temp dir (`/tmp/pi-<uid>/`)
- Socket mode 0600 (user-only read/write)
- No authentication needed (same user)
- Fresh pi invocation = no parent process memory access

## New Tool: `tmux_spawn`

```typescript
tmux_spawn({
  task: "Debug the race condition in helpers.ts",  // required
  name: "debug-helper",  // optional: tmux window name hint
  timeout: 60000,  // ms, default 60s
  cwd: "/path/to/project"  // optional, defaults to current
})
```

Returns:
- Success: `{ output: "...", usage: {...}, duration: ms }`
- Timeout: `{ isError: true, output: "Timeout after 60s" }`
- Error: `{ isError: true, output: "..." }`

## Implementation Phases

### Phase 1: Core Infrastructure
1. Create `tmux-agent.ts` module
2. Unix socket server implementation
3. Socket path management (`/tmp/pi-<uid>/`)
4. Readiness file protocol
5. Basic JSON-RPC message handling

### Phase 2: Tmux Integration
1. `tmux_spawn` tool registration
2. Window creation with `tmux new-window`
3. Process spawning in tmux
4. Window cleanup on complete/abort/timeout

### Phase 3: Protocol
1. Task message sending
2. Progress streaming to parent
3. Result extraction
4. Error propagation

## Out of Scope (v1)
- Reconnection to running agents
- Multiple subagents coordinating
- User interaction during execution
- Dashboard/tmux pane splits
- Attach to running tmux window

## Open Questions (Resolved)

| Question | Decision |
|----------|----------|
| Fresh invocation vs same pi | Fresh invocation |
| TCP vs Unix socket | Unix domain socket |
| Readiness protocol | `.ready` file polling |
| Lifecycle ownership | Parent owns window lifecycle |
| Abort semantics | Send `abort` message + tmux kill-window fallback |