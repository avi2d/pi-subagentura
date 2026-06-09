# Plan B: Sidecar Subprocess Runner

**Status:** Draft (revised for cross-platform v1 — 2026-06-09)
**Date:** 2026-06-08 (revised 2026-06-09)
**Target release:** pi-subagentura 2.2.0
**Author:** planning agent
**Revision note:** Sections updated for cross-platform from day one: added G9 (cross-platform goal), replaced N5 (was "no Windows support") with the cross-platform contract, added §11 (compatibility matrix), reframed R10 as a regression-prevention risk, updated Q2/Q3/§4/§8 for the v1 cross-platform commitment. See commit for the full diff.
**Author:** planning agent

## 1. One-paragraph summary

Add a new npm bin `pi-workflow-runner` that lives as a long-lived child process spawned by the parent Pi on demand. The parent sends `{ script, args, cwd, workflowId }` over stdio as NDJSON; the runner executes the script in its own V8 isolate, calls the same `subagent_*` SDK functions (transitively, by importing `startSubagentJob` from `helpers.ts`) in its own process, streams lifecycle events back as NDJSON, and only ships the final return value to the parent when the script resolves. The runner outlives a single parent turn — a workflow can keep running while the user types a new prompt — and survives parent crashes (the runner keeps going and writes its result to a per-workflow artifact dir for the next parent to discover). **Headline tradeoff:** highest resilience and the most code; a new bin, a stdio protocol, and a "lifecycle daemon" that the package must manage across Pi restarts.

## 2. Goals & non-goals

### Goals

- **G1.** Ship a new npm bin `pi-workflow-runner` (lives in `bin/pi-workflow-runner.mjs`, declared in `package.json` `bin`) that the parent spawns on demand. The runner is a long-lived subprocess (not one-per-workflow).
- **G2.** Ship one new tool `run_workflow({ script, args, async, … })` whose sync path: spawns the runner if it isn't running, sends a `start` message, awaits the `done`/`error` NDJSON response, returns the final value to the LLM.
- **G3.** Define a stable NDJSON protocol over stdio for `{ start, progress, spawn_request, spawn_result, log, done, error, cancel, ping, pong }` messages. Document it in `docs/workflow-protocol.md`.
- **G4.** The runner reuses `startSubagentJob` from `helpers.ts` and `jobRegistry` semantics — but the runner is its own process, so the registry is per-runner, not global. Workflows started by the runner are owned by the runner.
- **G5.** Persistence: the runner writes each workflow's progress to an artifact dir (`~/.pi/agent/sessions/subagentura/workflows/<id>/events.ndjson` + `output.md`). The parent re-discovers a running workflow from disk on Pi restart, so a workflow that finishes while the parent is down is picked up on the next tool call.
- **G6.** A single long-lived runner per parent Pi process. If the runner dies, the next `run_workflow` call spawns a fresh one. Existing in-flight workflows in the dead runner are marked `error: "runner_died"` and surfaced to the LLM on `get_workflow_result`.
- **G8.** Bundle one demo `demos/audit-xss.mjs` and ship `bin/pi-workflow-runner.mjs` with the published package.
- **G9.** **Cross-platform from day one.** The runner, the protocol, the file handling, the signal handling, and the path handling must work identically on macOS, Linux, and Windows. No `chmod`, no `/tmp`, no `~/.foo`, no `process.kill(0)`, no `detached: true`, no `shell: true`. Tested on all three before release. See §11 for the full compatibility matrix.

### Non-goals

- **N1.** We are NOT building a daemon/service out-of-process of Pi. The runner is spawned by Pi and dies with Pi (unless Pi is restarted; the runner can persist across Pi restarts in v2, see §10 Q3).
- **N2.** We are NOT adding a separate CLI for users to invoke workflows by hand in v1. Workflows run via the `run_workflow` tool only. (A `pi-workflow-runner run <script>` CLI may come in v2.)
- **N3.** We are NOT implementing checkpointing/resume in v1. The script is sync-from-the-LLM's-perspective. A script that crashes mid-run is reported as an error, period. Resumable workflows are a v3 concern.
- **N4.** We are NOT changing the existing in-process sub-agent path. `subagent_with_context` / `subagent_isolated` still run inside the parent Pi. The runner uses `startSubagentJob` only when the workflow's script calls `ctx.spawn`.
- **N5.** We are NOT targeting POSIX-only signal semantics. The runner handles `SIGINT` (Unix + Windows console), `SIGTERM` (Unix), and `SIGBREAK` (Windows console) for graceful shutdown, and falls back to `subprocess.kill()` for forceful termination on both platforms. We do NOT assume Unix-domain sockets, `chmod 0o700`, `/tmp`, `~/.foo`, `process.kill(0)` liveness probes, `subprocess.spawn({ detached: true })`, or `shell: true`. See §11 for the full cross-platform compatibility matrix.
- **N6.** We are NOT changing `interactive-tmux.ts`. The runner does not spawn tmux panes.

## 3. Public API

### 3.1 The new tool: `run_workflow`

Identical schema to Plan A's `run_workflow` (§3.1 of `spec-workflow-A-vm.md`). The behavioral difference is hidden behind the tool handler: Plan B's handler sends an NDJSON `start` message to the runner and awaits a `done` message.

```ts
const RunWorkflowParams = Type.Object({
  script: Type.String({
    description:
      "Absolute path to a .mjs workflow script. Must live under ~/.pi/workflows/ or the current working directory.",
  }),
  args: Type.Optional(Type.Record(Type.String(), Type.Any())),
  cwd: Type.Optional(Type.String()),
  concurrency: Type.Optional(Type.Number({ description: "Default 8." })),
  maxDurationMs: Type.Optional(Type.Number({ description: "Default 600000 (10 min)." })),
  async: Type.Optional(Type.Boolean()),
  notifyOnComplete: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("inject")])),
});
```

### 3.2 Companion tools

