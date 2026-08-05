# Workflow Redesign Session Synthesis

**Date:** 2026-08-05  
**Scope:** Pi and OMC/Jcode session history for `pi-subagentura` in
`/Users/applesucks/dev/pi-agents-rc`  
**Purpose:** Consolidate what was learned about the extension, workflow redesign,
current issues, and intended future direction.

## Executive summary

The extension has evolved from a collection of sub-agent launchers into three
related systems:

1. **In-process execution** for fast, parent-session-scoped work.
2. **Interactive child execution** through tmux/Zellij, with artifact-backed
   persistence, rehydration, and durable delivery.
3. **Workflow execution** for bounded JavaScript orchestration of agents,
   phases, pipelines, parallel fan-out, schemas, budgets, and progress UI.

The central redesign insight from the sessions is that the missing abstraction is
not another workflow node or another process runner. It is a durable coordination
contract that joins delegated intent to accepted evidence:

```text
TaskContract
  -> TaskAttempt
  -> optional WorkflowJob
  -> revision-pinned EvidenceReceipts
  -> parent-controlled Verdict
```

Worker completion, structured output, artifact delivery, and process exit are
observations. None is acceptance by itself.

The recommended direction is incremental. Keep the current workflow runtime
small and trusted, add plan/preview and evidence semantics, and evaluate an
external durable coordinator such as Smithers before rebuilding the extension
around a larger orchestration engine. Jcode is a promising high-concurrency
worker harness, while Pi remains the better harness for Pi-native extensions,
interactive sessions, lifecycle hooks, and existing artifact semantics.

## Sources reviewed

The session search covered Pi, Claude, Codex, and other OMC-related sessions
associated with this repository and its workflow experiments. The most relevant
clusters were:

- **Project-history analysis:** sessions `019fbcdd` and related inventory,
  chronology, health, and live-session analyses.
- **Workflow CLI and CI design:** session `019fb792`, including the original
  requirement to run workflows in CI as separate steps.
- **Workflow redesign and external coordinator comparison:** session
  `019fbdf1`, including the v4 workflow design, Smithers comparison, Jcode
  scouting, and durable coordinator proposals.
- **Workflow implementation and usage/pricing work:** session `019fbcdc`,
  including workflow documentation, usage aggregation, provider provenance,
  cancellation, and interactive supervisor concerns.
- **Artifact contamination and environment isolation:** session `019fb9f0`,
  including the distinction between test-only mitigation, harness-level
  isolation, and full child-environment isolation.
- **Interactive and PR review sessions:** sessions `019fb9e2`, `019fbc42`,
  `019fbcdf`, `019fbcde`, and related PR-review sessions.
- **Current repository documentation:** `docs/workflows.md`, `asdf.md`, and
  `harden.md`.

The archive analysis was directional rather than a unique-task count. It found
roughly 1,730 JSONL sessions and about 575 MB of session data. It showed very
high repeated exploration and coordination activity, including approximately
43,000 shell calls, 22,500 reads, 1,430 delegated agent launches, hundreds of
status/result/artifact checks, and substantial worktree and validation activity.
These figures describe process cost, not defect counts.

## What the extension provides today

### In-process agents

In-process sub-agents are useful for short, bounded work and native structured
results. They share the parent process and are deliberately scoped to the
parent session. Background workflow jobs and asynchronous in-process jobs do not
survive parent session replacement.

The sessions repeatedly confirmed that this scope is intentional. Making those
jobs survive reload or resume would require persisted job state, safe rebinding
to the new `runAgent`, and durable notification routing. Retaining a global
registry is not sufficient.

### Interactive agents

Interactive agents run as attachable Pi children in tmux or Zellij. The important
protocol decisions are:

- Completion is authoritative at child settlement, after retries, compaction,
  and queued continuations.
- `cli.mjs done N` is a compatible explicit signal, but is idempotent by turn.
- Physical byte order, not timestamps, controls event cursors and delivery.
- Output snapshots are immutable and bounded by the maximum snapshot size.
- Delivery intents are persisted before advancing cursors.
- State is written before registry insertion during spawn.
- Interactive children can survive quit/reload/resume and be rehydrated.
- Dead panes are retained long enough for artifact inspection.

A subtle but important bug class was identified around steering while Pi is
streaming. Enter does not necessarily create a new `before_agent_start`; the
child protocol must rotate the persisted user-entry identity in
`before_provider_request`, otherwise a later completion can be deduplicated
against the previous turn and its output can be lost.

### Workflow runtime

The workflow runtime currently supports:

