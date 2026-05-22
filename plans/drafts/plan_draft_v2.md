# RPC Mode Implementation Plan v2 — pi-subagentura

## Changes from v1 (Addressing Architect/Critic Reviews)

### Blocking Issues Fixed

1. **Timeout abort** — Now explicit implementation task with concrete `session.abort()` requirement
2. **Call depth tracking** — Added as explicit Task 1.9 with `callDepth` in session context
3. **Streaming producer** — Clarified that v1 uses existing `SubagentLiveStatus` format, no new `RpcPartialUpdate` type
4. **Session creation errors** — Explicitly handled in Task 1.4
5. **Capabilities disclaimer** — Added to ADR-3
6. **Name collision atomicity** — Documented as race window, uses `Map.set` semantics

---

## Architecture Decision Record (ADR)

### ADR-1: In-Process RPC Model
**Decision**: RPC uses same in-process model as existing sub-agents, layered with request/response semantics.

**Rationale**: 
- `createAgentSession` already creates sessions in-process
- Adding RPC semantics (timeout, cancellation, streaming) on top is simpler than distributed RPC
- Preserves zero-overhead communication
- Can evolve to distributed later

### ADR-2: Reuse Job Registry
**Decision**: RPC calls use existing `jobRegistry` with "rpc" job type.

**Rationale**: Existing registry handles concurrency, cleanup, lifecycle. Adding `type` field to `JobState`.

### ADR-3: Named Agent Registry with Capability Discovery
**Decision**: Agents register with name and optional capability list.

**Important**: `capabilities` is **discovery metadata only**, not an access control mechanism. A "read-only" agent can still call any tool. This is a known gap for v1.

**Schema**:
```typescript
interface AgentRegistration {
  name: string;
  description?: string;
  capabilities?: string[];  // e.g., ["code_review", "debug"]
  _sessionFactory: () => Promise<AgentSession>;
}
```

### ADR-4: Streaming Uses Existing LiveStatus
**Decision**: Streaming uses existing `SubagentLiveStatus` format via `onUpdate`. No new `RpcPartialUpdate` type.

**Rationale**: Keep it simple. The caller receives `SubagentLiveStatus` events (turn count, active tool, output delta) which is sufficient for progress display. Don't introduce new type distinctions until we have concrete requirements.

---

## Task Breakdown

### Phase 1: Core Infrastructure

#### Task 1.1: Add RPC Types to helpers.ts
**File**: `helpers.ts`

```typescript
export interface RpcOptions {
  timeout?: number;        // ms, default 60000
  signal?: AbortSignal;
  streamProgress?: boolean;
  callDepth?: number;      // tracks recursion depth
}

export interface RpcResult {
  output: string;
  usage: SubagentResult["usage"];
  model?: string;
  isError: boolean;
  errorMessage?: string;
  duration: number;        // ms
}

export interface RpcCallParams {
  target: string;          // agent name
  task: string;             // what to ask the agent
  method?: string;          // optional: which capability to invoke (discovery only, no routing)
  options?: RpcOptions;
}
```

**Acceptance**: Types compile, no circular deps.

#### Task 1.2: Create Agent Registry
**New File**: `agent-registry.ts`

```typescript
interface AgentRegistration {
  name: string;
  description?: string;
  capabilities?: string[];
  _sessionFactory: () => Promise<AgentSession>;
}

// Uses global Map - survives module reloads
const g = typeof global !== "undefined" ? global : globalThis;
if (!g.__piSubagenturaAgentRegistry) {
  g.__piSubagenturaAgentRegistry = new Map<string, AgentRegistration>();
}
const registry = g.__piSubagenturaAgentRegistry as Map<string, AgentRegistration>;

export function registerAgent(reg: AgentRegistration): { success: boolean; error?: string } {
  // Atomic: check then set in one operation
  if (registry.has(reg.name)) {
    return { success: false, error: `Agent '${reg.name}' already registered` };
  }
  registry.set(reg.name, reg);
  return { success: true };
}

export function getAgent(name: string): AgentRegistration | undefined {
  return registry.get(name);
}

export function listAgents(): AgentRegistration[] {
  return Array.from(registry.values());
}

export function unregisterAgent(name: string): boolean {
  return registry.delete(name);
}
```

**Note on race condition**: `Map.set` with existence check in `registerAgent` is atomic in single-threaded JS. Concurrent calls within same event loop tick would need a mutex, but this is rare for a CLI tool.

