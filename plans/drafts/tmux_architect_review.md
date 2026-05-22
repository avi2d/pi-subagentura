# Architecture Review: Tmux Socket-Based Agent Mode

**Reviewer:** Architect  
**Date:** 2026-05-22  
**Document:** plans/spec.md

---

## Summary

The spec proposes a significant architectural addition: running sub-agents in dedicated tmux windows with socket-based IPC. While the visibility benefits are clear, this design introduces **multiple coordinated failure domains** that interact in non-obvious ways. The complexity compounds quickly.

**Verdict:** Feasible, but the spec understates implementation difficulty and omits several critical failure scenarios.

---

## 1. Technical Feasibility

### 1.1 Socket Server Implementation in pi

**Concern: pi was designed as a CLI tool, not a long-running server.**

The spec implies a new execution mode where pi runs with `--socket-server` flag or `PI_SOCKET_PORT` env var, creating a socket server instead of processing stdin and exiting. This requires:

- A new event loop integration in pi's core
- State machine for connection lifecycle (connecting → authenticated → processing → closing)
- Handling multiple parent connections (spec mentions one parent per subagent, but this needs explicit)
- Clean shutdown semantics — how does pi know when to exit?

**Assumption not stated:** The socket server runs *instead of* normal CLI mode, or both? If both, how does pi decide? If only socket mode, existing CLI usage is unaffected.

**Feasibility:** Possible, but requires non-trivial core changes to pi.

### 1.2 Port File Race Condition

```
Subagent: starts socket server on port 9123
Subagent: writes "9123" to /tmp/pi-socket-<uuid>.tmp
          (CPU scheduler switches away)
Parent:   reads temp file → finds nothing or old data
Parent:   fails to connect, times out
```

The spec has no synchronization mechanism. Parent cannot know when the file is ready.

**Fix required:** Parent must poll with retry, or subagent must signal readiness via a known event (stdout marker, etc.).

### 1.3 Tmux Window Lifecycle Timing

```
tmux new-window -n pi-agent-<uuid>
tmux send-keys 'pi --socket-server'
```

The spec assumes pi starts *instantly* and the socket server is ready *immediately*. But:

- pi startup takes time
- Any splash screens, welcome messages, or initialization in pi would delay socket readiness
- If tmux send-keys completes before pi is ready to receive input, keystrokes could be lost

**Fix required:** Need a readiness confirmation mechanism — pi prints something to stdout when socket is listening, parent watches for it.

### 1.4 JSON-RPC 2.0 Compliance

Spec says: `{ method, params, id }` style

JSON-RPC 2.0 requires: `{ "jsonrpc": "2.0", "method": "...", "params": ..., "id": ... }`

Missing field means non-compliant clients may reject messages.

**Recommendation:** Be explicit about JSON-RPC 2.0 compliance. Confirm library handles batch requests? Notification requests (no id)? The spec mentions `progress` and `error` as methods — need to define their response semantics (notifications vs. request/response pairs).

---

## 2. Complexity Concerns

### 2.1 Failure Domain Multiplication

Current in-process subagent: **1 failure domain** (pi process)

Proposed tmux agent: **4+ failure domains** that must coordinate:

```
Tmux daemon (must be running)
Tmux window (created, named, attached)
pi process (spawned in window, --socket-server mode)
Socket server (listening on port)
Socket client (parent's connection)
Temp file (created, readable, cleaned)
```

Each domain can fail independently, and failure in one can cascade.

### 2.2 Debugging Complexity

When something goes wrong, the operator must:

1. Check tmux is running: `tmux list-sessions`
2. Find the window: `tmux list-windows -t pi-agent-<uuid>`
3. Check pi process: `ps aux | grep pi`
4. Check socket port: `lsof -i :9123`
5. Check temp file: `cat /tmp/pi-socket-<uuid>.tmp`
6. Inspect tmux pane output: `tmux capture-pane -t pi-agent-<uuid>`

No unified diagnostics. The spec provides no debugging story.

### 2.3 No Timeout Mechanism Defined

What happens if subagent hangs? The spec does not mention:

- Parent timeout for task delivery
- Parent timeout for subagent readiness (socket server started)
- Parent timeout for result delivery
- How abort is signaled and what happens if abort fails

Long-running or hung subagents would block the parent indefinitely.

---

## 3. Hidden Assumptions

| Assumption | Risk |
|------------|------|
| tmux is installed and user has permission to create windows | Many users don't use tmux |
| tmux session survives parent crash | tmux inherits terminal lifecycle |
| pi can be invoked from tmux and will run headless | X11/display dependencies possible |
| Temp file is secure from other users on multi-user systems | Local socket access is a concern |
| Single parent connects to single subagent | No multi-client consideration |
| pi running in tmux won't produce unwanted terminal output (colors, cursor movement) | Corrupts socket messages |
| User has tmux session already running | New tmux session may be created with different behavior |

---

## 4. Edge Cases

### 4.1 Subagent pi Exits Unexpectedly

```
Subagent pi: crashes, killed by OOM, gets SIGTERM
Subagent pi: never sends result
```

Parent socket gets EOF. Parent must detect and handle. Does parent kill tmux window? Does parent try to reconnect? Spec says no reconnection support (v2).

**What happens:** Parent gets disconnect, subagent task fails with unclear error. tmux window remains visible but idle.

### 4.2 Tmux Itself Dies

If the tmux server crashes or is killed, all windows vanish. Parent socket receives disconnect. But now there's no tmux window to attach to for debugging.

### 4.3 Temp File Leftover