- Trusted agent-authored JavaScript.
- `meta` declarations.
- `phase`, `agent`, `parallel`, `pipeline`, and nested workflow helpers.
- Bounded concurrency and budgets.
- In-process and process-backed agents.
- Structured output schemas using a deliberate dependency-free subset.
- Progress and tree UI surfaces.
- A VM that hides Node globals, guards time/randomness, and disables string and
  WebAssembly code generation.

The VM is a determinism aid, not a security boundary. Workflow scripts are
trusted code and must not be treated as arbitrary user-supplied JavaScript.
File I/O belongs in sub-agents through their tools, not in the workflow VM.

## Why workflows were redesigned

The first workflow design focused on expressing orchestration. Real use exposed
a second problem: a workflow can run successfully while still failing to prove
that the requested developer task was completed correctly.

The redesign therefore shifts emphasis from **execution graph only** to
**execution plus governance**:

```text
intent -> plan -> admitted work -> execution -> evidence -> review -> verdict
```

The sessions identified these recurring weaknesses:

1. No universal task identity connecting prompts, agents, branches, worktrees,
   artifacts, reviews, validation, PRs, and cleanup.
2. No durable cross-session ledger for planned, active, blocked, verified,
   committed, merged, or abandoned work.
3. Implicit write ownership, allowing parallel agents to overlap on shared
   files.
4. Reviews that are not always pinned to one base/head revision.
5. Validation results recorded in prose or command output instead of structured
   receipts.
6. Process completion being confused with task completion.
7. Parallel artifact notifications arriving independently and triggering
   premature or repeated synthesis.
8. Operational state split across sessions, panes, processes, worktrees, and
   artifact directories.
9. Manual and potentially unsafe cleanup.
10. Ambiguous workflow usage and pricing display.
11. Workflow limitations around interactive approvals and pre-execution
    visibility.
12. Environment contamination when multiple agents run tests in the same
    process or inherit parent variables and markers.

## Current issues and their practical impact

### 1. No task contract

Every child reconstructs objective, scope, ownership, revision, and acceptance
criteria. This creates setup repetition and scope drift.

**Needed:** a task card containing at least objective, owner, read scope, write
scope, target revision, acceptance criteria, validation profile, stop condition,
and delivery mode.

### 2. No durable task ledger

State is distributed across conversation text, artifacts, git, panes, and CI.
There is no single authoritative lifecycle such as:

```text
planned -> claimed -> implementing -> review-needed -> validating
         -> handoff -> committed -> pushed/merged
```

The ledger also needs `blocked`, `partial`, `cancelled`, and `superseded` states.

### 3. Parallel write ownership is implicit

Parallel read-only scouting is safe. Parallel writing is not safe without
admission control. Shared files and integration points need one owner or an
explicit integrator. Conflict reporting alone is not locking or write
authorization.

### 4. Review evidence can become stale

A reviewer may inspect the wrong branch, stale commit, or already-changed
revision. Every review packet should contain base SHA, head SHA, branch,
worktree, scope, and explicit finding status:

```text
verified | already-fixed | unverified | out-of-scope | blocking
```

### 5. Validation is repetitive and weakly recorded

The observed validation ladder is sound:

```text
focused reproduction/test
-> typecheck and format
-> full test suite
-> package/build checks
-> integration, TUI, or release smoke test
```

The problem is that it is manually repeated and its exit code, duration, skip
reason, and tested revision are not consistently captured.

**Needed:** named allowlisted profiles such as `focused`, `full`, `integration`,
`tui`, `package`, and `release`, with durable validation receipts.

### 6. Completion is not acceptance

The following must remain separate:

```text
worker process exit
worker terminal event
schema-valid worker output
workflow task completion
validation receipt
parent verdict
notification delivery
```

A child should not be marked verified merely because it exited successfully or
returned JSON that passed schema validation.

### 7. Batch delivery is not grouped

Parallel completions can arrive as independent pointers. The parent may react
to the first result before the batch is complete, causing interleaved messages or
repeated synthesis.

**Needed:** a batch ID, expected member set, collected handoff packets, and one
synthesis trigger at batch completion. Delivery-layer batching is required;
prompt instructions alone cannot reorder native notifications.

### 8. Operational state is distributed

The developer currently correlates task, parent session, child ID, pane,
process, artifact directory, branch, worktree, and latest event manually.
Stale panes and artifacts marked `running` after process exit were observed.

**Needed:** one read-only status view joining these identities and reporting
`active`, `awaiting-follow-up`, `completed`, `blocked`, and `orphaned`.

### 9. Cleanup is manual

Stale panes, launchers, sockets, artifacts, and worktrees accumulate. Cleanup
must distinguish dead processes from old but durable evidence.

