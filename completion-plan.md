# Completion Delivery Coordination

## Status

Implemented on `feat/completion-delivery-groups` at `53f33cf` and hardened at
`b41579a`. This document records the shipped design and its verification contract.

## Historical problem

Completion notifications previously reused Pi custom messages for both the user
and the parent model. Those messages entered later model context, could queue a
turn while the parent was busy, and could redeliver output that the parent had
already collected. Related fan-out could also create one continuation per member.

The implementation separates those channels and coordinates parent readiness.

## Goals and scope

- Notify the user once for every parent-visible standalone terminal turn and every
  background workflow aggregate terminal result.
- Keep user notices out of parent LLM context.
- Deliver compact references instead of full child output by default.
- Support independent `each` readiness and explicit sealed `group` barriers.
- Give human prompts, steering, and queued follow-ups priority.
- Consume manually retrieved terminal results before automatic delivery.
- Preserve bounded state, explicit ownership, immutable artifact identity, and
  workflow-owned child suppression.

Workflow-owned child turns remain visible through workflow progress but do not
publish direct completion notices or manifests. Only the background workflow
aggregate joins the parent coordinator.

## Terminology

- **Completion record**: a normalized parent-visible `done`, `error`, or
  `cancelled` result with a deterministic `completionId`.
- **User notice**: a durable `subagentura-completion` custom entry rendered only
  in the TUI. The entry itself is the notice reconciliation receipt.
- **Manifest**: a bounded hidden `subagent-manifest` containing statuses and
  retrieval references, never full child output by default.
- **Consumed**: terminal output was retrieved manually, so later automatic
  delivery omits the matching completion.
- **Completion group**: an explicit barrier keyed by `completionGroupId`.
- **Sealed**: the spawning parent turn settled, so no new group members may join.

## Two-channel contract

### User channel

For each parent-visible terminal record, the coordinator:

1. normalizes and bounds the record;
2. appends one `subagentura-completion` entry with `pi.appendEntry()`;
3. renders it with `pi.registerEntryRenderer()`;
4. reconciles deterministic IDs against parent session entries; and
5. excludes the entry from provider context.

`pi.sendMessage()` is never used for a user-only notice because custom messages
participate in later model context even when they do not trigger a turn.

Parent delivery fails closed behind notice persistence. A failed notice append
remains pending and blocks manifest preparation. One scheduled retry occurs when
safe, and later coordinator activity may retry again; persistent failure never
creates a tight loop. If an append writes and then throws, reconciliation sees the
existing entry and prevents a duplicate.

### Parent-model channel

A ready manifest contains JSON records inside `<completion-manifest>`:

```text
<completion-manifest>
{"completionId":"...","source":"interactive","sourceId":"...","turnId":"...","status":"done","retrieve":"read_subagent_artifact(id: \"...\", turnId: \"...\")","references":[{"label":"output","value":".../outputs/<eventId>.md"}]}
</completion-manifest>
```

Structured message details contain `completionIds` and any represented `groups`.
Interactive references prefer immutable `outputs/<eventId>.md` plus
`events.ndjson`; legacy artifacts may fall back to staging `output.md`.
In-process and workflow records point to `get_subagent_result` and
`get_workflow_result`.

Manifests are capped at 32 KiB and 128 records. A grouped unit is selected
atomically and is never split to fit. If references exceed the budget, the
manifest retains bounded retrieval calls and omits the expanded reference array.
Physical publication order is authoritative.

## Readiness policies

### `each`

Independent records become ready immediately. Records that finish while the
parent is busy coalesce at the next safe dispatch instead of creating a burst of
turns.

### `group`

Related top-level work declares `completionPolicy: "group"` and one shared,
explicit `completionGroupId`. Relatedness is never inferred from prompt text.

- Every member is registered at spawn.
- The spawning parent turn's settlement seals the group.
- Late members are rejected.
- `done`, `error`, and `cancelled` all satisfy terminality.
- Parent delivery waits until every registered member is terminal.
- Per-member TUI notices remain immediate.
- An entirely consumed group creates no empty continuation.