- `get_workflow_status({ workflowId })` — reads the workflow's artifact dir; returns `{ status, lastEvent, lastUpdate }`. Reuses the existing `readEvents` / `readOutput` helpers from `artifact.ts`.
- `get_workflow_result({ workflowId })` — blocks (with a 30s ceiling) until the workflow is `done`/`error`/`cancelled`, then returns the final value. Beyond 30s, returns the current status and a "still running" hint.
- `cancel_workflow({ workflowId })` — sends an NDJSON `cancel` message to the runner. The runner marks the workflow cancelled and writes a `cancelled` event to the artifact.
- `prune_subagent_jobs` — extended to also clean up completed workflow artifacts whose TTL has passed.

### 3.3 The new npm bin: `pi-workflow-runner`

A new `bin` entry in `package.json`:

```json
"bin": {
  "pi-subagentura": "bin/cli-placeholder.mjs",
  "pi-workflow-runner": "bin/pi-workflow-runner.mjs"
}
```

The runner is a Node script. It accepts one positional arg `--stdio` (default) or `--socket <path>` (v2, see §10 Q3). On startup, it writes a "ready" line to its chosen transport and waits for messages.

The runner is **not** a separate npm package. It's part of `pi-subagentura` and is installed alongside the extension. (`pi install npm:pi-subagentura` puts the bin on `$PATH`.)

### 3.4 The NDJSON protocol

One JSON object per line on stdio. Newline-delimited so partial reads are recoverable.

**Parent → Runner:**

| Message | Fields | Notes |
|---------|--------|-------|
| `start` | `{ type: "start", workflowId, script, args, cwd, concurrency, maxDurationMs }` | Start a new workflow. The runner replies with `progress: started` then later `done` or `error`. |
| `cancel` | `{ type: "cancel", workflowId }` | Mark the workflow cancelled. Runner replies with `cancelled` event. |
| `ping` | `{ type: "ping" }` | Health check. Runner replies `pong`. |
| `shutdown` | `{ type: "shutdown" }` | Graceful stop. Runner drains in-flight workflows (waiting for `maxDurationMs` cap) and exits. |

**Runner → Parent:**

| Message | Fields | Notes |
|---------|--------|-------|
| `progress` | `{ type: "progress", workflowId, phase: "started" \| "log" \| "spawn_started" \| "spawn_done", payload? }` | Lifecycle event. Also appended to the artifact dir. |
| `done` | `{ type: "done", workflowId, value, usage }` | Workflow completed successfully. `value` is `JSON.stringify`'d. |
| `error` | `{ type: "error", workflowId, message, stack? }` | Workflow failed. |
| `cancelled` | `{ type: "cancelled", workflowId }` | Workflow was cancelled. |
| `pong` | `{ type: "pong" }` | Health reply. |

`spawn_started` / `spawn_done` are the runner's way of telling the parent "a sub-agent is now running" so the TUI widget can show progress. The runner does **not** stream sub-agent output to the parent — the LLM doesn't want to see it. The parent only sees the workflow's final return value.

### 3.5 Decision rubric: `run_workflow` vs `subagent_*`

Same as Plan A (§3.5 of `spec-workflow-A-vm.md`). The decision is about intermediate state, not about where the code runs.

### 3.6 Decision rubric: Plan A vs Plan B

| | Use Plan A (in-process vm) | Use Plan B (sidecar) |
|---|---|---|
| User is in the middle of a turn | Workflow blocks the turn (expected) | Workflow can keep running while user types a new prompt |
| Parent Pi is about to crash / `session_shutdown` | Workflow dies with the parent | Workflow keeps going; picked up on next parent start |
| Workflows are short-lived (< 1 min) | Yes | Yes (slight startup cost) |
| Workflows are long-lived (10 min+) | No — risk of `maxDurationMs` cap | Yes — natural fit |
| User wants to attach and steer the workflow mid-run | No | No (that's `subagent_interactive`'s job) |

