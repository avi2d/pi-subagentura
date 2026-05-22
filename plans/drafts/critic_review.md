# Critic Review: RPC Mode Implementation Plan

---

## Security Review

**1. Capabilities Are Decorative, Not Enforced**

The `capabilities` field in `AgentRegistration` is metadata with no enforcement mechanism. A caller can request `method: "read-only-code-review"` but the callee agent still executes its full autonomous loop with no behavioral constraint. The agent can call any tool in its arsenal — including `bash`, file writes, API calls. The plan should either:
- Enforce capability-gated tool access (out of scope for v1, but documented as a known gap)
- Clearly document that `capabilities` is discovery metadata only, not an access control list

**2. No Authentication on `agent_call`**

Any agent can call any other agent by name with no credentials or authorization check. In a single-user CLI this is acceptable by model assumption, but the plan should explicitly note this assumption rather than leaving a security gap invisible.

**3. Circular Call Detection is Shallow**

The plan mentions "recursion depth > 2" but:
- No implementation mechanism is specified (Task 2.0 covers error propagation but not recursion tracking)
- The threshold of 2 is arbitrary and not justified
- A→B→C→A (depth 3) would still deadlock or resource-starve
- A→B→A is depth 2 per the plan's own threshold — would error immediately on the second call

**Recommendation**: Specify `callDepth` as a context field that increments per RPC call, with a configurable threshold (default 3-5, not 2), and add it to the implementation task list explicitly.

**4. No Sandbox Between Caller and Callee**

Both agents operate in the same process, same filesystem, same environment variables. If agent A calls agent B and agent B runs `rm -rf /`, both are impacted. The plan correctly notes this is "in-process" but doesn't treat it as a security boundary that should be documented.

---

## Edge Case Analysis

**1. Name Collision After Validation Window**

Task 1.5 validates uniqueness on registration, but between validation and actual registration, a concurrent `agent_register` could collide. Race condition. Fix: use an atomic check-and-register operation (e.g., `Map.set` with existence check, or a mutex).

**2. `session.prompt()` Hangs Without Tool Timeout**

The timeout mechanism in Task 1.8 races with `Promise.race` and abort signal. But `session.prompt()` internally calls tools. If a tool call hangs (network timeout, interactive prompt, git merge conflict), the timeout races against the tool's own behavior — not necessarily aborting it. The plan's risk register mentions `session.abort()` but implementation is underspecified.

**Fix**: Timeout handler must call `session.abort()` explicitly. Tool-level timeouts are separate concern but should be noted.

**3. Calling `agent_call` During Active RPC Call**

What happens if agent A calls B, and while B is executing, A makes another `agent_call` to C? Or B calls A? The plan's concurrency model is:
- Shared job registry (Task 1.2)
- Shared session factory (ADR-1)

But there is no serialization or queuing specified. Two concurrent RPC calls share the same process loop — interleaved execution. This may be intended but is undocumented.

**4. Unregistering an Active Agent**

Task 1.4: "Look up target in agent registry" → but what if the agent was unregistered mid-call? The plan has no lifecycle coordination. Race between lookup and execution.

**5. `list_agents` Returns Stale Data**

`listAgents()` returns a snapshot of the registry at call time. An agent could unregister between the list call and the subsequent `agent_call`. No atomic "list then call" guarantee.

**6. Streaming Disconnect on Error**

If the callee emits partial results and then errors, the plan says error goes via `RpcPartialUpdate { type: "error" }`. But what if the callee crashes (process exception, not a caught error)? Does caller receive partial results with no final signal? The error propagation task (2.0) covers caught errors but not uncaught exceptions in the callee.

---

## Operational Concerns

**1. Debugging In-Process RPC Is Opaque**

In distributed systems, you have trace IDs, network logs, service boundaries. In this in-process model:
- No RPC call ID for correlation
- No structured log entries for RPC lifecycle (start, progress, end, error)
- `onUpdate` events are the only window into execution

Without adding structured logging (call ID, timestamps, target agent name), debugging a failing RPC call requires breakpoints or printf debugging.

**2. No Way to Inspect Callee State Mid-Execution**

