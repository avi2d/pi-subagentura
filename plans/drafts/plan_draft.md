# RPC Mode Implementation Plan — pi-subagentura

## Architecture Decision Record (ADR)

### ADR-1: In-Process RPC Model
**Decision**: RPC will use the same in-process model as existing sub-agents, layered with request/response semantics.

**Rationale**: 
- `createAgentSession` already creates sessions in-process
- Adding RPC semantics (timeout, cancellation, streaming) on top is simpler than distributed RPC
- Preserves zero-overhead communication (no serialization/network)
- Can evolve to distributed later

**Alternatives considered**:
- HTTP/REST RPC: Adds serialization overhead, complexity, networking
- Message queue: Over-architected for v1

### ADR-2: Reuse Job Registry
**Decision**: RPC calls will use the existing `jobRegistry` with an "rpc" job type.

**Rationale**:
- Existing registry already handles concurrency, cleanup, and lifecycle
- Adding a type field to `JobState` distinguishes RPC from subagent jobs
- Shared infrastructure reduces code duplication

**Tradeoff**: RPC jobs have different lifecycle (timeout, streaming) than subagent jobs. We'll add `rpcOptions` to `JobState`.

### ADR-3: Named Agent Registry
**Decision**: Agents register themselves with a name and optional capability list. Other agents can discover and call them by name.

**Rationale**:
- Simple static registration at startup
- Capability list enables method dispatch ("what methods does agent X expose?")
- Can evolve to dynamic discovery later

**Schema**:
```typescript
interface AgentRegistration {
  name: string;
  description?: string;
  capabilities?: string[];  // e.g., ["code_review", "debug", "refactor"]
  handler: (task: string, options: RpcOptions) => Promise<RpcResult>;
}
```

### ADR-4: Streaming via onUpdate Callback
**Decision**: RPC streaming uses the existing `onUpdate` callback mechanism.

**Rationale**:
- `onUpdate` already exists in `runSubagent` for live status
- Extending it for RPC partial results is consistent
- The callee can emit partial results via `onUpdate`; final result via return

**Format**: RPC partial results use a structured message type:
```typescript
interface RpcPartialUpdate {
  type: "progress" | "result_chunk" | "error";
  data: string;
  metadata?: Record<string, unknown>;
}
```

---

## Task Breakdown

### Phase 1: Core RPC Infrastructure

#### Task 1.1: Add RPC Types to helpers.ts
**File**: `helpers.ts`

Add new types:
```typescript
export interface RpcOptions {
  timeout?: number;        // ms, default 60000
  signal?: AbortSignal;
  streamProgress?: boolean;
}

export interface RpcResult {
  output: string;
  usage: SubagentResult["usage"];
  model?: string;
  isError: boolean;
  errorMessage?: string;
  duration: number;         // ms
}

export interface RpcPartialResult {
  type: "progress" | "chunk" | "error";
  content: string;
}

export interface RpcCallParams {
  target: string;           // agent name
  task: string;             // what to ask the agent
  method?: string;          // optional capability/method to invoke
  options?: RpcOptions;
}
```

**Acceptance**: Types compile, no circular deps with existing types.

#### Task 1.2: Create Agent Registry Module
**New File**: `agent-registry.ts`

```typescript
interface AgentRegistration {
  name: string;
  description?: string;
  capabilities?: string[];
  // Internal
  _sessionFactory: () => AgentSession;
}

const agentRegistry = new Map<string, AgentRegistration>();

export function registerAgent(reg: AgentRegistration): void
export function getAgent(name: string): AgentRegistration | undefined
export function listAgents(): AgentRegistration[]
export function unregisterAgent(name: string): boolean
```

**Acceptance**: Can register, retrieve, list, unregister agents.

#### Task 1.3: Extend JobState with RPC Type
**File**: `helpers.ts`

Add to `JobState`:
```typescript
export interface JobState {
  // ... existing fields ...
  type?: "subagent" | "rpc";
  rpcOptions?: RpcOptions;
  rpcMeta?: { target: string; method?: string };
}
```

**Acceptance**: Existing code still works, new fields optional.

#### Task 1.4: Implement `agent_call` Tool
**File**: `subagent.ts`

```typescript
const AgentCallParams = Type.Object({
  target: Type.String({ description: "Name of the agent to call" }),
  task: Type.String({ description: "Task to delegate" }),
  method: Type.Optional(Type.String({ description: "Specific capability to invoke" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 60000)" })),
  streamProgress: Type.Optional(Type.Boolean({ description: "Stream progress updates" })),
});
```

