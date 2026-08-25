# Completion Delivery Coordination Plan

## Status

Implementation plan for `feat/completion-delivery-groups`, originally branched
from `origin/master` at `0acb79e` and synchronized through `fc08047` (`v3.3.1`).

## Problem

A completed sub-agent currently uses the same Pi custom-message channel for
both user notification and parent-LLM delivery. Each custom message participates
in model context, and triggered follow-ups may be queued while the parent is
busy. A result that the parent already collected manually can therefore arrive
again later as an automatic completion message. Parallel related work can also
produce one parent turn per member instead of one aggregate continuation.

## Goals

1. Notify the user exactly once for every terminal sub-agent turn.
2. Keep user-only notices out of parent LLM context.
3. Support two explicit parent-delivery policies:
   - `each`: independent results become eligible independently;
   - `group`: related results wait at a sealed all-terminal barrier.
4. Trigger automatic parent continuation without requiring the user to ask for
   status.
5. Give human input priority over automatic continuation.
6. Deliver each result to the parent model at most once through normal runtime
   paths, including manual result collection.
7. Preserve durable delivery IDs, rehydrate behavior, bounded payloads, and
   workflow-owned child suppression.

## Non-goals

- Inferring task relatedness from task text.
- Injecting full child output automatically by default.
- Treating mutable `output.md` as an authoritative historical snapshot.
- Parsing arbitrary shell commands to infer that a result was consumed.
- Eliminating the documented crash window where Pi proves synchronous dispatch
  but not durable session commit.

## Terminology

- **Completion**: one terminal child turn with outcome `done`, `error`, or
  `cancelled`.
- **User notice**: durable TUI-only completion entry. It never participates in
  LLM context.
- **Delivery intent**: durable parent-model work item identified by deterministic
  `deliveryId`.
- **Consumed**: the parent retrieved the completion manually, so automatic model
  delivery must omit it.
- **Dispatched**: the compact manifest was submitted to Pi for model delivery.
- **Receipted**: the parent session contains the corresponding deterministic ID.
- **Completion group**: explicit related-work barrier with durable membership.
- **Sealed**: no more members may join a group.
- **Terminal group**: a sealed group whose every member is done, errored, or
  cancelled.

## Required behavior

### User channel

For every terminal completion:

1. Append one durable custom entry with `pi.appendEntry()`.
2. Render it with `pi.registerEntryRenderer()`.
3. Include bounded status, agent/turn identity, and retrieval reference.
4. Record a deterministic user-notice receipt so polling, reload, and retries do
   not append the same notice again.
5. Keep running state visible in the existing footer/supervisor.

`pi.sendMessage()` must not be used for user-only notices because Pi documents
that custom messages participate in LLM context even when `triggerTurn` is
false.

### Parent policy: `each`

1. A terminal independent result becomes ready immediately.
2. Never inject it into an active parent turn mid-stream.
3. When the parent is safely idle, trigger one follow-up containing a compact
   manifest of all independent results ready at that dispatch instant.
4. Coalescing is allowed and preferred; readiness is independent, but multiple
   ready completions must not create a burst of redundant turns.
5. A single sub-agent naturally triggers after its own completion.

### Parent policy: `group`

1. Related work declares `completionPolicy: "group"` and an explicit bounded
   `completionGroupId`; relatedness is never inferred.
2. Register each delivery ID as a durable group member.
3. Seal the group when its spawning parent turn settles, or when a workflow's
   scheduler closes its member set.
4. Notify the user for each terminal member immediately.
5. Do not trigger the parent model until the group is sealed and every member is
   terminal.
6. At the barrier, trigger one parent turn with one aggregate manifest.
7. `error` and `cancelled` are terminal and cannot hold the barrier open.
8. If every result was manually consumed, do not trigger an empty turn.

Distinct related groups created in one parent turn must remain separate.

## Human-input priority

Human activity must take precedence over automatic completion delivery.

1. If a human prompt, steering message, or follow-up is already pending, do not
   queue another automatic parent turn.
2. If ready completions exist before a human-initiated turn starts, attach one
   coalesced manifest to that natural turn instead of triggering a second turn.
3. If completions become ready during the human turn, wait for settlement and
   then dispatch only what remains unconsumed.
4. Session replacement or cancellation must retire or migrate intents according
   to the existing lifecycle policy; no intent may cross into the wrong parent
   session.
5. Commands that replace/cancel the session must not receive a completion
   manifest from the abandoned session.

Implementation should use Pi's input/turn lifecycle, `ctx.hasPendingMessages()`,
`ctx.isIdle()`, and the session scope rather than timing guesses.

## Manual consumption

The following successful terminal-result paths must atomically consume matching
pending delivery IDs before returning result content:

- `read_subagent_artifact` for a selected or latest terminal turn;
- `get_subagent_result`;
- `get_workflow_result`.

A successful built-in `read` of an owned immutable output snapshot may also be
recognized after tool completion and consumed when it can be mapped safely.
Generic shell reads cannot be recognized reliably and remain outside this
contract.