Membership uses bounded `source:sourceId` keys, not delivery IDs. A group supports
at most 32 members, a parent session supports at most 512 groups, and IDs are
1–128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. One source satisfies a
group once; later turns from the same source/group are independent `each` records
with distinct completion IDs.

Workflow schedulers do not seal parent completion groups for internal children.
Internal children are suppressed, and only the background workflow aggregate participates.

## Human-input priority

- Never inject a manifest into a streaming parent turn.
- Human input marks a priority fence before `agent_start`.
- `before_agent_start` attaches a ready manifest to the natural human turn.
- A separate turn-start fence closes the `before_agent_start` to `agent_start`
  race.
- Completions that arrive during a human turn wait for settlement.
- Without pending human work, safe parent idleness triggers one follow-up.
- Session replacement retires session-scoped work before it can reach a new owner.

## Manual consumption

Successful terminal output retrieval through these tools appends a matching
consumption entry before returning:

- `read_subagent_artifact` when it successfully returns a selected or latest terminal output (requesting output without a terminal snapshot does not consume);
- `get_subagent_result`;
- `get_workflow_result`.

Events-only artifact reads do not consume output. Interactive consumption matches
the immutable terminal turn, not mutable follow-up staging bytes. Protocol-v2
turn IDs remain intact up to the artifact protocol limit of 256 characters.

## Interactive follow-ups and cancellation

Every persisted child user entry produces a distinct artifact turn and immutable
snapshot. An idle follow-up resets future policy to independent `each`. A source
can satisfy a group only once, so repeated completions cannot reopen a sealed
group.

Workflow-owned children reject follow-up until the workflow has consumed the
current result and the pane is idle. The first successful follow-up promotes the
pane to standalone.

Interactive cancellation writes the cancelled artifact first. Coordinated state
then produces one TUI-only terminal notice and may later include one compact
cancellation selector; upgrade-recovered pre-coordinator intents alone retain
legacy synthetic-receipt suppression.

## API and compatibility

Spawnable asynchronous work accepts:

```text
completionPolicy: "each" | "group"  // default: "each"
completionGroupId?: string           // required for "group"
```

Deprecated `notifyOnComplete` and `triggerTurnOnComplete` inputs remain accepted.
Either legacy value maps deterministically to coordinated `each`, cannot request
full-output injection, and cannot be combined with new completion fields.

Coordinated workflow completion labels are capped at 160 characters without
changing workflow IDs, retained workflow names, or retrieval identity.

## Lifecycle and durability

Interactive completion policy, group identity, event cursors, pending intents,
and legacy receipts rehydrate only into the matching parent session. In-process
jobs and background workflows remain parent-session scoped and do not survive
session replacement. `new` and `fork` do not import prior completion work.

A successful Pi `sendMessage()` proves synchronous dispatch, not durable session
commit. Deterministic completion IDs prevent ordinary replay, but a crash in that
separate commit window can still replay a manifest. This at-least-once boundary is
not described as exactly once.

## Verification contract

Permanent regressions cover:

- independent coalescing and sealed all-terminal groups;
- errors, cancellation, late-member rejection, and one-shot group membership;
- human-input and turn-start races;
- manual consumption and immutable retrieval selection;
- bounded queues, manifests, group units, and crash/rehydrate replay;
- transient notice retry, append-then-throw reconciliation, and no retry spin;
- workflow-owned suppression and cancellation deduplication;
- accepted long workflow names and 256-character turn IDs;
- tmux, Zellij, Pi-session provider context, and terminal E2E behavior.

Required release checks:

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
npm run test:tmux
npm run test:zellij
```

Also run the terminal E2E suite. Runtime diagnostics use `debugLog`; published
runtime code must not call host `console.*` methods.

## External documentation sync handoff

The repository-managed root docs and published example guide carry the current
contract. The externally managed `pi-docs` source must mirror these changes into
`docs/workflows.md`: add the background completion API/ownership semantics and
replace mutable `output.md` polling with terminal-event selection followed by the
matching immutable `outputs/<eventId>.md` snapshot. Its frontmatter should add
`completion`, `completionPolicy`, and `completionGroupId`. The Phase 2
`docs/workflow.md` design should either gain the current coordinator flow or be
marked historical. Do not edit generated `docs/` copies in this repository.