## 4. Architecture & data flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ Parent Pi process                                                     │
│                                                                       │
│  ┌─────────────────────┐                                              │
│  │  subagent.ts        │                                              │
│  │  registerTool(...)  │                                              │
│  └─────────┬───────────┘                                              │
│            │ execute()                                                │
│            ▼                                                          │
│  ┌─────────────────────┐      spawn('node', [bin], {stdio: 'pipe'})  │
│  │  run_workflow       │ ─────────────────────────────────────┐      │
│  │  tool handler       │                                      │      │
│  └─────────┬───────────┘                                      │      │
│            │                                                  ▼      │
│            │ ndjson out ◀───────────  ┌─────────────────────────┐  │
│            │                          │  bin/pi-workflow-runner  │  │
│            │ ndjson in  ──────────▶   │  (child process)         │  │
│            │                          │                          │  │
│            ▼                          │  ┌───────────────────┐   │  │
│   AgentToolResult                      │  │ node:vm.Script     │   │  │
│   { content: [                        │  │ + sandbox          │   │  │
│   { text: JSON(retval) } ] }          │  └─────────┬─────────┘   │  │
│                                        │            │              │  │
│                                        │            ▼              │  │
│                                        │   workflow script         │  │
│                                        │   default export          │  │
│                                        │   async(args, ctx)        │  │
│                                        │            │              │  │
│                                        │            ▼              │  │
│                                        │   ctx.spawn               │  │
│                                        │   startSubagentJob(...)   │  │
│                                        │   (helpers.ts)            │  │
│                                        │            │              │  │
│                                        │   jobRegistry in runner   │  │
│                                        └────────────┼──────────────┘  │
│                                                         │             │
│   ┌─────────────────────────────────────────────────────┘             │
│   │  artifact dir:                                                     │
│   │  ~/.pi/agent/sessions/subagentura/workflows/<id>/                   │
│   │    events.ndjson                                                   │
│   │    output.md  (final return value, atomically written)             │
│   │    cli.mjs   (lifecycle CLI, same shape as interactive-tmux.ts)    │
│   │                                                                    │
│   └────────────────────────────────────────────────────────────────────┘
│                                                                       │
│   TUI widget:                                                          │
│   ▶ audit-xss: phase=parallel(43/500) ...                             │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
   ──────── process boundary (parent ↔ runner is a child process) ───
   ──────── thread boundary (none — each process has its own event loop)
   ──────── context boundary (workflow↔sub-agent is startSubagentJob,    │
                                  same as today, in the runner's heap)
```

**Key invariants**

- The runner is one process. Multiple concurrent workflows share the runner's event loop. (A misbehaving workflow can still block the runner; see R1.)
- The runner is a child of the parent Pi. v1 keeps the runner attached and accepts that parent death = workflow death, with the same "picked up from artifact" recovery path. v2's optional detach uses platform-appropriate flags (POSIX: `detached: true` + `ping`/`pong` liveness; Windows: best-effort `detached: true` with a documented caveat that Windows does not have a true detached-daemon primitive; see §10 Q3 and §11 for the full story).
- The artifact dir is the source of truth. The runner's in-memory state and the parent's in-memory state are both caches. Re-discovery is by reading the artifact dir.
- `startSubagentJob` is imported by the runner from `./helpers.js` — but the runner's `jobRegistry` is its own `Map`, isolated from the parent's. A workflow's sub-agents do not appear in the parent's `get_subagent_status`. (This is intentional: the LLM doesn't need to see them.)

## 5. File-by-file implementation outline

### 5.1 New files

#### `bin/pi-workflow-runner.mjs` (NEW — ~700 LOC)

The runner binary. Standalone — no TypeScript, plain ESM `.mjs` so it runs without a build step. (The repo's `tsconfig.json` is `noEmit`, so we can't run TS directly. The bin must be `.mjs`.)

**Purpose:** Listen on stdio, parse NDJSON, execute workflows, stream progress.

**Key exports:** None (it's a CLI).

**Internal structure:**

1. **Shebang + bootstrap** (~20 LOC) — `#!/usr/bin/env node`, parse argv for `--stdio` / `--socket <path>`, set up transport.
2. **NDJSON transport** (~80 LOC) — `class StdioTransport { write(msg), onMessage(cb), close() }`. Uses `readline` over `process.stdin`; writes one line per message to `process.stdout`. Backpressure-aware: `process.stdout.write` returns false → await `drain`.
3. **WorkflowRegistry** (~120 LOC) — per-runner `Map<workflowId, WorkflowEntry>`. `WorkflowEntry = { script, args, cwd, signal, abortController, artifact, status, startedAt, usage }`. Methods: `start(entry)`, `cancel(id)`, `list()`, `cleanup()`.
4. **WorkflowExecutor** (~250 LOC) — given a `start` message, runs:
   - Validate script path via `isAllowedWorkflowPath` (reused from `workflow-allowlist.ts`).
   - Read script text, `vm.createContext` sandbox (same code as Plan A's `workflow.ts:buildSandbox`).
   - Run the script's `default` export, hook its `ctx.spawn` to a runner-side `startSubagentJob` call.
   - Aggregate usage, write `output.md` on completion, send `done` or `error` message.
5. **NDJSON handlers** (~150 LOC) — `on("start")`, `on("cancel")`, `on("ping")`, `on("shutdown")`. Each calls into `WorkflowRegistry` / `WorkflowExecutor`. Also handles `process.on("SIGTERM")` for graceful shutdown.
6. **Lifecycle CLI source** (~50 LOC) — `CLI_SOURCE` string exported alongside (mirroring `subagent-artifact-cli.ts:28-69`). The runner writes this to `<artifact>/cli.mjs` so a future out-of-process observer can call `done`/`error`/`cancelled` if needed.
7. **Logging** (~30 LOC) — pretty-prints to stderr (so it doesn't pollute the NDJSON stream on stdout). Honors `SUBAGENT_DEBUG_LOG_DIR` env var (same as `helpers.ts:32-49`).

**~LOC estimate:** 700.

#### `workflow-runner-protocol.ts` (NEW — ~200 LOC)

**Purpose:** Shared protocol types and a `validateMessage()` function used by both parent and runner.

**Key exports:**

```ts
// Discriminated union for parent → runner
export type ParentToRunner =
  | { type: "start"; workflowId: string; script: string; args: Record<string, unknown>; cwd: string; concurrency: number; maxDurationMs: number }
  | { type: "cancel"; workflowId: string }
  | { type: "ping" }
  | { type: "shutdown" };

// Discriminated union for runner → parent
export type RunnerToParent =
  | { type: "progress"; workflowId: string; phase: "started" | "log" | "spawn_started" | "spawn_done"; payload?: unknown }
  | { type: "done"; workflowId: string; value: string; usage: SubagentResult["usage"] }
  | { type: "error"; workflowId: string; message: string; stack?: string }
  | { type: "cancelled"; workflowId: string }
  | { type: "pong" };

export function validateMessage(raw: string): ParentToRunner | RunnerToParent | null;
```

**Internal structure:**

1. **Type definitions** (~80 LOC) — the two unions plus their semantic comments.
2. **`validateMessage`** (~60 LOC) — JSON.parse, check `type` is a known string, check required fields per type, return parsed or `null`.
3. **Test helpers** (~60 LOC) — round-trip encode/decode, snapshot tests for the schema.

**~LOC estimate:** 200.

#### `workflow-runner-host.ts` (NEW — ~400 LOC)

The in-parent host that owns the runner subprocess. Lives in the parent Pi process; the `run_workflow` tool handler calls into it.

**Purpose:** Spawn the runner, route messages, track in-flight workflows, implement TUI widget.

**Key exports:**

```ts
export class WorkflowRunnerHost {
  constructor(opts: { binPath: string; artifactRoot: string });
  ensureRunning(): Promise<void>;                              // spawn if not running
  startWorkflow(req: StartRequest): AsyncIterable<RunnerToParent>; // returns event stream
  cancelWorkflow(workflowId: string): Promise<void>;
  shutdown(): Promise<void>;
  /** TUI widget payload — current workflow summary for the activity widget. */
  getActivityRows(): string[];
  /** Re-discover running workflows from disk on parent startup. */
  rehydrateFromArtifacts(): Promise<WorkflowSummary[]>;
}
```

**Internal structure:**

1. **Subprocess management** (~120 LOC) — `child_process.spawn` with `stdio: ["pipe", "pipe", "pipe"]`. Wire stdout to NDJSON parser, stderr to `debugLog`. Handle `exit`/`error` events; on unexpected exit, mark all in-flight workflows as `error: "runner_died"`. Health-check loop: every 30s send `ping`, expect `pong` within 1s. On miss, kill the runner and let the next `run_workflow` call respawn.
2. **Message routing** (~80 LOC) — `Map<workflowId, { resolve, reject, onProgress }>`. Each `start` returns an `AsyncIterable` that yields `RunnerToParent` messages until `done`/`error`/`cancelled`.
3. **Artifact writes** (~80 LOC) — the host also writes to the artifact dir (in addition to the runner) so a parent restart can rehydrate. Use the existing `appendEvent` from `artifact.ts:67` and `writeOutput` from `artifact.ts:77`.
4. **TUI integration** (~80 LOC) — register a `setWidget` like the existing `subagentura-activity` widget (`subagent.ts:590-594`). The widget shows: workflow count, name (derived from `script` filename), `phase` from the most recent `progress` message, time-since-last-event.
5. **Rehydration** (~40 LOC) — on `session_start` (mirroring `subagent.ts:972-974`), walk the artifact dir, pick up workflows that are still `running` (last event is `started` or `progress` with no terminal event after), and surface them in `get_workflow_status`.

**~LOC estimate:** 400.

#### `workflow.ts` (NEW — ~250 LOC)

Same as Plan A's `workflow.ts` but **only the types and combinators** (`parallel`, `series`, `define`). The executor lives in the runner. The `vm` sandbox-builder also lives here because both the parent (for protocol-banner validation) and the runner need to construct sandboxes.

**Key exports:**

```ts
export interface WorkflowContext { /* same as Plan A */ }
export async function parallel<T>(tasks: Array<() => Promise<T>>, opts?: { concurrency?: number; signal?: AbortSignal }): Promise<T[]>;
export async function series<T>(tasks: Array<() => Promise<T>>, opts?: { signal?: AbortSignal }): Promise<T[]>;
export function define<I, O>(step: DefinedStep<I, O>): DefinedStep<I, O>;
export function buildSandbox(ctx: WorkflowContext): vm.Context;
export const WORKFLOW_PROTOCOL_BANNER: string;
```

**~LOC estimate:** 250.

#### `workflow-allowlist.ts` (NEW — ~80 LOC)

Identical to Plan A's `workflow-allowlist.ts`. Lives at the repo root, imported by both the parent (for tool-time validation) and the runner (for defense in depth).

#### `workflow-runner-host.test.ts` (NEW — ~300 LOC)

Unit tests for the host class using `vi.mock("node:child_process")` to fake the runner subprocess.

#### `workflow-runner-protocol.test.ts` (NEW — ~150 LOC)

Round-trip tests for the NDJSON protocol.

#### `workflow.test.ts` (NEW — ~250 LOC)

Tests for `parallel` / `series` / `define` (reused from Plan A).

#### `workflow-runner-integration.test.ts` (NEW — ~300 LOC)

Spawns the real `bin/pi-workflow-runner.mjs` as a child process and exercises the protocol end-to-end with a real workflow script.

#### `demos/audit-xss.mjs` (NEW — ~50 LOC)

The example workflow from the spec — files in, parallel audits, parallel refutes, return sample. Used in the README and the integration test.

### 5.2 Modified files

#### `subagent.ts` (MODIFIED — +180 LOC delta)

1. Import `WorkflowRunnerHost`, `validateMessage`.
2. Register `run_workflow`, `get_workflow_status`, `get_workflow_result`, `cancel_workflow` tools (~150 LOC).
3. In `session_start`, call `host.rehydrateFromArtifacts()` and surface running workflows to the LLM via a follow-up message (~10 LOC).
4. In `session_shutdown`, call `host.shutdown()` (best-effort, with a 1s timeout).
5. Re-export the new public types from the bottom of the file.

#### `package.json` (MODIFIED — +6 LOC delta)

```diff
 "files": [
   "subagent.ts",
   "interactive-tmux.ts",
   "artifact.ts",
   "subagent-artifact-cli.ts",
   "helpers.ts",
+  "workflow.ts",
+  "workflow-allowlist.ts",
+  "workflow-runner-protocol.ts",
+  "workflow-runner-host.ts",
+  "bin/pi-workflow-runner.mjs",
   "LICENSE"
 ],
+ "bin": {
+   "pi-workflow-runner": "bin/pi-workflow-runner.mjs"
+ }
```

No new runtime dependencies (Node builtins + existing `typebox`, `ndjson`, `is-path-inside`).

#### `README.md` (MODIFIED — +80 LOC)

New "Workflows (sidecar runner)" section. Document the runner's lifecycle, the protocol, the recovery path, and the "vs subagents" decision rubric.

#### `docs/workflow-protocol.md` (NEW — ~150 LOC)

Public protocol spec, mirrored from the `workflow-runner-protocol.ts` comments. Pin the schema so v2 can ship wire-incompatible changes under a versioned `protocolVersion` field.

### 5.3 Files NOT modified

- `helpers.ts` — `startSubagentJob` is imported by the runner, no changes needed. The `JobState.kind` discriminator is a Plan A concern; for Plan B, the runner's `jobRegistry` is private and never seen by the parent.
- `interactive-tmux.ts`, `subagent-artifact-cli.ts` — out of scope.

## 6. Test plan

### 6.1 Unit tests

- **`workflow-runner-protocol.test.ts`** — round-trip encode/decode for every message type. `validateMessage` returns `null` for missing fields, wrong types, unknown `type` strings.
- **`workflow-runner-host.test.ts`** — uses `vi.mock("node:child_process")` to fake the runner:
  - `ensureRunning()` spawns when not running, returns immediately when already running.
  - `startWorkflow()` sends a `start` message and yields `progress` → `done`.
  - `startWorkflow()` propagates `error` messages.
  - On runner `exit`, all in-flight workflows are resolved with `{ type: "error", message: "runner_died" }`.
  - Health check: kill the fake runner, expect the host to mark it dead and respawn on next call.
- **`workflow.test.ts`** — `parallel` concurrency, `series` order, `define` identity.
- **`workflow-allowlist.ts`** — same as Plan A.

### 6.2 Integration tests (`workflow-runner-integration.test.ts`)

Spawn the real `bin/pi-workflow-runner.mjs` as a child process (via `child_process.spawn` in the test):

- **Happy path**: a workflow script that returns `{ count: 3 }` is sent over stdio. Assert the runner replies with a `progress: started`, then a `done` with the value.
- **Sub-agent spawn**: a workflow that calls `ctx.spawn` 2 times (mocked via `vi.mock("./helpers")` in the runner process) is verified to receive both `spawn_started` / `spawn_done` progress events and aggregate the usage.
- **Cancel**: send `start`, then `cancel` after 50ms. Assert `cancelled` arrives within 200ms and no `done`/`error` arrives.
- **Runner crash**: kill the runner subprocess while a workflow is running. Assert the host's `startWorkflow` iterator yields `error: "runner_died"` within 1s.
- **maxDurationMs**: a workflow that sleeps 30s with `maxDurationMs: 100` is killed by the runner with `error: "aborted"`.

### 6.3 Manual smoke tests

Same prompts as Plan A (§6.3), plus:

- `"Start the audit-xss workflow in the background, then go away and come back in 5 minutes to collect the result."` (verifies the runner outlives the turn.)
- `"Open a separate terminal and run \`tail -F ~/.pi/agent/sessions/subagentura/workflows/<id>/events.ndjson\` while a workflow is running."` (verifies the artifact dir is the source of truth.)

### 6.4 Backward compat checks

- All existing tests pass unchanged.
- `npm run typecheck` clean.
- `npm run pack:check` lists `bin/pi-workflow-runner.mjs` and the new `.ts` files.
- `npx pi-workflow-runner --help` works after install.
- Existing `subagent_with_context` / `subagent_isolated` tools still register, even with the runner subprocess unavailable (e.g., a sandboxed CI environment that blocks `child_process.spawn`). The host should fail open: if the runner can't spawn, `run_workflow` returns `isError: true, errorMessage: "runner_unavailable"`. The rest of the package keeps working.

## 7. Risk register

| Risk | Description | Likelihood | Impact | Mitigation |
|------|-------------|------------|--------|------------|
| **R1. Runner dies mid-workflow** | The runner subprocess crashes (uncaught exception, OOM, segfault). All in-flight workflows are lost. | Medium | High. | (a) Health-check ping every 30s. (b) On `exit`, the host marks all in-flight as `error: "runner_died"`. (c) Recovery: re-spawn on next `run_workflow` call. (d) Long-term: the artifact dir already has the script's pre-crash progress, so a user could manually re-run. (e) Optional `restart_workflow` tool in v2. |
| **R2. stdio backpressure** | A workflow that emits 10 MB of log output via `ctx.log` will fill the parent's stdout pipe buffer. The runner blocks, parent blocks, deadlock. | Medium | High. | (a) The runner buffers log output and writes to the artifact dir asynchronously. (b) The parent samples log progress every 1s, not on every line. (c) Document: workflows are for orchestrating sub-agents, not for streaming data. |
| **R3. Protocol drift between parent and runner versions** | A user updates `pi-subagentura` while a runner from a previous version is still running. The new parent's `start` message is missing a field the new runner requires, or vice versa. | Medium | Medium. | (a) The protocol's first line of every message is `{ type, protocolVersion }`. Parent and runner negotiate: if versions don't match, the older side exits. (b) Document a compatibility matrix. |
| **R4. Runner never exits, leaks processes** | A workflow with an infinite `while` loop and no `maxDurationMs` keeps the runner alive forever. | Low | Medium. | (a) `maxDurationMs` default 10 min, enforced in the runner. (b) `shutdown` message forces a runner exit (with 1s drain). (c) On `session_shutdown`, the host sends `shutdown` automatically. (d) Document. |
| **R5. NDJSON parser gets a malformed line** | A bug in the runner writes a 10 MB single line to stdout, breaking the parent's readline. | Low | Medium. | (a) The runner caps any single `progress` payload at 64 KB; larger payloads go to the artifact dir. (b) The parent uses a max-line-length guard in its parser (mirroring the `ndjson` library's behavior in `subagent.ts:625-643`). |
| **R6. Stale artifact dirs fill the disk** | Workflows that never get pruned leave artifacts forever. | High | Medium. | (a) Reuse `prune_subagent_jobs` (extended to also clean workflow artifacts with TTL ≤ `maxAge`). (b) Default `maxAge` for workflows is 7 days. (c) Document. |
| **R7. Concurrent workflows writing to the same log file** | Two workflows with the same `workflowId` (LLM bug) write to the same dir. | Low | High — corrupted NDJSON. | (a) `workflowId` is a server-allocated 16 hex chars (same as `generateJobId()` in `helpers.ts:213-216`). The LLM never picks it. (b) The runner rejects duplicate `start` messages with the same `workflowId`. |
| **R8. The runner can be `kill -9`'d by the OS** | OOM killer or admin SIGKILL. Workflow is lost. | Low | Same as R1. | (a) The artifact dir is best-effort written before each `await` point, so recovery can resume from the last completed phase. (b) v2: re-spawn + replay. |
| **R9. `child_process.spawn` blocked in some environments** | Some sandboxed CI envs disallow subprocess spawning. The package's existing tools (sub-agents) still work in-process; the runner does not. | Medium | Low. | (a) Graceful degradation: `run_workflow` returns `isError: "runner_unavailable"`. (b) Document the requirement. (c) v2: optional Plan A fallback if the runner can't spawn. |
| **R10. Cross-platform regression in a future change** | A future contributor adds a Unix-only primitive (e.g. `chmodSync`, `process.kill(0)`, a `~/.foo` path) and breaks Windows. | Medium | High. | (a) The §11 cross-platform compatibility matrix is a contract; CI matrix on `ubuntu-latest` / `macos-latest` / `windows-latest` runs on every PR and any Windows failure blocks merge. (b) A lint rule (`unicorn/prefer-path-platform`, `no-restricted-syntax` for `chmod`/`chown`/`~`) is enforced in CI. (c) The README has a "Cross-platform" section pointing at §11. |
| **R11. `node:vm` sandbox escape** | Same as Plan A's R2. A malicious workflow can `import("node:child_process").then(cp => cp.exec("rm -rf ~"))`. | Medium | Catastrophic for the user. | (a) Same as Plan A: the trust model is "user-authored scripts only." (b) v2: optional `--trust=untrusted` mode with restricted builtins. |
| **R12. The runner imports helpers.ts but helpers.ts imports pi runtime code** | `helpers.ts` imports from `@earendil-works/pi-coding-agent`. The runner, running as a standalone Node script, may not have a Pi runtime. | High | High — runner won't start. | (a) The runner imports `helpers.ts` only for the types and `startSubagentJob`. In the runner, `startSubagentJob` is mocked to use a stub `createAgentSession` that does nothing, and `ctx.spawn` is the only path that uses it. (b) Alternative: extract `startSubagentJob` into a sub-module that doesn't import pi runtime types — but that is invasive. (c) **Recommended:** the runner uses `createAgentSession` from `@earendil-works/pi-coding-agent` directly (same as the parent). The runtime is the same library, not a Pi-specific code path. Test that `bin/pi-workflow-runner.mjs` can `import { startSubagentJob } from "../helpers.js"` without errors. |

## 8. Effort estimate

### New files

| File | LOC |
|------|-----|
| `bin/pi-workflow-runner.mjs` | ~700 |
| `workflow-runner-protocol.ts` | ~200 |
| `workflow-runner-host.ts` | ~400 |
| `workflow.ts` | ~250 |
| `workflow-allowlist.ts` | ~80 |
| `workflow-runner-protocol.test.ts` | ~150 |
| `workflow-runner-host.test.ts` | ~300 |
| `workflow.test.ts` | ~250 |
| `workflow-runner-integration.test.ts` | ~300 |
| `demos/audit-xss.mjs` | ~50 |
| `docs/workflow-protocol.md` | ~150 |
| **Total new** | **~2,830** |

### Modified files

| File | Δ LOC | Description |
|------|-------|-------------|
| `subagent.ts` | +180 | New tool registration + host wiring |
| `package.json` | +6 | `bin` and `files` |
| `README.md` | +80 | Workflows section |
| **Total Δ** | **+266** | |

### Estimated dev time

- **T = 8 working days** for one focused dev, broken down as:
  - Day 1-2: `bin/pi-workflow-runner.mjs` — stdio transport, WorkflowRegistry, WorkflowExecutor, lifecycle CLI. **All paths use `path.join` / `os.homedir()` / `os.tmpdir()`; no `chmod`, no `/tmp`, no `~/.foo`.** (See §11.)
  - Day 2-3: `workflow-runner-protocol.ts`, `workflow-runner-host.ts` — message routing, TUI widget, rehydration. **Signal handling listens on `["SIGINT", "SIGTERM", "SIGBREAK"]`; liveness via `child.exitCode === null`, never `process.kill(0)`.** (See §11.)
  - Day 4: `workflow.ts` (combinators), `workflow-allowlist.ts`, integration of `run_workflow` tool into `subagent.ts`. **The host's `spawn` call uses `windowsHide: true` and never `shell: true`.** (See §11.)
  - Day 5: unit tests + integration tests + edge cases (cancel, runner-dies, maxDuration). **Long-path test, UTF-8 test, EBUSY retry test, Windows-specific `SIGBREAK` test.**
  - Day 6: README, `docs/workflow-protocol.md` (with a "Cross-platform" subsection), demo script, `npm run typecheck` + `npm test` + `npm run pack:check`. **Lint rules wired: `unicorn/prefer-path-platform`, `no-restricted-syntax` for `chmod`/`chown`/`~`.**
  - Day 7: bug-bash, race conditions, and a full CI matrix run on `ubuntu-latest` / `macos-latest` / `windows-latest`. Any Windows failure blocks the release.
  - Day 8: write the §11 cross-platform docs (already done in this spec) and review the lint config + CI matrix with a second set of eyes.

### Order-of-magnitude token cost

Same as Plan A: the LLM only sees the workflow's return value. The runtime cost is the sum of the spawned sub-agents' costs. **Zero new token overhead per sub-agent call.** The protocol's NDJSON traffic is ~1 KB per lifecycle event, invisible to the LLM.

## 9. Migration & compatibility

### Does this break existing users?

- **No** for users who don't call `run_workflow`. The package's existing behavior is unchanged.
- **No** for users who upgrade and call `run_workflow` for the first time. The tool is purely additive.
- **Mild yes** for users with custom tooling around the published tarball: the `files` array now includes `bin/pi-workflow-runner.mjs`, which is a 700-LOC ESM script. Tarball size grows by ~25 KB. Not a breaking change.
- **Mild yes** for users on systems where `child_process.spawn` is blocked: they get `error: "runner_unavailable"` from `run_workflow`. Existing tools work fine.

### Deprecation path

None needed — nothing is removed.

### Version bump

**Minor bump: `2.1.0` → `2.2.0`.** A new `bin` entry is a new feature; the previous `2.1.0` release shipped only the PR-#10 changes (literal-path prompt, inject mode, output reporting), not workflows. The package version is now 2.1.0 at the time of writing; the workflow lands in 2.2.0.

## 10. Open questions

### Q1. Should the runner be one-per-Pi-session or one-per-workflow?

- **Option A (one-per-session).** Single long-lived runner. Workflows share its event loop. Cheaper (no spawn cost), but one bad workflow can starve the others.
- **Option B (one-per-workflow).** Each `run_workflow` call spawns a fresh runner. Isolated, but a 200ms startup cost per workflow, and a parent that wants 10 concurrent workflows has 10 runner processes.
- **Recommendation:** A. One runner per session, with a hard concurrency limit on in-flight workflows (e.g., 4) to prevent starvation.

### Q2. Should the protocol be NDJSON over stdio or a Unix-domain socket?

- **Option A (stdio).** Simple, portable, no temp paths, works identically on POSIX and Windows. Limited to ~64 KB pipe buffer on macOS, mitigated by backpressure handling. Already the v1 transport.
- **Option B (named pipe on Windows / Unix-domain socket on POSIX).** More setup, can survive parent death (with platform-appropriate detach flags), allows out-of-process observers. The CLI accepts `--socket <path>` already; the named-pipe name is `\\.\pipe\pi-workflow-runner-<sessionId>` on Windows.
- **Recommendation:** stdio for v1 across all platforms; named-pipe / Unix-socket in v2. The §11 cross-platform matrix covers the v1 stdio guarantees.

### Q3. Should the runner persist across Pi restarts?

- **Option A (no).** Runner dies with the parent. Workflows that were running at parent death are marked `error: "parent_died"` and the user is told to restart.
- **Option B (yes, platform-appropriate detach).** The runner detaches from the parent. **POSIX:** `subprocess.spawn({ detached: true })` + liveness check via the runner's `ping`/`pong` (NOT `process.kill(0)`, see §11). **Windows:** `subprocess.spawn({ detached: true, windowsHide: true, // NODE_OPTIONS-compatible creation flags not exposed by Node for v22; emulate by spawning via `cmd.exe /c start /B <binPath>` is rejected — instead use `child_process.spawn` with `detached: true` and accept that on Windows, the runner does NOT become a true daemon, it only inherits the parent's console group. This is a known Windows limitation; v2 may use a Windows Service wrapper.** On next parent startup, the host rehydrates from the artifact dir. Survives parent crashes on POSIX; partial survival on Windows.
- **Recommendation:** A for v1 on all platforms, B for v2 (POSIX fully, Windows best-effort). v1's recovery is "the user re-runs the workflow" (the script is the same file, the args are in the parent's LLM context).

### Q4. Should `ctx.spawn` allow `async: true` (returning a `jobId` to be awaited later)?

- **Option A (no, v1).** All spawns are awaited. Simpler abort semantics.
- **Option B (yes).** Scripts can fire-and-forget sub-agents.
- **Recommendation:** A for v1. Fire-and-forget inside a workflow is an anti-pattern: the script is the orchestrator, it should know what it's waiting for.

### Q5. Should we add `runner_version` to the protocol handshake?

- **Option A (yes).** First message from parent includes `protocolVersion: 1`. Runner replies with its `runnerVersion` and `protocolVersion`. If mismatch, the older side exits with a clear error.
- **Option B (no).** Trust the package version. Drift is impossible because the runner and the parent are installed together.
- **Recommendation:** A. Cheap insurance against partial updates (`pi install npm:pi-subagentura@2.1.0` racing with a 2.0.2 runner still in memory).
## 11. Cross-platform compatibility matrix

This section is the contract for "OS-agnostic." Every row is a thing that the v1 plan assumed on Unix but must work on Windows too. Each row also names the cross-platform primitive and the test that proves it.

| Concern | Unix-only pitfall | Cross-platform fix | Verified by |
|---|---|---|---|
| Temp directory | `/tmp/foo` | `path.join(os.tmpdir(), "foo")` | `workflow-runner-integration.test.ts` runs in an env where `TMPDIR=/c/Users/runner/AppData/Local/Temp` (Windows) and asserts the artifact dir lives under it. |
| Home directory | `~/.pi/...` | `path.join(os.homedir(), ".pi", "...")` | Existing `subagent.ts` already uses this; the runner does the same. |
| Path separators | `"/".join([...])` | `path.join(...)` everywhere | `path.join` is used in all new files; ESLint rule `unicorn/prefer-path-platform` enforced in CI. |
| Path-root resolution | `path.resolve("~/.pi")` works on Unix only | Use `path.resolve(os.homedir(), ".pi")` | Same as above. |
| File mode/perm | `chmodSync(path, 0o700)` | Skip on Windows. Use `fsPromises.chmod` only on POSIX; on Windows the FS doesn't support Unix bits, and a default ACL is fine. | A test that runs on POSIX and is `it.skipIf(process.platform === "win32")` on Windows. |
| Process spawning | `spawn(cmd, { shell: true })` | `spawn("node", [binPath, "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })` — never `shell: true`; pass the `.mjs` path directly so Windows can find it via the npm `bin` shim or the path. | `workflow-runner-integration.test.ts` runs on Windows in CI. |
| Process detachment (Q3) | `subprocess.spawn({ detached: true })` for v2 | **Skip v2 detach on Windows in v1.** On Windows, `detached: true` does not create a new process group the way it does on Unix. v1's recovery path is "re-run the workflow" (no detach). v2's detach uses `windowsHide: true` + `creationFlags: DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` (via `child_process.spawn` options) on Windows and `detached: true` + `process.kill(0)` for liveness on Unix. The implementation branches on `process.platform === "win32"`. | v1 does not test detach (no v1 detach). v2's test runs in both modes. |
| Liveness probe | `process.kill(0)` for "is the PID alive?" | Use the subprocess's own `exit` event + a `ping`/`pong` over the protocol. The parent's health check is `child.exitCode === null && child.signalCode === null && child.pid !== undefined`. The `pid` is recorded at spawn but never used to probe. | Health-check test in `workflow-runner-host.test.ts`. |
| Graceful shutdown signal | `process.on("SIGTERM")` | Listen for `SIGINT`, `SIGTERM`, and `SIGBREAK`. On Windows, `SIGBREAK` is the only console-respecting signal; on Unix, `SIGTERM` is. Implementation: `["SIGINT", "SIGTERM", "SIGBREAK"].forEach(s => process.on(s, gracefulShutdown))`. (Node's `process.on` accepts all three on both platforms as of Node 18.) | Unit test that emits each signal on a child runner and asserts `shutdown` runs. |
| Forceful kill | `subprocess.kill("SIGKILL")` | `subprocess.kill()` (no arg). On Windows this calls `TerminateProcess`; on Unix this sends `SIGKILL`. Both are immediate, non-ignorable. Do not pass `"SIGTERM"` to `subprocess.kill()` on Windows — it throws. | Unit test. |
| Working directory for spawn | Inherits parent's cwd | `spawn(binPath, args, { cwd: process.cwd() })` — always set `cwd` explicitly so Windows doesn't inherit a wrong default from a different drive. | Code review + integration test asserts the runner sees the right cwd. |
| Long path support | `~/.pi/agent/sessions/subagentura/workflows/<id>/...` | On Windows, paths longer than 260 chars fail by default. Use the `\\?\` UNC prefix when calling `fs` APIs on Windows for paths we don't control length of. Helper: `longPath(p) = process.platform === "win32" && !p.startsWith("\\\\?\\") ? "\\\\?\\" + p : p`. | Test that creates a workflow whose artifact path exceeds 260 chars and asserts the runner still reads/writes it. |
| File locking | POSIX advisory locks are port-able | On Windows, the artifact file may be briefly locked by another reader. Use `fs.promises.open` with `flag: "r+"` and retry on `EBUSY` up to 3 times. The `writeOutput` helper in `artifact.ts` already uses atomic rename, so this only matters for in-progress reads. | Integration test. |
| npm bin shim | None | npm generates `bin/pi-workflow-runner.cmd` and `bin/pi-workflow-runner.ps1` (Windows) and `bin/pi-workflow-runner` (POSIX) from the `bin` field in `package.json`. Our `package.json` `bin: { "pi-workflow-runner": "bin/pi-workflow-runner.mjs" }` works as-is. The runner invocation in the parent uses `commandExistsSync("pi-workflow-runner")` from the npm-prefixed PATH, falling back to the absolute path. | Test that the parent can locate the runner after `npm install` on Windows. |
| Line endings | LF | NDJSON over stdio: the parent and runner must emit `\n`-terminated lines. The parent's `process.stdout.write` and the runner's `process.stdout.write` are LF by default; on Windows, the stdio handle is opened in binary mode (no `\r\n` translation) for pipes, so LF is correct. No extra handling needed, but a test asserts. | Unit test. |
| Shell expansion in script paths | Bash, zsh, fish expand `~/` and `$VAR` | The runner invokes `node bin/pi-workflow-runner.mjs` directly. No shell. The script path the LLM passes is already an absolute path (the tool's `script` param requires this). The runner does not re-resolve the path. | Code review. |
| UTF-8 paths | Always works on Unix | Windows allows non-UTF-8 paths in legacy mode. `fs` APIs in Node use `Buffer` internally, so this is mostly a display issue. We do not need to do anything for v1, but the artifact JSON contents (events.ndjson, output.md) are always UTF-8 by Node convention. | Test that a workflow with a UTF-8 path in its name runs successfully. |
| Dev tools (CI) | `bash` everywhere | The runner's tests run on `windows-latest` GitHub Actions runner. The integration test uses `child_process.spawn` (not `exec` or `shell: true`), so no shell is needed. | CI matrix. |
| Crash diagnostics | Unix core dumps | On Windows, use `WER` (Windows Error Reporting) — not configurable. Document that workflows that crash the runner are reported as `error: "runner_died"` with whatever stderr the runner produced; the artifact dir's `stderr.log` captures the last 64 KB. | Test. |
| Native module compatibility | Most are POSIX-only | Plan B does not introduce new native modules. The runner uses only `node:child_process`, `node:fs/promises`, `node:os`, `node:path`, `node:readline`, `node:vm`, and the existing `ndjson` and `is-path-inside` deps. All are pure-JS / built-in. | Dependency review. |

### Test matrix

The CI matrix for v1 must run on `ubuntu-latest`, `macos-latest`, and `windows-latest`. Each runs:

1. `npm install`
2. `npm run typecheck`
3. `npm test` (existing 196 tests, plus the new ~25 workflow tests)
4. `npm run pack:check` (verify the bin is bundled)
5. A smoke step: spawn the real `bin/pi-workflow-runner.mjs`, run `demos/audit-xss.mjs` against a 5-file fixture, assert the final return value.

A failure on any platform blocks the release. No "best effort on Windows" carve-out.

### Rejected alternatives (for the record)

- **Use `node-cross-spawn-polyfill` or `cross-spawn`.** Adds a runtime dep. The `node:child_process` API as of Node 20 already handles the Windows cases we care about (stdout/stdin pipes, `windowsHide`, no-shell invocation). No dep needed.
- **Use a shell.less IPC primitive like `MessageChannel` over a named pipe (Windows) / Unix-domain socket (POSIX).** Cleaner long-term, but v1's stdio already works and a v2 socket transport is still on the table (see §10 Q2). Defer.
- **Skip Windows in v1, ship it in v2.** Rejected because the user explicitly required cross-platform from day one and the marginal cost (~1 dev-day of cross-platform testing + the matrix in this section) is small relative to the 7-day estimate.

## 12. Why this over the other two

Plan B is the most resilient: workflows keep running while the user types a new prompt, and the runner's artifact dir means a parent crash can be recovered from. It's also the most invasive: a new bin, a new protocol, a new lifecycle daemon. **Pick Plan B if you already have use cases for "long-running workflow that should outlive the spawning turn" or "workflows that should survive a parent Pi restart."** If you don't have those use cases yet, ship Plan A first, learn what users do, then build B on top. **With the cross-platform compatibility matrix in §11, Plan B is the right choice when you also need the runner to work on Windows** — the matrix removes the previous "Unix-only v1" limitation.

