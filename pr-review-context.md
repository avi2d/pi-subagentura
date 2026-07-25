# PR Review Context: `master...HEAD`

## Confirmed findings

### P1 — orphaned recovery locks permanently wedge interactive state persistence

`withInteractiveStateLock()` never reclaims an existing
`subagentura-state.lock.recovery` file (`src/artifact.ts:1714-1730`). If a process
crashes after acquiring that recovery claim, future state writes time out even
when both recorded PIDs are dead. This prevents persisted interactive spawns and
subsequent cursor/delivery updates in that cwd until the file is removed
manually.

Evidence: `tests/artifact.test.ts:768-784` explicitly creates dead main and
recovery lock owners, observes the timeout, and verifies both files remain.

### P1 — `get_subagent_result` advertises blocking behavior but is non-blocking by default

The tool description and README say the call blocks until completion
(`src/tools/in-process.ts:813-817`, `README.md:281-287`), but a running job returns
immediately unless callers pass `wait: true` (`src/tools/in-process.ts:868-888`).
The README also omits the new `wait` and `timeoutMs` parameters exposed by
`src/schemas.ts:87-105`.

This mismatch can make callers believe they collected a final result when they
only received live status. Tests at `tests/in-process-tools.test.ts:540-614`
confirm the immediate-return and explicit bounded-wait behavior.

### P2 — suppressed parent delivery produces a false user notification

When explicit result retrieval suppresses LLM delivery,
`notifyInProcessCompletionWithoutDelivery()` only shows a UI notification and
does not call `sendMessage` (`src/notifications.ts:471-512`). It nevertheless
reuses the normal delivered wording, which claims that output was injected or a
pointer was persisted and that a parent turn will start
(`src/notifications.ts:304-331`).

Evidence: `tests/subagent-notify.test.ts:1189-1217` verifies that the notification
is shown while no parent message is sent. The displayed delivery claims are
therefore inaccurate.

### P3 — unrelated/stale review artifacts are committed

- `hello.md:1-3` is an unrelated “Hello, world!” file introduced by the latest
  fix commit.
- `PR-59-INDEPENDENT-REVIEW.md` describes earlier findings as current and says
  the branch is not merge-ready even though several listed P1s were fixed by
  later commits. Keeping it unchanged makes the repository state misleading.

## Unverified high-risk follow-up

### Async spawns may bind to the wrong session context while a nested child is active

Both async tools capture the process-global active context token
(`src/tools/in-process.ts:363-364,579-580`). Nested session registration replaces
that global active token (`src/session-context.ts:95-110`). Delivery later rejects
an owner whose captured context has a different `pi` identity
(`src/notifications.ts:172-175`).

This suggests that a second parent spawn made while an in-process child context
is on top of the stack can be tied to the child context, causing false spawn
cancellation or dropped parent delivery. Existing coverage only tests child
activation _after_ the parent spawn (`tests/subagent-notify.test.ts:767-845`).
I could not verify this claim with a complete concurrent second-spawn repro; add
one before treating it as a blocker.

## Validation

- `npm run typecheck` — passed
- `npm test` — 50 files, 1,121 tests passed
- `npm run format:check` — passed
- `npm run pack:check` — passed
- `git diff --check master...HEAD` — passed

A focused Luna review validated the confirmed findings above. A broader Luna
workflow exhausted its token budget before synthesis, so no claims from that
failed run are included.

## Additional confirmed findings from late Luna review

### P1 — nested async spawns can escape owner cancellation during session creation

The async tool paths await `startSubagentJob()` before registering the new child
in `jobRegistry` (`src/tools/in-process.ts:381-435` and the equivalent isolated
path at `src/tools/in-process.ts:579-610`). Transitive cancellation only scans
children already present in that registry (`src/helpers.ts:328-375`).

If the owner is cancelled during session creation, the late child is absent from
the cascade. The post-await guard checks only parent-session context liveness, not
whether `spawn.parentJobId` is still running, so the child can subsequently be
registered and started after its owner was cancelled.

Evidence: a focused Luna Vitest reproduction deferred `startSubagentJob()`,
cancelled the owner with `abortJobTree()`, then released the deferred child. The
tool returned `status: "started"` and the child appeared in `jobRegistry` after
the owner had already been cancelled.