**Acceptance**: Register, get, list, unregister work correctly.

#### Task 1.3: Extend JobState with RPC Type
**File**: `helpers.ts`

```typescript
export interface JobState {
  id: string;
  type?: "subagent" | "rpc";
  // ... existing fields ...
  rpcOptions?: RpcOptions;
  rpcMeta?: { target: string; method?: string; callDepth: number };
}
```

**Acceptance**: Existing subagent code still works (optional fields).

### Phase 2: RPC Tools

#### Task 1.4: Implement `agent_call` Tool
**File**: `subagent.ts`

```typescript
const AgentCallParams = Type.Object({
  target: Type.String({ description: "Name of the registered agent to call" }),
  task: Type.String({ description: "Task to delegate" }),
  method: Type.Optional(Type.String({ description: "Capability to invoke (discovery metadata only - no routing)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 60000)" })),
  streamProgress: Type.Optional(Type.Boolean({ description: "Stream progress updates via onUpdate" })),
});
```

**Implementation**:

```typescript
async execute(_toolCallId, params, signal, onUpdate, ctx) {
  // 1. Look up agent
  const agent = getAgent(params.target);
  if (!agent) {
    return { content: [{ type: "text", text: `Agent '${params.target}' not found` }], isError: true };
  }

  // 2. Check call depth (default 3)
  const maxDepth = params.options?.callDepth ?? 3;
  if (maxDepth <= 0) {
    return { content: [{ type: "text", text: `Max call depth exceeded for '${params.target}'` }], isError: true };
  }

  // 3. Create session
  let session;
  try {
    session = await agent._sessionFactory();
  } catch (err) {
    return { 
      content: [{ type: "text", text: `Failed to create session: ${err.message}` }], 
      isError: true 
    };
  }

  // 4. Set up timeout with explicit abort
  const timeoutMs = params.timeout ?? 60000;
  let timeoutId: ReturnType<typeof setTimeout>;
  let abortCalled = false;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(async () => {
      if (!abortCalled) {
        abortCalled = true;
        try {
          await session.abort();  // Explicit abort on timeout
        } catch {}
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });

  // 5. Run with timeout race
  const startTime = Date.now();
  try {
    await session.prompt(params.task);
  } catch (err) {
    if (!abortCalled) {
      clearTimeout(timeoutId);
    }
    session.dispose();
    return {
      content: [{ type: "text", text: `RPC call failed: ${err.message}` }],
      isError: true
    };
  }
  
  clearTimeout(timeoutId);
  
  // 6. Extract result
  const duration = Date.now() - startTime;
  const result = extractSessionResult(session);  // helper
  
  session.dispose();
  
  return {
    content: [{ type: "text", text: result.output }],
    details: { duration, model: result.model, usage: result.usage, isError: result.isError }
  };
}
```

**Acceptance**: 
- Calls registered agent, returns response
- Unknown agent → clear error
- Timeout after specified duration with explicit `session.abort()`
- Session creation failure → clear error

#### Task 1.5: Implement `agent_register` Tool
**File**: `subagent.ts`

```typescript
const AgentRegisterParams = Type.Object({
  name: Type.String({ description: "Unique name for this agent" }),
  description: Type.Optional(Type.String()),
  capabilities: Type.Optional(Type.Array(Type.String())),
  persona: Type.Optional(Type.String()),  // agent's system prompt
  model: Type.Optional(Type.String()),     // optional model override
});
```

**Implementation**: 
- Validate name uniqueness
- Create session factory that uses same `createAgentSession` as subagents
- Register with agent-registry
- Note: `capabilities` is **discovery metadata only** - no enforcement

**Acceptance**: Can register, retrieve, list agents.

#### Task 1.6: Implement `list_agents` Tool
**File**: `subagent.ts`

Returns list of registered agents with metadata.

**Acceptance**: Shows all registered agents.

#### Task 1.7: Extend `cancel_subagent` for RPC
**File**: `subagent.ts`

`cancel_subagent` already calls `session.abort()` — works for RPC jobs too since they share the same registry.

**Acceptance**: Can cancel running RPC calls.

### Phase 3: Lifecycle & Polish

#### Task 1.8: Timeout Implementation
**File**: helpers.ts (shared) / subagent.ts

Timeout handler **must** call `session.abort()` explicitly:

