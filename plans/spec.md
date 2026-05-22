# RPC Mode for pi-subagentura — Initial Specification

## Context

pi-subagentura currently spawns sub-agents as fire-and-forget tools. The parent agent calls `subagent_with_context` or `subagent_isolated`, waits (sync) or polls (async), and receives the final result.

**Gap**: Agents cannot call other agents mid-task and get responses while doing their own work. There's no bidirectional communication, streaming partial results to caller, or RPC-style request/response with timeout/cancellation.

## Goal

Add RPC mode where agents can call other agents as async functions with:
- Request/response semantics (call and wait for response)
- Streaming live updates from the callee
- Timeout and cancellation controls
- Named method/capability dispatch

## Initial Requirements

### Must Have
1. `agent_call` tool — call another agent with a task, get streaming responses
2. Named agents can be registered and discovered
3. Timeout support (max duration for RPC call)
4. Cancellation via abort signal
5. Live status updates streamed back to caller during execution

### Should Have
1. Agent capability registry (what methods each agent exposes)
2. Bidirectional messaging (callee can send partial results mid-execution)
3. RPC method routing (dispatch to specific agent capabilities)

### Could Have
1. Distributed mode (agents on different processes/machines)
2. Persistence layer for agent state

## Key Design Questions

1. Should RPC use the existing job registry or a separate RPC-specific one?
2. How do we handle agent discovery — static registration or dynamic?
3. What's the wire format for streaming results back?
4. How do we handle cross-process/distributed scenarios?

## Comparison with Current Approach

| Aspect | Current Subagent | RPC Mode |
|--------|------------------|----------|
| Direction | Parent → Child | Bidirectional |
| Result | Final only | Streaming + Final |
| Control | Fire-and-forget | Timeout/Cancel |
| Discovery | Implicit | Capability registry |
| Semantics | Task spawn | Async function call |

## Known Constraints

- pi-subagentura runs in-process via SDK's `createAgentSession`
- Must maintain compatibility with existing subagent tools
- Should not break existing async job behavior