If subagent crashes before writing port, or writes but doesn't exit cleanly, stale temp files accumulate in `/tmp`. Another pi instance might read the stale port and fail to connect.

**No cleanup mechanism defined.**

### 4.4 Port Collision

Random available port could be in use by another process. Subagent retries? Parent has no way to know subagent tried multiple ports.

**Mitigation needed:** Document port selection strategy (e.g., try 5 ports then fail).

### 4.5 Malformed JSON from Subagent

A compromised or buggy subagent could send non-JSON, partial JSON, or JSON with wrong structure. Parent must handle gracefully — don't crash on parse errors.

### 4.6 Subagent Tool Calls During Task

Spec mentions subagent can send `tool_call` method. But what if parent is also a tool-calling context? Nested tool calls create a recursion problem. No calling convention defined for this.

### 4.7 User Interacts with Tmux Window

If user manually types in the tmux window while agent runs, this could corrupt agent state, interfere with pi's input handling, or confuse the operator.

**No window protection mechanism.**

### 4.8 Window Name Collision

```
tmux new-window -n pi-agent-<uuid>
# but uuid was somehow duplicated
# or tmux session was reused across pi invocations
```

Spec assumes UUID uniqueness. But if same UUID is used (clock skew, testing), tmux will refuse or reuse the window.

---

## 5. Security Implications

### 5.1 Local Socket Access

Socket server listens on `localhost:<port>`. On a shared system:

- Any local user can connect to the subagent's socket
- Subagent processes any message from any connected client
- No authentication on socket connection

**Attack vector:** Local user spoofs `task` messages to subagent, potentially causing it to execute arbitrary commands, exfiltrate data, or corrupt results.

**Mitigation needed:** Consider Unix domain sockets instead of TCP (limited to same user), or a shared secret passed via environment variable, or SO_REUSEADDR with connection validation.

### 5.2 Temp File Exposure

Port file in `/tmp` is world-readable:

```
-rw-r--r--  1 user  staff  6 May 22 10:00 /tmp/pi-socket-abc123.tmp
```

Any local user reads the port, connects, sends messages.

**Mitigation needed:** Temp file should be mode 0600, in user-specific temp directory (`/tmp/pi-<uid>/`), or use Unix socket with filesystem permissions instead.

### 5.3 Subagent Scope Creep

The spec doesn't address what the subagent process can access:

- Can it read parent process memory? (No, separate process)
- Can it access parent's filesystem? (Yes, same user — can read/write anywhere)
- Can it send signals to parent? (Yes, if same user)

A compromised subagent could damage the parent environment.

---

## 6. Specific Concerns by Section

### 6.1 Open Question #1: Same pi vs. Fresh Invocation

> "Should subagent's pi instance be the SAME pi or a fresh invocation?"

This is a critical architecture decision with downstream effects:

- **Same pi**: Shares configuration, plugins, state. Faster startup. But any bug/state in parent affects subagent.
- **Fresh invocation**: Clean slate. Matches current `subagent_isolated` behavior. But slower, and must re-establish API keys from environment.

**No decision made.** This affects implementation significantly.

### 6.2 Open Question #2: User Interaction

> "How to handle user interaction (subagent needs input)?"

Not addressed at all. Options:

- Forward stdin from parent to subagent via socket
- Use tmux's `pipe-pane` to capture output and allow reply
- Reject tasks requiring interaction at spawn time
- Show "waiting for input" in tmux window, let user type

No clear path. This limits usefulness for complex tasks.

### 6.3 Open Question #3: Dashboard Pane Splits

> "Should we support tmux pane splits for 'dashboard' view?"

Deferring is reasonable, but the architecture should not preclude this later. Currently, each agent gets a full window. A dashboard would need layout management — who controls the tmux layout? Parent or agent?

---

## 7. Missing Requirements

The spec should explicitly address:

| Requirement | Why Critical |
|-------------|--------------|
| Graceful shutdown sequence | How parent tells subagent to exit cleanly |
| Force kill mechanism | What if subagent doesn't respond to abort |
| Resource cleanup | tmux windows, temp files, socket ports |
| Logging | Where does pi socket-server mode write logs |
| Startup timeout | How long parent waits for socket ready |
| Task timeout | How long parent waits for result |
| Error propagation | How errors from subagent reach parent |
| Connection keepalive | What happens during long idle periods |

---

## 8. Recommended Approach

### Phase 1: Minimal Viable Implementation
1. Implement Unix domain socket instead of TCP (security, no port conflicts)
2. Use a well-known socket path in user-specific temp dir
3. Add readiness marker (socket + pid file) before parent connects
4. Implement basic ping/pong keepalive
5. Define clear shutdown protocol (SIGTERM to pi process via tmux)

### Phase 2: Reliability
1. Add timeout on all socket operations
2. Implement retry with backoff for port file reading
3. Add logging to temp dir for diagnostics
4. Define structured error format for failures

### Phase 3: Polish
1. Attach/detach visibility (user can watch, not interact)
2. Reconnection support (v2)
3. Coordination between multiple subagents (v2)

---

## 9. Questions for Authors

Before implementation proceeds, these must be answered:

1. **Same pi or fresh invocation?** Affects plugin system, config loading, state isolation.
2. **Unix socket or TCP?** Security and port collision trade-offs.
3. **What is the minimum viable feature set?** Can we ship without user interaction support?
4. **Who owns tmux window lifecycle?** Does parent create, subagent live in, parent destroy?
5. **What does "abort" mean?** Kill pi process? SIGTERM? Clean shutdown?

---

*End of Review*