```typescript
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  session: AgentSession,
  signal?: AbortSignal
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(async () => {
      try {
        await session.abort();  // Critical: actually terminate the session
      } catch {}
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}
```

**Acceptance**: Timeout actually kills the session.

#### Task 1.9: Call Depth Tracking
**File**: helpers.ts / subagent.ts

Add `callDepth` to `RpcOptions` and enforce in `agent_call`:

```typescript
// In agent_call:
const callDepth = (params.options?.callDepth ?? 3) - 1;
if (callDepth < 0) {
  return { content: [{ type: "text", text: "Max call depth exceeded" }], isError: true };
}

// Pass decremented depth to child call
await session.prompt(taskWithDepthContext(callDepth, params.task));
```

Helper to inject depth into context:
```typescript
function taskWithDepthContext(depth: number, task: string): string {
  return `[RPC call depth: ${depth}]\n\nTask: ${task}`;
}
```

**Acceptance**: Circular calls (A→B→A) hit depth limit and error.

#### Task 2.0: Error Propagation
**File**: subagent.ts

Ensure all error paths return proper `RpcResult`:
- Unknown agent → `{ isError: true, errorMessage: "Agent not found" }`
- Session creation → `{ isError: true, errorMessage: "Failed to create session" }`
- Timeout → `{ isError: true, errorMessage: "Timeout after Nms" }`
- Session crash → `{ isError: true, errorMessage: err.message }`
- Already aborted signal → `{ isError: true, errorMessage: "Already aborted" }`

**Acceptance**: No raw errors escape, all return typed results.

---

## Dependency Graph

```
Task 1.1 (types) ──────────────────────────┐
                                         │
Task 1.3 (JobState extension) ────────────┤
        │                                 │
        └─────── Task 1.2 (registry) ────┤
                      │                   │
                      └───────────────────┼──→ Task 1.4 (agent_call)
                              │           │
                              └───────────┤
                                         │
Task 1.5 + 1.6 (register + list) ────────┤
                                         │
Task 1.7 (cancel extension) ────────────┤
                                         │
              Tasks 1.8-2.0 (lifecycle) ──┴──→ All
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-------------|--------|------------|
| Agent name collisions | Medium | High | Atomic check-then-set in register; clear error message |
| Timeout doesn't kill session | Medium | High | Explicit `session.abort()` in timeout handler |
| Circular RPC calls | Medium | Medium | `callDepth` counter, max 3 by default |
| Memory leak (session not disposed) | Low | High | `finally` blocks ensure `session.dispose()` in all paths |
| Streaming breaks subagent | Low | Medium | RPC streaming is opt-in via `streamProgress` |

---

## Acceptance Criteria

### Functional
1. ✓ `agent_register({ name: "researcher", persona: "..." })` succeeds
2. ✓ `list_agents()` returns `[{ name: "researcher", ... }]`
3. ✓ `agent_call({ target: "researcher", task: "..." })` returns result
4. ✓ `agent_call({ timeout: 5000 })` times out after 5s with explicit abort
5. ✓ `agent_call({ streamProgress: true })` streams updates via `onUpdate`
6. ✓ Unknown agent → clear error message
7. ✓ Circular calls (A→B→A) hit depth limit

### Non-Functional
1. ✓ Existing subagent tools unchanged
2. ✓ `npm test` passes (add RPC-specific tests)
3. ✓ TypeScript compiles cleanly
4. ✓ Session cleanup verified in test (timeout, error, cancel paths)

---

## Test Plan

**New file**: `subagent-rpc.test.ts`

```typescript
describe("agent-register", () => {
  it("registers an agent");
  it("rejects duplicate name");
});

describe("agent-call", () => {
  it("calls registered agent");
  it("returns error for unknown agent");
  it("respects timeout with explicit abort");
  it("streams progress when enabled");
  it("enforces call depth limit");
  it("session disposed on error");
  it("session disposed on timeout");
  it("session disposed on cancel");
});
```

---

## File Manifest

**Modified**:
- `helpers.ts` — RPC types, JobState extension
- `subagent.ts` — agent_call, agent_register, list_agents tools

**New**:
- `agent-registry.ts` — agent registration and discovery
- `subagent-rpc.test.ts` — RPC tests

**Removed from scope for v1**:
- Structured logging (defer to observability work)
- Metrics/monitoring (defer to v2)
- Retry mechanisms (defer to v2)
- Capability enforcement (design needed)