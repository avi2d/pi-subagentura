# Architect Review: RPC Mode Implementation Plan

## Strengths (brief)

- Elegantly leverages existing in-process `createAgentSession` — no serialization overhead, no network complexity
- Reusing `jobRegistry` with an `rpc` type is pragmatic — avoids parallel infrastructure
- Capability-based dispatch with static registration is simple and extensible
- Dependency graph is well-structured with clear critical path (1.1 → 1.2 → 1.4)
- Risk register identifies key concerns (name collisions, timeout race, circular RPC)

---

## Steelman Antithesis

**The core premise is flawed: agents are not functions, so this "RPC" model is building the wrong abstraction.**

The plan frames RPC calls as "agents calling other agents as async functions." But agents are not functions. A function is stateless, deterministic, and composable — you call it with inputs, it returns outputs. An agent is an autonomous reasoning loop that decides which tools to call based on its own judgment, and those tool calls operate on the **same shared environment** (filesystem, processes, API state) that the caller is also operating on.

Consider a concrete scenario: Agent A calls `agent_call({ target: "code-reviewer", task: "..." })`. The code-reviewer agent starts running. During its execution, it calls `subagent_isolated` to spawn its own sub-agents, or it modifies files via a tool. Meanwhile, Agent A is also running, also potentially calling tools, also spawning sub-agents. You now have two autonomous agents with independent reasoning loops operating concurrently on the same filesystem, the same process tree, the same running state.

The plan's mitigation for circular calls ("recursion depth > 2") is the only concession to this concurrency problem. But it doesn't address the fundamental issue: **there is no isolation between caller and callee in this in-process model**. The "capabilities" list is just metadata — it doesn't constrain what the callee actually does. A "read-only" code reviewer could still call `bash` and nuke your project.

Furthermore, the plan's own ADR-4 acknowledges this is built on a "structured message type" for partial results — but the plan never specifies **who controls the callee's execution loop**. Does the callee's agent run its own tool calls autonomously? If so, how does the caller get meaningful streaming *results* rather than just status updates about what the callee is doing? If the caller is expecting a specific structured response (e.g., "return the refactored code"), but the callee is an autonomous agent making its own tool calls, the caller cannot predict or control the execution path.

This isn't a "distributed systems" problem that justifies kicking the can down the road per ADR-1. It's a **semantic mismatch** at the core of the design: RPC semantics assume you know what you're calling and can predict what it returns; agent semantics assume autonomous exploration of an execution tree. These don't compose cleanly.

---

## Evaluation

**Does the antithesis hold?**

**The concurrency concern is real but overblown.** The circular call risk is the main concrete instance of this problem, and the plan does acknowledge it (with a threshold-based mitigation). In practice, pi-subagentura is a single-user CLI tool running on a developer's machine, not a multi-tenant server. The concurrency blast radius is bounded.

**The semantic mismatch is valid and more serious.** Look at how `runSubagent` (the existing mechanism) actually works: it calls `session.prompt()` which runs the full agent loop — the agent decides what tools to call, executes them, gets results, and eventually returns a final output. This is a **black box** from the caller's perspective. The plan proposes adding `method` dispatch ("specific capability to invoke") suggesting the caller wants a named method — but nothing in the architecture enforces this. The callee agent still runs its full autonomous loop.

Consider Task 1.4's implementation:
1. Look up `target` in agent registry
2. Create a session for the target agent
3. Wire up timeout and `onUpdate`
4. Execute via `session.prompt()`

Step 4 just calls `prompt()` with a task string. The "method" parameter is mentioned but **there's no mechanism** to route it differently than a plain task string. A "code_review" method and a "refactor" method both just become different task strings fed to the same autonomous agent loop. The "capability" is just metadata.

**The streaming story is also underspecified.** ADR-4 says streaming uses `onUpdate`, and the format is `RpcPartialUpdate { type, data, metadata }`. But `onUpdate` in the current system is called with `AgentToolResult` and carries `SubagentLiveStatus` (turn count, active tool, output). The plan proposes a different format `{ type: "progress" | "result_chunk" | "error", data: string, metadata? }`. Who populates this? The callee agent calls tools, generates text deltas — but there's no mechanism described that translates the agent's live status into this structured RPC partial update format. The callee would need to explicitly emit these, but the plan never specifies how a callee agent's tool execution translates into RPC partial results vs. the existing live status.

**What's overblown:**
- The "two agents modifying the same file" scenario is a real concern but rare in practice for a developer tooling agent. Proper use would involve orchestration (parent controls overall flow, child does bounded sub-tasks).
- The lack of distributed mode is correctly deferred — in-process is fine for v1.

**What's valid:**
- The "method" abstraction is misleading. It suggests RPC-style method dispatch but there's no routing mechanism — it's just a task string tag.
- The streaming partial result format is designed but there's no producer-side specification for who emits these and how they relate to the agent's live status.
- The plan uses `session.prompt()` as the execution primitive but never addresses what happens when the caller wants to inspect or intervene in the callee's execution (beyond timeout/cancel).

---

## Recommended Fixes

1. **Clarify "method" semantics or remove it from v1.** Either:
   - Implement actual method dispatch: a method maps to a specific prompt template or persona that constrains the agent's behavior toward a specific output format, OR
   - Drop `method` from v1 and revisit when there's a concrete use case.

2. **Specify the streaming producer side.** The plan defines `RpcPartialUpdate` as a consumer-side format but doesn't specify how the callee's live status events map to it. Options:
   - The callee agent runs with its own `onUpdate` callback that translates events into `RpcPartialUpdate` messages forwarded to the caller.
   - A simpler approach for v1: treat all streaming as live status updates (current format) and drop the `RpcPartialUpdate` format distinction — merge it with existing `SubagentLiveStatus` concepts.

3. **Add recursion depth tracking.** The circular call mitigation (depth > 2) is mentioned but no implementation mechanism is specified. Add a `callDepth` field to the session context or a thread-local counter that increments on each RPC call and is checked before executing.

4. **Clarify session lifecycle for RPC.** The plan reuses subagent sessions but RPC has different semantics: the caller waits for result (sync or async), not fire-and-forget. Consider whether RPC jobs need separate tracking from subagent jobs — even if they share the same registry, the lifecycle (especially around cleanup) may differ.

5. **Tighten the timeout abort.** The current `withTimeout` using `Promise.race` races the promise but doesn't guarantee the callee session is aborted. The plan references `AbortSignal.timeout` combined with `session.abort()` in the risk register — make this a concrete implementation requirement: the timeout handler must call `session.abort()` to actually terminate the callee's execution.

---

## Verdict

The plan is implementable and the approach is pragmatic for v1. The main risks (timeout race, circular calls, name collisions) are identified. However, the semantic gap around "method dispatch" and "streaming partial results" needs clarification before implementation — both are core features with underspecified producer-side mechanics. The plan should be accepted conditionally: Tasks 1.1–1.3 (types, registry, JobState extension) are safe to start; Tasks 1.4–1.6 (agent_call, agent_register, list_agents) need the above clarifications first.