The plan reuses `session.prompt()` as a black box. The caller can timeout, cancel, or receive final output — but cannot query "what is the callee doing right now?" This is by design (autonomous agent), but operational debugging would benefit from a `getRpcState(callId)` mechanism or similar introspection.

**3. Memory Leak Surface Area**

The plan mentions "ensure `session.dispose()` called in all paths (finally block)" but:
- No explicit task for session cleanup verification
- No test coverage for cleanup paths (error cases, timeout cases, cancel cases)
- The risk is marked "Low" likelihood but "High" impact — should have a concrete verification task

**4. No Monitoring or Metrics**

No mention of:
- RPC call latency histogram
- Timeout rate
- Error rate by agent name
- Concurrent RPC call count

For a v1 developer tool, this may be acceptable, but the plan should flag it as a known gap for future observability work.

**5. Recovery Path After Failure**

If an RPC call fails (timeout, error, crash), what does the caller receive? `RpcResult` with `isError: true`. But:
- Does the callee session persist any state that needs cleanup?
- Are any partial results stored for later retrieval?
- Is there a retry mechanism?

The plan treats failure as a return value, not a recovery scenario.

---

## Missing Failure Modes

**1. Session Creation Failure**

Task 1.4 step 2: "Create a session for the target agent". What if `createAgentSession` throws? The plan doesn't handle this in error propagation (Task 2.0). No `RpcResult` for session creation failure.

**2. Registry Lookup Returns Undefined (No Crash)**

Task 1.4 step 1: "Look up target in agent registry". If undefined, the plan says return error. But what if the agent exists at lookup but unregistered before step 2? No atomicity. Document the window.

**3. Tool Call Failure Inside Callee**

The callee agent calls a tool that fails (network error, API rate limit, permission denied). The agent's autonomous loop may retry or proceed. Does the caller see this? The plan's streaming is "progress" or "result_chunk" — no specification for tool-level errors bubbling up.

**4. AbortSignal Already Aborted**

If the caller passes an already-aborted `AbortSignal` in `RpcOptions`, the plan's `withTimeout` races with a pre-aborted signal. Behavior is undefined — should be handled explicitly (fail fast with clear error).

**5. Provider/API-Level Failures**

If the LLM provider (OpenAI, Anthropic, etc.) errors during RPC execution, the plan says "session crash → RpcResult with isError: true". But:
- Is there a retry with backoff?
- Does the caller need to handle provider-specific errors differently?
- Are provider error codes preserved or flattened to a generic error message?

**6. No Call Depth Stack Overflow**

Circular call detection (if implemented) uses a depth counter. But if depth limit is too high or absent, recursive RPC calls could stack overflow the JS event loop. The plan should specify a hard limit with explicit error (not silent truncation or infinite loop).

---

## Final Verdict

**REJECT WITH CONDITIONS**

The plan is implementable and the architectural direction is sound. However, the following must be addressed before implementation proceeds beyond Phase 1 tasks:

### Blocking Issues (must fix before Tasks 1.4+):

1. **Session abort on timeout** — The timeout handler must explicitly call `session.abort()`. This is in the risk register but not in any implementation task. Add it to Task 1.8 explicitly.

2. **Circular call depth tracking** — Currently mentioned only as a risk, not as an implementation task. Add `callDepth` field to session context and enforcement in `agent_call`.

3. **Streaming producer side** — The architect review correctly identified this gap. Either:
   - Specify how `SubagentLiveStatus` events map to `RpcPartialUpdate` format, OR
   - Drop the distinct format and use existing live status concepts

4. **Error on session creation** — Task 2.0 error propagation must cover the case where session creation itself fails.

### Non-Blocking but Required Before Merge:

5. **Capabilities disclaimer** — Document that `capabilities` is discovery metadata only, not an access control mechanism.

6. **Name collision atomicity** — Clarify that registration uses atomic `Map.set` with existence check or document the race window.

7. **Memory cleanup verification** — Add test cases that verify `session.dispose()` is called in timeout, error, and cancel paths.

### Informational (can defer to v2):

- Structured logging for RPC calls
- Metrics/monitoring
- Retry mechanisms
- Introspection API

**Verdict**: Approve Tasks 1.1–1.3 (types, registry, JobState) for implementation. Hold Tasks 1.4–2.0 until blocking issues are resolved in the plan itself.