### P1 — cancellation tools return before controller-backed sessions finish aborting

The new controller path calls `AbortController.abort()` and immediately reports
cancellation (`src/cancel-all-flows.ts:91-102`,
`src/tools/in-process.ts:1085-1102`). Its signal handler starts
`session.abort()` but discards the promise (`src/helpers.ts:684-717`), so callers
cannot wait for the agent to become idle. This regresses the previous
`await job.session.abort()` behavior for controller-backed jobs and allows
in-flight model/tool cleanup to continue after cancellation is reported and the
job is scheduled for removal.

Evidence: a focused Luna Vitest reproduction used the same controller wiring with
a deferred `session.abort()` promise; `cancelAllFlows()` resolved while that abort
promise remained pending.

## Additional workflow findings from late Luna review

### P1 — schema-valued `additionalProperties` is accepted but not enforced

Schema preflight explicitly accepts an object-valued `additionalProperties`
schema (`src/workflow-core.ts:454-460`), while value validation only handles the
literal `false` case (`src/workflow-core.ts:360-365`). As a result,
`{ n: 42 }` passes a schema requiring every additional property to be a string.
This also conflicts with the public authoring type, which exposes
`additionalProperties` as boolean-only (`types/workflow.d.ts:17`).

Evidence: a focused Luna reproduction completed after one agent call with result
`{ n: 42 }` and zero errors under
`{ type: "object", properties: {}, additionalProperties: { type: "string" } }`.

### P2 — tuple-style `items` bypasses preflight and consumes every schema retry

`validateSchemaDefinition()` does not reject array-valued `items`
(`src/workflow-core.ts:489-495`). Runtime validation then treats that array as a
schema for every element (`src/workflow-core.ts:380-383`), reports that the schema
must be an object, exhausts all retries, and returns `null`. The public subset
does not support tuple schemas, so this shape should fail before spawning agents.

Evidence: a focused Luna reproduction made three runner calls and reported
`agentsSpawned: 3`, `errorCount: 1`, and `result: null` for
`{ type: "array", items: [] }`.

### P2 — explicit agent phases are overridden by runner-emitted phases

The workflow contract says an explicit `agent(..., { phase })` value overrides
the current phase (`docs/workflows.md:39-42`). Agent start/done events use that
resolved phase, but runner phase events now forward `ev.phase` unconditionally
(`src/workflow-worker.ts:272-277`). Workflow history, current phase, and tree/UI
rows can therefore disagree for the same agent attempt.

Evidence: a focused Luna reproduction used `phase: "Explicit"` with a runner
emitting `"Internal"`; workflow phases became `["Internal"]` while start/done
events remained labeled `"Explicit"`.

## Additional API/documentation findings from late Luna review

### P2 — `notifyOnComplete: "notify"` is incorrectly described as UI-only

The LLM-facing in-process tool description calls notify mode a “UI-only hint”
(`src/tools/in-process.ts:328-334`). The implementation instead persists a
pointer-only custom message into parent context, matching the schema contract
(`src/schemas.ts:51-57`). This wording can make the parent poll unnecessarily or
assume that no completion record will enter its context.

Evidence: `tests/subagent-notify.test.ts:290-327` verifies that notify mode calls
`sendMessage` with the pointer and `triggerTurn: false`.

### P3 — workflow metadata placement is documented more strictly than enforced

The workflow prompt says the metadata export must be the first statement
(`src/workflow-tool.ts:297-300`), and the authoring docs repeat that requirement
(`docs/workflows.md:24-28`, `examples/workflows/README.md:45-48`). The parser
instead scans every top-level statement for `export const meta`
(`src/workflow-script.mjs:49-55`), so helper declarations before metadata parse
and execute successfully. Either enforce first-statement placement or document
the actual “top-level static export” contract.

Evidence: a focused Luna reproduction parsed and executed a workflow with helper
declarations before `export const meta`.

## Additional artifact and rehydration findings from late Luna review

### P1 — rehydration fails open when the current session ID is unavailable

The ownership filter runs only when `currentSessionId` is truthy
(`src/rehydrate.ts:43-48`), while session startup passes the optional result of
`getSessionId()` directly (`src/session-handlers.ts:79-83`). If the current
identity is unavailable, entries owned by any persisted parent session are
rehydrated, including their pending deliveries. Ownership should fail closed for
entries that already carry a `parentSessionId`.