**Needed:** report-only cleanup first, explicit confirmation for destructive
operations, and preservation of durable sessions and evidence.

### 10. Workflow usage and pricing are ambiguous

The sessions found that `tokensSpent` is an output-token counter, while
`usage.totalTokens` includes input, output, and cache tokens. The UI can show
both beside one another as if they represented the same quantity. A zero cost
may mean free, unavailable, or unreported pricing.

**Needed:** one canonical formatter, explicit input/output/cache/cost labels,
an output-token budget label, per-agent/model attribution where available, and
cost provenance such as `reported`, `estimated`, or `unavailable`.

### 11. CI execution needs a stable boundary

The initial workflow goal was to run workflows in CI as separate steps. A
foreground, synchronous CLI boundary is the smallest useful implementation.
The runtime must return a non-zero exit status for failed workflow acceptance,
while preserving structured progress and receipts for CI logs.

A later durable coordinator can use JSON-RPC/ACP or a service boundary, but the
extension should not immediately make a large external system a runtime
requirement.

### 12. Test environment isolation

The artifact-contamination investigation distinguished three options:

- **A: test-only mitigation.** Fast but leaves the harness unsafe.
- **B: harness-level fix plus defense in depth.** Preferred near-term path.
- **C: full production child-environment isolation.** Strongest, but larger and
  more invasive.

The recurring issue is that child tests can inherit environment variables,
markers, or artifact paths from the parent, especially when multiple agents run
at once. The recommended order is B first, with a path toward C for interactive
or production child processes.

## External coordinator comparison

### Smithers

The sessions evaluated Smithers as an external durable coordinator. Its useful
capabilities include persisted runs and tasks, stable attempts, resume,
sequence/branch/loop/parallel graphs, bounded concurrency, schemas, retries,
approvals, signals, worktree isolation, VCS identity, heartbeats, status APIs,
and Pi integration seams.

The recommendation is **not** to make Smithers a normal runtime dependency.
Reasons include its newer runtime requirements, larger operational footprint,
competing lifecycle/UI models, and the added database, credentials, gateway,
and cleanup responsibilities.

A reversible experiment should instead implement a small adapter or proof of
concept. Smithers owns durable scheduling and acceptance. Pi or Jcode adapters
only own harness startup, prompt delivery, event translation, cancellation, and
raw transcript/usage capture.

### Jcode

Jcode was identified as a promising high-concurrency harness candidate because
it offers a shared daemon, reconnectable sessions, journals, snapshots, swarm
coordination, conflict notifications, optional worktrees, and session search.
The repository's published memory comparison favors Jcode, but that benchmark
was not independently reproduced.

Jcode conflict notifications are not write authorization, locking, merge
handling, or acceptance authority. A coordinator must still impose worktree and
write-scope isolation.

Candidate boundaries, in increasing durability:

1. `jcode run --ndjson` for a one-shot proof of concept.
2. `jcode acp` for JSON-RPC session creation, prompting, cancellation, and
   reconnectable execution.
3. `jcode serve` for a long-lived worker pool, only if its protocol is made
   stable enough for this use.

### Pi and pi-subagentura

Pi remains the correct harness when work requires Pi extensions and skills,
Pi lifecycle hooks, direct SDK integration, tool interception, interactive
steering, attachable sessions, or existing artifact/delivery semantics.

The likely long-term design is therefore a coordinator with replaceable worker
adapters rather than a single universal worker implementation.

## Proposed workflow model

### Task kinds and policy profiles

Workflows should eventually declare a task kind and required gates. Proposed
kinds are:

| Kind            | Planning                            | Required evidence                                               |
| --------------- | ----------------------------------- | --------------------------------------------------------------- |
| `bugfix`        | Required for non-trivial bugs       | Reproduction or explicit `not-reproduced`, plus regression test |
| `feature`       | Required for medium/high complexity | Acceptance criteria and tests                                   |
| `refactor`      | Required                            | Characterization or invariant tests                             |
| `investigation` | Optional                            | Evidence report, no code changes                                |
| `docs`          | Usually optional                    | Link, format, and build checks                                  |
| `release`       | Required                            | Package, CI, version, and publish checks                        |

A bug that cannot be reproduced must end as `not-reproduced` or `inconclusive`,
not `fixed`.

### Plan and execution lifecycle

```text
create -> parse -> plan -> preview -> approve -> execute -> verify -> handoff
```

A plan preview should include:

