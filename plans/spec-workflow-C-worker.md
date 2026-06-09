# Plan C: In-process `worker_threads` Runner

**Status:** Draft
**Date:** 2026-06-08
**Target release:** pi-subagentura 2.1.0
**Author:** planning agent

## 1. One-paragraph summary

Add a new tool `run_workflow({ script, args })` that uses `node:worker_threads` to execute the script in a **separate thread** with `MessageChannel` / `postMessage` boundaries. The worker thread imports `pi-subagentura`'s SDK directly (so there's no IPC layer to write), runs the script in a `vm`-sandboxed context, and posts sub-agent task requests to the main thread. The main thread acts as a thin proxy that translates between the worker's messages and the existing `subagent_*` infrastructure (in particular, `startSubagentJob` from `helpers.ts`). The worker's heap is isolated from the parent, so a script that allocates 500 MB of intermediates does not bloat the parent Pi process. **Headline tradeoff:** true heap isolation with zero new bins, no stdio protocol, and the same `startSubagentJob` reuse — but the parent must stay alive for the worker to function, and `postMessage` has serialization overhead on every sub-agent result.

## 2. Goals & non-goals

### Goals

- **G1.** Ship one new tool `run_workflow({ script, args })` whose handler spawns a `Worker` (from `node:worker_threads`), evaluates the user's script inside it, and returns the final value.
- **G2.** The worker thread imports `startSubagentJob` (from `helpers.ts`) and `jobRegistry` semantics **transparently** — the worker is a separate thread, not a separate process, so it can import TypeScript directly via the parent's module loader.
- **G3.** The main thread owns the `jobRegistry`. The worker posts `{ kind: "spawn", task, persona, model, ... }` messages to the main thread; the main thread calls `startSubagentJob` and posts the `SubagentResult` back. This keeps the registry's lifecycle (notifications, polling) consistent with the rest of the package.
- **G4.** The worker's `vm` sandbox is the same as Plan A's. Script authors get the same `parallel` / `series` / `define` / `ctx.spawn` API.
- **G5.** `parallel(tasks, { concurrency: N })` works inside the worker. The default `concurrency` is 8.
- **G6.** Aborts: the main thread can send `{ kind: "abort" }` to the worker, which fires the worker's `AbortSignal`. The worker checks `signal.aborted` between combinator iterations.
- **G7.** Add one demo `demos/audit-xss.mjs`, one docs page `docs/workflow.md`, and a `Workflows` section in the README.

### Non-goals