Consumption and automatic dispatch must share one coordinator/claim path so
only one wins. Automatic triggered delivery must wait for parent settlement;
this removes the normal race where Pi has already queued an irreversible
follow-up before manual collection finishes.

## Manifest format

The model receives references, not full output by default.

Interactive completion:

```text
- agent <id>, turn <turnId>, <status>
  output: <artifactDir>/outputs/<eventId>.md
  activity: <artifactDir>/events.ndjson
```

Use the immutable protocol-v2 snapshot. Fall back to `output.md` only for legacy
artifacts without an immutable snapshot.

In-process completion:

```text
- job <jobId>, <status>: call get_subagent_result({ jobId: "<jobId>" })
```

Workflow completion:

```text
- workflow <workflowId>, <status>: call get_workflow_result({ workflowId: "<workflowId>" })
```

Every manifest is bounded, sanitized, attributed, and carries its delivery IDs
in structured details for receipt reconciliation.

## State model

A coordinator owned by `SessionScope` should serialize transitions:

```text
queued -> ready -> claimed(manual | automatic) -> dispatched -> receipted
                  \-> consumed
```

Group state minimally contains:

```text
completionGroupId
owner/session generation
member delivery IDs
sealed flag
dispatched/receipted aggregate ID
```

Interactive group and delivery state required across reload must be persisted in
the existing per-cwd state file using crash-safe ordering. In-process jobs and
background workflows remain parent-session scoped under their existing rules.
Physical event byte order remains authoritative.

## API direction and compatibility

Expose an explicit policy on spawnable background work:

```text
completionPolicy: "each" | "group"  // default: "each"
completionGroupId?: string           // required for "group"
```

The implementation must define how group sealing occurs and document it. Prefer
parent-turn settlement for directly spawned agents and workflow scheduler
completion for workflow-owned groups.

Keep legacy `notifyOnComplete` and `triggerTurnOnComplete` inputs accepted during
a deprecation period. Map explicit legacy values deterministically and document
that:

- the user notice is always TUI-only;
- model payloads are compact references;
- trigger timing is coordinated by policy/barrier and human priority.

Reject conflicting old/new options rather than silently choosing one.

## Workflow ownership

Workflow-owned interactive children continue to suppress direct child delivery.
Only the workflow completion participates in the parent completion coordinator.
A workflow's internal fan-out uses its scheduler's known terminal barrier and
must not trigger the parent once per internal child.

## Tests to add first

### Core coordinator

- independent single completion becomes ready;
- independent completions coalesce while parent is busy;
- explicit groups remain blocked before sealing;
- sealed groups wait for every member;
- errors and cancellations satisfy terminality;
- duplicate event folds do not duplicate notices or delivery;
- all-consumed groups produce no automatic turn.

### Parent lifecycle and human priority

- no automatic send while `parentStreaming`;
- queued human input wins over ready completion;
- ready manifest is attached once to the next human turn;
- completion during a human turn dispatches only after settlement;
- session replacement cannot leak old intents;
- repeated child turns use distinct delivery IDs.

### Manual consumption

- artifact read wins before automatic dispatch;
- in-process result collection wins before automatic dispatch;
- workflow result collection wins before automatic dispatch;
- automatic dispatch wins only once when no manual collector does;
- reload reconciles receipts without replaying consumed output.

### Context cleanliness

Using the Pi session harness:

- each user notice creates a custom entry, not a custom message;
- notices never appear in the next provider request;
- one intended compact manifest appears in the provider request;
- full child output is absent unless explicitly retrieved;
- several related completions produce one provider turn and one manifest.

### Integrations

- tmux and zellij completion paths;
- terminal E2E with a human prompt arriving before group completion;
- terminal E2E with related reviewers producing one aggregate continuation.

## Documentation

Update at least:

- `README.md` tool parameters and completion-delivery behavior;
- `architecture.md` durable broker, group barrier, and human-priority flow;
- `AGENTS.md` invariants and testing guidance;
- `CHANGELOG.md` behavior/API change;
- tool schemas/descriptions and default-guidance text;
- workflow documentation where background completion behavior is described.

Documentation must clearly separate user notification from parent-LLM delivery
and state that `triggerTurn: false` alone does not keep a `sendMessage()` custom
message out of model context.

## Verification gates

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
npm run test:tmux
npm run test:zellij
```

Also run the focused Pi-session delivery tests and terminal E2E scenarios. No
runtime `console.*` calls are permitted; diagnostics use `debugLog`.

## Acceptance criteria

- The user sees one completion notice per terminal sub-agent turn without asking
  for status.
- Independent work resumes the main agent without per-completion bursts.
- Related work resumes the main agent once, after the sealed all-terminal
  barrier.
- Human input is never displaced by completion automation.
- Manually consumed results do not arrive again automatically.
- Default notices do not participate in LLM context.
- Parent manifests contain immutable references and retrieval IDs, not repeated
  full output.
- Reload, cancellation, errors, repeated child turns, and mux backends retain
  deterministic delivery behavior.