Tool implementation:
1. Look up `target` in agent registry
2. Create a session for the target agent
3. Wire up timeout (via `AbortSignal.timeout` or manual timer)
4. Wire up `onUpdate` for streaming partial results
5. Execute via `session.prompt()`
6. Return `RpcResult` with duration

**Acceptance**: 
- Can call a registered agent and get response
- Timeout kills the session after configured duration
- Partial progress updates stream to caller via `onUpdate`

#### Task 1.5: Implement `agent_register` Tool
**File**: `subagent.ts`

```typescript
const AgentRegisterParams = Type.Object({
  name: Type.String({ description: "Unique name for this agent" }),
  description: Type.Optional(Type.String()),
  capabilities: Type.Optional(Type.Array(Type.String())),
});
```

Tool implementation:
1. Validate name is unique
2. Register with agent-registry
3. Return confirmation

**Acceptance**: Can register an agent and see it in `list_agents`.

#### Task 1.6: Implement `list_agents` Tool
**File**: `subagent.ts`

Returns:
```typescript
{
  agents: Array<{
    name: string;
    description?: string;
    capabilities?: string[];
  }>
}
```

**Acceptance**: Shows all registered agents with their metadata.

#### Task 1.7: Implement `agent_cancel` Tool
**File**: `subagent.ts`

Same as `cancel_subagent` but for RPC jobs. Actually, we can extend `cancel_subagent` to also cancel RPC jobs (same mechanism works).

**Acceptance**: Can cancel a running RPC call.

### Phase 2: RPC Lifecycle & Error Handling

#### Task 1.8: Timeout Implementation
**File**: `helpers.ts` or `subagent.ts`

Implement timeout wrapper:
```typescript
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortSignal: AbortSignal
): Promise<T>
```

Uses `Promise.race` with a timeout rejection. Cleans up properly on abort.

**Acceptance**: RPC calls respect timeout and return timeout error.

#### Task 1.9: Streaming Progress Updates
**File**: `subagent.ts`

Enhance `onUpdate` handling for RPC:
- Progress messages from callee are forwarded via `onUpdate`
- Final result aggregated separately

**Acceptance**: Caller sees incremental progress from long-running RPC calls.

#### Task 2.0: Error Propagation
**File**: `subagent.ts`

Ensure RPC errors are properly typed:
- Timeout → `RpcResult` with `isError: true, errorMessage: "Timeout after Nms"`
- Agent not found → `RpcResult` with `isError: true, errorMessage: "Agent 'X' not found"`
- Session crash → `RpcResult` with `isError: true, errorMessage: err.message`

**Acceptance**: All error scenarios return proper `RpcResult`, never raw throws.

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
Task 1.7 (cancel extension) ─────────────┤
                                         │
              Tasks 1.8-2.0 (lifecycle) ───┴──→ All
```

**Critical path**: Tasks 1.1 → 1.2 → 1.4 are sequential. All others can parallelize after.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-------------|--------|------------|
| Agent name collisions | Medium | High | Validate unique on register, throw clear error |
| Timeout race with session abort | Medium | Medium | Use `AbortSignal.timeout` combined with `session.abort()` |
| Memory leak from unclosed RPC sessions | Low | High | Ensure `session.dispose()` called in all paths (finally block) |
| Streaming breaks existing subagent behavior | Low | Medium | RPC streaming is opt-in via `streamProgress` param |
| Circular RPC calls (A calls B calls A) | Low | Medium | Detect and error on recursion depth > 2 |

---

## Acceptance Criteria

### Functional
1. ✓ `agent_register({ name: "researcher" })` registers an agent
2. ✓ `list_agents()` returns `[{ name: "researcher", ... }]`
3. ✓ `agent_call({ target: "researcher", task: "..." })` returns RpcResult
4. ✓ `agent_call` with `timeout: 5000` times out after 5s
5. ✓ `agent_call` with `streamProgress: true` streams partial updates
6. ✓ Calling unknown agent returns clear error message

### Non-Functional
1. ✓ Existing subagent tools still work identically
2. ✓ No regression in `npm test`
3. ✓ TypeScript compiles with no errors
4. ✓ RPC adds < 100 lines to core logic

---

## File Manifest

**Modified**:
- `helpers.ts` — RPC types, JobState extension
- `subagent.ts` — agent_call, agent_register, list_agents, agent_cancel tools

**New**:
- `agent-registry.ts` — agent registration and discovery

**Test**:
- `subagent-rpc.test.ts` — RPC-specific tests (new file)