- **N1.** We are NOT introducing a new npm bin. The runner is a `Worker`, spawned in-process.
- **N2.** We are NOT persisting workflow state to disk in v1. The worker dies with the parent. (Plan B's recovery path is the v2 answer to this.)
- **N3.** We are NOT implementing checkpointing/resume. The script runs to completion or aborts.
- **N4.** We are NOT sandboxing the script beyond the `vm` context. (Same trust model as Plan A.)
- **N5.** We are NOT using `SharedArrayBuffer` for the workflow's intermediate state. Serialization overhead is the cost of isolation; the LLM never sees intermediates anyway.
- **N6.** We are NOT supporting nested workflows in v1. A script can call `ctx.spawn` to delegate to a sub-agent, but a script cannot call `run_workflow` recursively.

## 3. Public API

### 3.1 The new tool: `run_workflow`

Same schema as Plan A (§3.1 of `spec-workflow-A-vm.md`):

```ts
const RunWorkflowParams = Type.Object({
  script: Type.String({
    description: "Absolute path to a .mjs or .js workflow script. Must live under ~/.pi/workflows/ or cwd.",
  }),
  args: Type.Optional(Type.Record(Type.String(), Type.Any())),
  cwd: Type.Optional(Type.String()),
  concurrency: Type.Optional(Type.Number({ description: "Default 8." })),
  maxDurationMs: Type.Optional(Type.Number({ description: "Default 600000 (10 min)." })),
  async: Type.Optional(Type.Boolean()),
  notifyOnComplete: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("inject")])),
});
```

**Behavioral note:** "async" here is the same as Plan A's async — the workflow itself is sync from the LLM's perspective; `async: true` returns a `workflowId` and lets the LLM continue. The workflow still runs in the worker thread; "async" just means the tool handler doesn't block waiting for the worker's result.

### 3.2 Companion tools

Identical to Plans A and B:

- `get_workflow_status({ workflowId })` — reads from the parent's `jobRegistry` (the workflow is registered there with `kind: "workflow"`, just like Plan A).
- `get_workflow_result({ workflowId })` — same.
- `cancel_workflow({ workflowId })` — calls `session.abort()` on the parent-side placeholder, and posts `{ kind: "abort" }` to the worker.
- `prune_subagent_jobs` — already cleans up everything.

### 3.3 Decision rubric: `run_workflow` vs `subagent_*`

Same as Plan A (§3.5 of `spec-workflow-A-vm.md`).

### 3.4 Decision rubric: Plan A vs Plan C

| | Use Plan A (in-process vm) | Use Plan C (worker_threads) |
|---|---|---|
| Workflow intermediates fit in parent heap (e.g., < 100 MB) | Yes | Yes |
| Workflow intermediates are large (e.g., 1 GB+ audit reports in memory) | No — blows up parent heap | Yes — worker has its own heap |
| User wants zero startup cost | Yes | Slight (Worker spawn ~30-100ms) |
| User wants parent crash to take the workflow down | Yes (same process) | Yes (parent crashes → worker dies) |
| User wants workflow to outlive the turn | No | No (use Plan B) |
| User wants preemption on abort | No (cooperative only) | **Yes** — `worker.terminate()` is preemptive |

## 4. Architecture & data flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ Parent Pi process                                                     │
│                                                                       │
│  ┌─────────────────────┐      registerTool("run_workflow", ...)      │
│  │  subagent.ts        │ ◀──────────────────────────────────────┐    │
│  │  default export     │                                        │    │
│  └─────────┬───────────┘                                        │    │
│            │ execute()                                          │    │
│            ▼                                                    │    │
│  ┌─────────────────────┐    ┌───────────────────────────────┐  │    │
│  │  run_workflow       │    │  Worker (node:worker_threads)  │  │    │
│  │  tool handler       │───▶│                               │  │    │
│  └─────────┬───────────┘    │  ┌────────────────────────┐   │  │    │
│            │                 │  │ node:vm.Script          │   │  │    │
│            │                 │  │ + sandbox               │   │  │    │
│            │                 │  └─────────┬──────────────┘   │  │    │
│            │                 │            │                  │  │    │
│            │                 │            ▼                  │  │    │
│            │                 │   workflow script             │  │    │
│            │                 │   default export              │  │    │
│            │                 │   async(args, ctx)            │  │    │
│            │                 │            │                  │  │    │
│            │                 │            ▼                  │  │    │
│            │                 │   ctx.spawn ─────────┐        │  │    │
│            │                 │                     │        │  │    │
│            │                 └─────────────────────┼────────┘  │    │
│            │                                       │           │    │
│            │  postMessage({ kind: "spawn", ... })  │           │    │
│            │ ◀─────────────────────────────────────┘           │    │
│            │                                                   │    │
│            │  startSubagentJob(...)  ◀── same call as the      │    │
│            │                            existing tools do     │    │
│            ▼                                                   │    │
│   onUpdate callback flows to UI                               │    │
│            │                                                   │    │
│            │  postMessage({ kind: "spawn_result", result })    │    │
│            ▼ ──────────────────────────────────────▶          │    │
│                                                               │    │
│   workflow returns { count: 3, sample: [...] }                │    │
│            │  postMessage({ kind: "result", value })          │    │
│            ▼ ◀─────────────────────────────────────           │    │
│                                                               │    │
│   AgentToolResult { content: [{ text: JSON(retval) }] }       │    │
│                                                               │    │
└───────────────────────────────────────────────────────────────┘    │
   ──────── process boundary (none — same process) ────────         │
   ──────── thread boundary (Worker has its own V8 isolate,        │
                                  MessageChannel for comms) ──────┘
   ──────── context boundary (workflow↔sub-agent is a message hop)
```

**Key invariants**

- The Worker is a real isolation boundary: it has its own V8 isolate, heap, and event loop. `worker.terminate()` is preemptive — the worker can't keep running.
- Communication is via `postMessage`, which uses the structured-clone algorithm. Functions, classes, and most non-POJO objects don't survive the round trip; only JSON-serializable values do. The protocol explicitly uses plain objects.
- The Worker imports TypeScript directly (via the parent process's module loader — `worker_threads` workers share the V8 module graph by default). This means the worker can `import { startSubagentJob } from "./helpers.ts"` (transpiled by the parent), no IPC layer needed for the *import* side. The *call* side goes through `postMessage`.
- The parent's `jobRegistry` is the single source of truth for "what workflows are running." The worker has its own internal `Map<workflowId, ...>` for in-flight spawns, but it's a private cache.

## 5. File-by-file implementation outline

### 5.1 New files

#### `workflow-worker.ts` (NEW — ~400 LOC)

The Worker thread entry. This is what gets loaded by `new Worker("./workflow-worker.ts", { eval: false })` (or, more likely, by spawning a child Node process and pointing it at a built file — see §5.1.1).

**Purpose:** Load the workflow script, run it, route `ctx.spawn` calls to the parent via `postMessage`.

**Key exports:** None directly; the file is run as the entry of a Worker.

**Internal structure:**

1. **Imports** (~30 LOC) — `parentPort`, `vm`, the same `startSubagentJob` from `helpers.ts` (used only for type imports — runtime calls are proxied).
2. **Wire protocol types** (~80 LOC) — `type WorkerInbound = { kind: "spawn", requestId, task, persona?, model?, cwd?, includeContext? } | { kind: "abort" } | { kind: "shutdown" }`. `type WorkerOutbound = { kind: "ready" } | { kind: "spawn_result", requestId, result } | { kind: "spawn_error", requestId, message } | { kind: "result", value } | { kind: "error", message, stack? } | { kind: "log", line }`.
3. **`buildSandbox(ctx)`** (~40 LOC) — same as Plan A's `workflow.ts:buildSandbox`. The Worker is the actual `vm` host; the script's globals are bound to the worker's context.
4. **`runScript(script, args, ctx)`** (~150 LOC) — the core executor:
   - Read script text from disk (the parent has already validated the path).
   - Build the `vm.Context` with the sandbox.
   - Run `vm.Script` and get the `default` export.
   - Await `default(args, ctx)`.
   - On success, `parentPort.postMessage({ kind: "result", value: JSON.stringify(retval) })`.
   - On error, `parentPort.postMessage({ kind: "error", message, stack })`.
5. **`ctx.spawn` (the proxy)** (~60 LOC) — calls `parentPort.postMessage({ kind: "spawn", ... })` and `await`s a `spawn_result` / `spawn_error` reply keyed by `requestId`. Implements a request/response correlation map.
6. **`parentPort.on("message", ...)`** (~40 LOC) — handles `abort` (forwards to ctx.signal) and `shutdown` (graceful).

**~LOC estimate:** 400.

##### 5.1.1 Sub-question: how is `workflow-worker.ts` loaded?

`worker_threads.Worker` accepts a path to a JS file. The repo's `tsconfig.json` is `noEmit`, so we can't run `.ts` directly. Two options:

- **Option X (compile-on-the-fly).** Use `tsx` or `esbuild-register` in the Worker constructor. Adds a dep.
- **Option Y (compile at package build).** Add a `build` script that uses `esbuild` to produce `dist/workflow-worker.js`. Adds a build step to the package.
- **Option Z (pre-bundle inline).** The handler `new Worker(script, { eval: true })` where `script` is a `string` containing the JS source. The handler reads `workflow-worker.ts`, transpiles it (via `esbuild` at runtime), and passes the JS string. Adds runtime cost.
- **Recommendation:** X. Use `tsx` (already a common Node dev dep, but it's not in the repo). Alternative: ship a hand-written `workflow-worker.mjs` that does the Worker logic, with the same shape as `bin/pi-workflow-runner.mjs` from Plan B. This sidesteps the TS-in-Worker problem entirely. **Recommended for v1: ship `workflow-worker.mjs` (~350 LOC) hand-written ESM, same shape as the parent `workflow.ts`.** v2 can adopt `tsx` or a build step.

For the rest of this plan, assume `workflow-worker.mjs` is the entry.

#### `workflow.ts` (NEW — ~250 LOC)

**Purpose:** The main-thread side of the workflow runtime. Defines the protocol, owns the `Worker`, and translates messages to/from the existing `startSubagentJob` infrastructure.

**Key exports:**

```ts
export async function executeWorkflow(params: {
  scriptPath: string;
  args: Record<string, unknown>;
  cwd: string;
  concurrency: number;
  signal: AbortSignal;
  workflowId: string;
  defaultModel: Model | undefined;
  parentModelRegistry: ModelRegistry | undefined;
  onUpdate: ((partial: AgentToolResult) => void) | undefined;
}): Promise<WorkflowResult>;

export interface WorkflowResult {
  value: unknown;
  durationMs: number;
  spawnCount: number;
  spawnUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
  isError: boolean;
  errorMessage?: string;
}
```

**Internal structure:**

1. **Imports** (~30 LOC) — `Worker` from `node:worker_threads`, `path`, the artifact helpers, `startSubagentJob` from `helpers.ts`.
2. **`WorkerPool`** (~120 LOC) — a small singleton that lazily creates a Worker per workflow. (One Worker per workflow, not a shared pool — the worker's heap is workflow-specific, so isolation matters more than pool overhead.) The pool tracks live Workers by `workflowId` for cancel.
3. **`WorkflowBridge`** (~150 LOC) — the protocol handler:
   - On `ready` from worker, send `{ kind: "start", script, args, cwd, concurrency, maxDurationMs }`.
   - On `spawn` from worker, call `startSubagentJob` (with the same params as Plan A's `ctx.spawn`) and reply `{ kind: "spawn_result", requestId, result }`.
   - On `result` from worker, resolve the workflow's promise with the value.
   - On `error` from worker, resolve with `isError: true`.
4. **`executeWorkflow` (top-level)** (~80 LOC) — orchestrates the bridge. Spawns a `Worker`, sets up the `Bridge`, awaits the result.
5. **`ctx.log` (in the worker, but defined in the shared protocol)** — sends `{ kind: "log", line }` to the parent, which appends to the TUI widget (no LLM traffic).

**~LOC estimate:** 380 (lumped with `workflow.ts`).

#### `workflow-allowlist.ts` (NEW — ~80 LOC)

Same as Plan A. Reused for path validation in the parent before the Worker is spawned.

#### `workflow-worker.mjs` (NEW — ~350 LOC)

The Worker entry. Hand-written ESM. Same shape as `workflow-worker.ts` from §5.1 but without the TS type annotations. (Or, if we adopt `tsx`, this can be `.ts`.)

#### `workflow.test.ts` (NEW — ~350 LOC)

Unit tests for `executeWorkflow` (mocked Worker), plus combinator tests for `parallel` / `series`.

#### `workflow-integration.test.ts` (NEW — ~250 LOC)

End-to-end tests with a real Worker. Spawns an actual `Worker` and verifies message routing.

#### `demos/audit-xss.mjs` (NEW — ~50 LOC)

The example workflow from the spec — files in, parallel audits, parallel refutes, return sample.

### 5.2 Modified files

#### `subagent.ts` (MODIFIED — +120 LOC delta)

1. Import `executeWorkflow` from `./workflow`.
2. Register `run_workflow`, `get_workflow_status`, `get_workflow_result`, `cancel_workflow` (~100 LOC). The tool handler is similar to Plan A's, but it creates a `Worker` instead of a `vm.Context`.
3. In `session_shutdown`, terminate any live workers (`for (const w of liveWorkers.values()) w.terminate();`).
4. Re-export new types.

#### `helpers.ts` (MODIFIED — +10 LOC delta)

Same as Plan A: add `kind: "subagent" | "workflow"` discriminator to `JobState`.

#### `package.json` (MODIFIED — +1 LOC delta)

Add `workflow.ts`, `workflow-allowlist.ts`, `workflow-worker.mjs` to `files`.

#### `README.md` (MODIFIED — +60 LOC)

New "Workflows" section. Document the worker_threads model and the "vs subagents" decision rubric.

### 5.3 Files NOT modified

- `interactive-tmux.ts` — workflow scripts cannot call `subagent_interactive` (Plan A constraint). If users need tmux-backed sub-agents inside a workflow, that requires extending `SpawnRequest` in v2.
- `artifact.ts` — workflows do not write to artifact dirs in v1. (A v2 may add persistence.)
- `subagent-artifact-cli.ts` — out of scope.

## 6. Test plan

### 6.1 Unit tests (`workflow.test.ts`)

- **`executeWorkflow` (with mocked Worker)**
  - happy path: Worker posts `{ kind: "result", value }` → returns `WorkflowResult` with that value.
  - Worker crashes: `worker.on("error", err)` → returns `isError: true, errorMessage: err.message`.
  - Worker is terminated: same as crash.
  - `maxDurationMs` exceeded: `worker.terminate()` is called, returns `isError: true, errorMessage: "aborted"`.
  - Spawn message round-trip: Worker posts `{ kind: "spawn" }`, handler calls `startSubagentJob` (mocked), posts back `{ kind: "spawn_result" }`, Worker resumes.
- **`parallel` (in-Worker, tested via a real Worker that runs a script using `parallel`)**
  - 10 tasks, default concurrency, all complete in input order.
  - 10 tasks, `concurrency: 2`, all complete in input order; peak in-flight is 2.
  - Abort signal honored between iterations.
- **`series`**
  - runs in order.
  - short-circuits on first rejection.
- **`define`**
  - type-level smoke test.

### 6.2 Integration tests (`workflow-integration.test.ts`)

Real Worker, real protocol:

- **End-to-end**: a workflow script that calls `ctx.spawn` (via the proxy) 2 times and returns a derived value. Mock `startSubagentJob` (via `vi.mock`) to return fixed results. Assert the worker gets the right `spawn` messages, the parent gets the right `result`.
- **Heap isolation**: a workflow that allocates 1 GB to a script variable. The parent's `process.memoryUsage().heapUsed` does not increase by 1 GB. (Skip in CI; manual smoke test only.)
- **Worker crash**: a workflow that calls `process.exit(0)` from inside the script. The parent receives a `worker.on("exit")` event and returns `isError: true, errorMessage: "worker_exited"`.
- **Cancel mid-spawn**: send `cancel` to the parent while the worker is awaiting a `spawn_result`. Assert the worker is terminated and the workflow returns `cancelled`.

### 6.3 Manual smoke tests

Same prompts as Plan A (§6.3 of `spec-workflow-A-vm.md`). Plus:

- `"Run a workflow that allocates 1 GB to a global var and returns. Watch htop — the parent Pi's RSS should NOT grow by 1 GB."` (verifies heap isolation.)
- `"Run a workflow with an infinite loop, then send cancel. The worker should die within 1s."` (verifies preemptive abort.)

### 6.4 Backward compat checks

- All existing tests pass unchanged.
- `npm run typecheck` clean.
- `npm run pack:check` lists the new files.
- Existing tools still register and work.

## 7. Risk register

| Risk | Description | Likelihood | Impact | Mitigation |
|------|-------------|------------|--------|------------|
| **R1. `worker_threads` is a real but unusual isolation boundary** | Authors may assume "thread = shared memory." In practice, the V8 isolates have **separate heaps**; `postMessage` serializes. A script that tries to share a JS object with the parent will be confused. | High | Medium. | (a) Document clearly: "the worker has its own heap; everything that crosses the boundary is serialized." (b) Provide `ctx.shared` for explicit cross-boundary state if needed in v2. |
| **R2. `postMessage` serialization overhead** | A workflow that returns a 100 MB object has to `JSON.stringify` it and `JSON.parse` on the parent side. The LLM then sees 100 MB of text. | Medium | High. | (a) Same 1 MB cap as Plan A for the return value. (b) For larger returns, write to a file and return `{ path }`. (c) Document. |
| **R3. Worker startup cost** | A new `Worker` is ~30-100ms. For workflows that are 50ms of work, that's a 2x slowdown. | Medium | Low. | (a) The `concurrency` knob lets authors batch. (b) The startup cost is amortized over the workflow's lifetime. (c) Document. |
| **R4. Worker can be `worker.terminate()`'d only** | There's no graceful "abort" message that's faster than `terminate()`. If a script is in the middle of a long `await` in user code, `terminate()` may not run the script's `finally` blocks. | Medium | Medium. | (a) For workflows that own resources, the script is responsible for using `try/finally` with `ctx.signal`. (b) The protocol supports `{ kind: "abort" }` for cooperative abort; `terminate()` is the fallback. (c) Document. |
| **R5. `worker_threads` not available in all environments** | Some embedded JS environments disable `worker_threads`. (E.g., some V8 isolates for sandboxing.) | Low | High. | (a) Probe at tool-call time: `try { require("node:worker_threads") } catch { return isError: "worker_threads_unavailable" }`. (b) Document the Node-only requirement. |
| **R6. `SharedArrayBuffer` requires cross-origin isolation headers** | If a v2 introduces shared memory, the parent process would need to launch with `--experimental-shared-memory` or set COOP/COEP headers. Not relevant in v1, but worth noting. | Low | Low. | (a) Don't use `SharedArrayBuffer` in v1. |
| **R7. Module load in the Worker is the parent's module graph** | If the parent has a buggy module that throws at import time, the Worker inherits the bug. | Low | Medium. | (a) The Worker is a fresh `Worker(workerData, { eval: false })` with its own module graph, not a thread-share. (Verify with a test.) (b) The `vm.Script` inside the Worker is also fresh. |
| **R8. The script imports `pi-subagentura/workflow`** | The script does `import { spawn, parallel, series, define } from "pi-subagentura/workflow"`. The `node:vm` sandbox doesn't have a Node module resolver. | High | High. | (a) The script does NOT use `node:vm` for module loading. Instead, the script is loaded as a regular ESM file (the parent reads it, the Worker evaluates it as a `vm.Script` with a `vm.SourceTextModule` if available, or falls back to plain `vm.Script` with a `require` shim). (b) The sandbox's `import` is shimmed by the protocol: when the script calls `spawn`, it actually goes through `parentPort.postMessage`. The `pi-subagentura/workflow` re-export is **not** used inside the Worker; the script's `spawn` symbol is bound by the sandbox. (c) **Test:** a workflow script that does `import { something } from "node:fs"` works. (d) **Test:** a workflow script that does `import { spawn } from "pi-subagentura/workflow"` — the Worker sees `pi-subagentura/workflow` as a non-existent module. Document: don't import — the sandbox provides `spawn` as a global. |
| **R9. `vm.Script` and ESM `import` don't mix** | `vm.Script` evaluates a string of code; it doesn't have a module system. A script that uses `import` (ESM) won't work. | High | High. | (a) Two options: (i) scripts are **plain CommonJS** — `module.exports = { default: async function(args, ctx) { ... } }` or `module.exports = async function(args, ctx) { ... }`. (ii) scripts are **plain ESM** but the Worker loads them via dynamic `import("./script-path.mjs")`, then calls `.default`. (b) **Recommendation:** option (ii) — ESM is the future, and Node's `import()` works inside Workers. The Worker uses dynamic `import()` to load the script, gets the namespace object, and calls `.default(args, ctx)`. No `vm` involved. |
| **R10. `parentPort` is `null` if the script is somehow run outside a Worker** | If a future maintainer accidentally calls the Worker entry from the main thread, `parentPort.postMessage` throws. | Low | High. | (a) Guard: `if (!parentPort) throw new Error("workflow-worker.mjs must be run as a Worker")`. |
| **R11. The Worker leaks if the parent crashes** | If the parent process segfaults, the Worker is unceremoniously killed. | Low | Medium. | (a) The same as the existing sub-agent path: parent crash = sub-agents die. v1 accepts this. (b) v2: the artifact dir can record "last known state" before each `await` point, so a recovery Worker can rehydrate. |
| **R12. `node:vm` sandbox escape** | Same as Plans A and B. The trust model is "user-authored scripts only." | Medium | Catastrophic for the user. | (a) Same as A/B: documented trust model. (b) v2: optional `--trust=untrusted` mode with restricted builtins. |
| **R13. The `JobState.kind` discriminator is a breaking type change** | Same as Plan A. | Low | Low. | (a) Default the field to `"subagent"` so existing code keeps working. (b) Note in CHANGELOG. |

## 8. Effort estimate

### New files

| File | LOC |
|------|-----|
| `workflow-worker.mjs` | ~350 |
| `workflow.ts` | ~380 |
| `workflow-allowlist.ts` | ~80 |
| `workflow.test.ts` | ~350 |
| `workflow-integration.test.ts` | ~250 |
| `demos/audit-xss.mjs` | ~50 |
| **Total new** | **~1,460** |

### Modified files

| File | Δ LOC | Description |
|------|-------|-------------|
| `subagent.ts` | +120 | New tool registration |
| `helpers.ts` | +10 | `kind` discriminator |
| `package.json` | +1 | `files` array |
| `README.md` | +60 | Workflows section |
| **Total Δ** | **+191** | |

### Estimated dev time

- **T = 4 working days** for one focused dev:
  - Day 1: `workflow-worker.mjs` — Worker entry, `vm`-less ESM loading, sandbox globals, `ctx.spawn` proxy.
  - Day 2: `workflow.ts` — main-thread bridge, message routing, `startSubagentJob` integration, `executeWorkflow` top-level.
  - Day 3: tool registration in `subagent.ts`, `kind` discriminator in `helpers.ts`, integration tests with real Workers.
  - Day 4: cancel/abort paths, edge cases (worker crash, heap-isolation smoke test), README, `npm run typecheck` + `npm test` + `npm run pack:check`.

### Order-of-magnitude token cost

Same as Plan A: zero new token overhead per sub-agent call. The protocol's `postMessage` traffic is invisible to the LLM.

## 9. Migration & compatibility

### Does this break existing users?

No. This is a purely additive change.

- The public package entry (`./subagent.ts` via the `pi` field) is unchanged.
- All existing `subagent_*` tools keep their exact signatures, schemas, return shapes.
- The `JobState` interface gains an optional `kind` field with a default of `"subagent"`.
- `package.json` `files` adds three entries.

### Deprecation path

None needed.

### Version bump

**Minor bump: `2.0.2` → `2.1.0`.**

## 10. Open questions

### Q1. How does the Worker load the user's script — `vm.Script`, dynamic `import()`, or `SourceTextModule`?

- **Option A (`vm.Script`).** The script is evaluated as a string in a `vm.Context`. ESM `import` doesn't work; scripts are effectively CommonJS-style.
- **Option B (dynamic `import()`).** The Worker does `await import(scriptPath)` to load the user's script as a regular ESM module. The `.default` export is the workflow function. No `vm` is needed.
- **Option C (`vm.SourceTextModule`).** `vm.SourceTextModule` is experimental and has shaky Node support. Avoid.
- **Recommendation:** B. Dynamic `import()` works inside Workers, supports full ESM, and integrates with Node's module loader so the script can import packages from `node_modules`. The `ctx.spawn` symbol is provided via the module's namespace (the Worker mutates the namespace before calling `.default`).

### Q2. Should the script's `import("pi-subagentura/workflow")` work?

- **Option A (no).** The script gets `spawn`, `parallel`, etc. as sandbox globals. The `pi-subagentura/workflow` module is not provided. Authors use globals.
- **Option B (yes).** The Worker provides a virtual module that re-exports the protocol. Authors write idiomatic ESM.
- **Recommendation:** A for v1. The script API is simple enough that globals are fine. Authors who want ESM can re-export from a local helper.

### Q3. Should `ctx.spawn` be sync or async from the script's perspective?

- **Option A (always async, await a promise).** Same as Plans A and B. The script does `const result = await ctx.spawn({...})`. Simple.
- **Option B (a `SubagentHandle` is returned immediately, await later).** More flexible; the script can collect handles and await them later. More complex abort semantics.
- **Recommendation:** A for v1. The script is the orchestrator; it should know what it's waiting for.

### Q4. Should we use a Worker pool (one Worker per workflow) or one Worker per script run?

- **Option A (one Worker per workflow).** Clean isolation; the worker's lifetime is the workflow's. A crashed Worker is contained.
- **Option B (one persistent Worker, multiplexed workflows).** Lower startup cost. Complex cancellation.
- **Recommendation:** A. The startup cost (~50ms) is negligible compared to the workflow's work, and isolation is the headline benefit of Plan C.

### Q5. What happens to the Worker on `parent` abort?

- **Option A (terminate).** `worker.terminate()` is preemptive; the Worker is killed. Sub-agents started by the worker may not be cleaned up cleanly.
- **Option B (cooperative).** Send `{ kind: "abort" }` to the Worker. The Worker checks `ctx.signal.aborted` between combinator iterations. Cleaner, but the script can ignore the signal.
- **Recommendation:** A first (fast, simple), then B as a follow-up. v1 sends `terminate()` after `maxDurationMs` and on `cancel`.

## 11. Why this over the other two

Plan C is the middle ground: it has Plan A's "no new bin, no new protocol" simplicity, and Plan B's "real isolation boundary" resilience (within the parent's lifetime). The Worker thread is a real V8 isolate with its own heap, so a script that allocates 1 GB doesn't bloat the parent — a meaningful win for "dozens to hundreds of parallel" workflows. **Pick Plan C if you have a real concern about parent Pi heap pressure from large workflow intermediates, or if you want preemptive abort (`worker.terminate()`).** If you don't have those concerns, Plan A is simpler and ships faster.