Evidence: a focused Luna Vitest reproduction persisted an entry owned by
`old-session`, called `rehydrateInteractiveSubagents(cwd, undefined, [])`, and
observed that the old entry was restored.

### P2 — default artifact reads bypass the new output-size bounds

Protocol-v2 immutable delivery snapshots are bounded, but mutable `output.md` can
still be written without a cap (`src/artifact.ts:343-347`) and is read with an
unbounded synchronous `readFileSync` (`src/artifact.ts:906-914`). The default
`read_subagent_artifact` path uses that reader (`src/tools/interactive.ts:606-619`),
so a child-controlled file can force an arbitrarily large allocation and tool
response in the parent. The explicit read path needs the same bounded-read policy
or a clear rejection result.

I did not run a large-file allocation reproduction; the unbounded path is direct
from the cited code.

## Additional unverified lifecycle follow-ups

### Artifact delivery lacks a session-generation guard in late callbacks

Each registered `agent_settled` callback closes over its `pi` and calls
`flushDeliveries(pi, ...)` (`src/session-handlers.ts:49-52`). Unlike the
in-process delivery queue, `flushDeliveries()` enumerates the global interactive
registry without checking the caller's session-context identity or generation
(`src/delivery.ts:309-324`). A late callback from a replaced context could flush
new registry intents through a stale Pi context. I could not verify the exact
shutdown/reload event ordering end-to-end.

### Persisted session-log cursors can lose a partial JSONL line across restart

The poller advances and persists `lastDeliveredSessionByte` through every byte
fed into its in-memory NDJSON parser (`src/artifact-poller.ts:475-479`), but
rehydration restores only the numeric cursor (`src/rehydrate.ts:93-95`), not the
parser's buffered prefix. After restart, only the suffix of a previously partial
line is fed to a fresh parser, so that entry can be dropped permanently. I could
not verify this with a full process-restart harness.

## Additional adversarial findings from late Luna review

### P1 — `cancel_workflow` returns before process-agent snapshot receipts arrive

`waitForCancellationReceipts()` races workflow settlement against its grace timer
(`src/workflow-tool.ts:60-75`). Worker cancellation rejects the workflow promise
immediately (`src/workflow-worker.ts:400-415`), while process-agent snapshots are
created only when `awaitInteractiveResult()` reaches its next polling iteration
(`src/workflow-worker.ts:619-633`). The already-settled workflow promise therefore
wins the race and `cancel_workflow` can return `snapshots: []` before the receipt
is recorded.

Evidence: both the parent review and a Luna reviewer reproduced this with an
immediately rejected workflow promise and a delayed receipt; cancellation returned
an empty snapshot list, and the receipt appeared afterward.

### P1 — session-log parsing has an unbounded per-agent memory path

The 1 MiB limit only bounds each poll's temporary allocation
(`src/artifact-poller.ts:370-384,446-479`). The NDJSON parser is created without a
`maxLength`, so one child-controlled incomplete line accumulates internally across
unlimited ticks. Terminal persistence cleanup also does not call
`destroySessionParser()` (`src/artifact-poller.ts:247-262`), despite the helper's
state-removal comment, leaving each parser and any buffered prefix retained for
the parent process lifetime.

Evidence: direct dependency inspection confirmed the parser's `maxLength` is
undefined. A full OOM reproduction was not attempted.

## Focused remediation status

The following findings were addressed in follow-up commits; source locations above
describe the pre-remediation code:

- `062490d` — bounded session-log parsing, durable partial-line recovery, and
  parser cleanup.
- `4de0284` — rejected unsupported workflow schema forms before agent spawning.
- `f664c76` — aligned the `get_subagent_result` waiting contract with its
  non-blocking default.
- `5b865e1` — preserved explicit workflow phase precedence.
- `4a03a0d` — waited for active workflow runner lifecycles before returning
  cancellation snapshot receipts.
- `399224a` — aligned metadata-placement documentation with parser behavior.

Other findings in this document remain outside this focused remediation.

Post-remediation validation:

- `npm run typecheck` — passed
- `npm test` — 50 files, 1,133 tests passed
- `npm run format:check` — passed
- `npm run pack:check` — passed
- `git diff --check` — passed