- workflow source and source hash;
- normalized arguments and arguments hash;
- base commit, branch, worktree, provider/model, budget, and limits;
- phases, dependencies, parallel groups, writers, retries, and gates;
- known, conditional, and runtime-expanded nodes;
- expected output schema at every agent boundary.

The same plan should be renderable as text, JSON, Mermaid, and a collapsible
source view. Execution must re-check source and argument hashes so approval
cannot silently authorize a different run.

A possible future API is:

```js
workflow({ script, args, mode: "plan" });
workflow({ planId, mode: "run" });
```

Because workflow JavaScript can branch, loop, inspect args, and use agent output,
not every node can be statically known. The UI should label static nodes,
conditional nodes, and runtime-expanded nodes rather than pretending the graph
is complete.

## Recommended implementation sequence

### Phase 0: stabilize and document current behavior

- Keep `docs/workflows.md` as the runtime authoring reference.
- Preserve the VM as trusted-code orchestration, not a security boundary.
- Document CI invocation and synchronous exit semantics.
- Keep the dependency-free schema validator.
- Add regression tests for malformed output, partial writes, args as object or
  JSON string, and large payload handling.

### Phase 1: introduce explicit task and evidence contracts

- Add a task-card type without changing all tools at once.
- Add task, attempt, run, and revision identifiers.
- Record base/head/tree identity and worktree in handoffs.
- Add structured validation receipts with command, cwd, revision, exit code,
  duration, status, and skip/block reason.
- Keep parent verdict separate from worker result.

### Phase 2: add plan/preview mode

- Extend metadata parsing conservatively.
- Add normalized args and source hashes.
- Produce a plan artifact before execution.
- Show static and dynamic graph portions.
- Add explicit approval before writes for bugfix, feature, refactor, and release
  profiles where appropriate.

### Phase 3: improve batch coordination and status

- Add batch IDs and expected member sets.
- Persist collected handoffs before synthesis.
- Build a joined status view across task, agent, pane, process, artifact,
  worktree, and latest event.
- Add conservative orphan detection and report-only cleanup.

### Phase 4: harden child isolation

- First fix harness-level environment and artifact-path inheritance.
- Add defense-in-depth checks preventing a child from writing to a parent
  artifact directory unless explicitly authorized.
- Add real child-process integration tests with multiple concurrent agents.
- Evaluate full production isolation for interactive and CI execution.

### Phase 5: evaluate an external coordinator

- Build a disposable Smithers or equivalent proof of concept.
- Start with `jcode run --ndjson` as the smallest adapter boundary.
- Move to ACP only after the one-shot contract is measured.
- Keep the external coordinator optional and out of the core package until
  durability, cancellation, resource use, output stability, and recovery are
  locally measured.

## Acceptance criteria for the redesign

The redesign is materially successful when:

1. A delegated task has one durable identity across parent, child, workflow,
   branch, worktree, artifacts, validation, review, and delivery.
2. Every write-capable worker has an explicit non-overlapping write scope.
3. Reviews and validation are pinned to exact revisions.
4. A process exit cannot be mistaken for a verified task.
5. Parallel work produces one complete batch handoff instead of interleaved
   independent follow-ups.
6. CI can run a workflow as a separate step and receive a reliable exit status.
7. Child tests cannot silently inherit parent artifact/environment state.
8. A plan can be inspected and approved before execution.
9. Usage and cost are labeled consistently and distinguish unknown from zero.
10. Cleanup is observable and conservative by default.
11. Interactive children retain their existing byte-ordered artifact and
    rehydration guarantees.
12. The core extension remains small enough to support Node 18 and existing Pi
    SDK versions.

## Decisions to preserve

- Do not use timestamps as authoritative protocol ordering.
- Do not treat the workflow VM as a security sandbox.
- Do not replace the hand-rolled workflow JSON Schema subset with a dependency
  without a strong reason.
- Do not make background in-process jobs survive session replacement casually.
- Do not treat Jcode conflict reports as locking or acceptance.
- Do not make Smithers or another large external system a mandatory runtime
  dependency before a reversible proof of concept.
- Do not let a prompt claim completion without a structured handoff and evidence.
- Do not destroy stale panes, artifacts, or worktrees without an explicit
  cleanup decision.

## Bottom line

The extension should become a **small execution harness with strong identity,
evidence, and delivery contracts**, not a monolithic workflow operating system.
Keep Pi-native interactive capabilities, improve the workflow runtime with
preview, policy, receipts, and batch semantics, and experiment with Jcode or
Smithers behind replaceable adapters. This preserves the working parts while
addressing the actual source of pain: repeated context reconstruction, implicit
ownership, stale review/validation evidence, weak cross-session state, and the
confusion between activity and acceptance.
