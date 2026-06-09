# Plan A: In-process `node:vm` Script Runner

**Status:** Draft
**Date:** 2026-06-08
**Target release:** pi-subagentura 2.1.0
**Author:** planning agent

## 1. One-paragraph summary

Add a new tool `run_workflow({ script, args })` that loads a JS file from disk, evaluates it inside a `node:vm` `Script`/`Context`, and executes the exported `default` async function inside the **parent Pi process**. The script receives a controlled global API: `spawn`, `parallel`, `series`, `define`, plus `ctx` with `args`, `cwd`, `model`, and helper handles. `spawn` is a thin wrapper that calls the existing `subagent_with_context`/`subagent_isolated` path via `startSubagentJob` from `helpers.ts`, so this plan reuses 100% of the existing sub-agent plumbing. The script's return value is delivered to the LLM as a normal `AgentToolResult` content payload — never the intermediate work. **Headline tradeoff:** zero new infrastructure and maximum reuse, but a misbehaving script can starve or crash the parent Pi process because it shares the event loop and heap.

## 2. Goals & non-goals

### Goals

- **G1.** Ship one new tool, `run_workflow`, that the LLM can call with `{ script: "<absolute path>", args: <json> }` and get a single final result back.
- **G2.** Reuse `startSubagentJob` (from `helpers.ts`) and `jobRegistry` so workflows appear in `get_subagent_status` / `get_subagent_result` / `cancel_subagent` / `prune_subagent_jobs` for free.
- **G3.** Support a `define({ name, input, output, run })` API inside the script so authors can write reusable, composable workflow steps (matches Claude Code's workflow primitive).
- **G4.** Support `parallel` (Promise.all) and `series` (sequential reduce) combinators. `parallel` should support bounded concurrency (e.g., `parallel(tasks, { concurrency: 10 })`) to avoid OOM on N=500 audits.
- **G5.** Validate the script path is inside an allow-list (`~/.pi/workflows/` and the current `cwd`) before evaluating. Reject symlinks that escape the root. (Same defense as `findArtifactById` in `subagent.ts`.)
- **G6.** Add a `Workflows` documentation page and one `demos/` example workflow.
- **G7.** Keep the public package API (the `pi` field in `package.json`) untouched — `run_workflow` is a new tool registered from the same `subagent.ts` default export.

### Non-goals

- **N1.** We are NOT introducing a checkpointing/resume mechanism in this plan. The script is sync-from-the-LLM's-perspective: it runs to completion, the LLM sees the return value. Resumable workflows are a Plan B/C concern.
- **N2.** We are NOT sandboxing the script. It runs in the same V8 isolate as the parent, with the same Node permissions. Users running untrusted workflow scripts are out of scope.
- **N3.** We are NOT changing the artifact or interactive-tmux subsystems. A workflow script can call `spawn` (which is itself a sub-agent), but it does not write events.ndjson of its own; the spawned sub-agents do.
- **N4.** We are NOT adding a new CLI bin. Everything stays inside the `pi-subagentura` package's single `pi` extension entry.
- **N5.** We are NOT providing ESM/CJS shims for old script authors. Workflow scripts are ESM `.mjs` or `.js` files with `import` syntax.

## 3. Public API

### 3.1 The new tool: `run_workflow`

**Name:** `run_workflow`
**Label:** "Run Workflow"
**Description (for the LLM):**

> Execute a workflow script. The script is a JS file that holds an orchestration loop: it can `spawn` sub-agents, branch on results, run things in `parallel` or `series`, and return a final value. Only the final return value is delivered back to you. Use this when the work has intermediate state (loops, branching, dedup) that you don't want polluting your context.

**Parameters schema (TypeBox):**

```ts
const RunWorkflowParams = Type.Object({
  script: Type.String({
    description:
      "Absolute path to a .mjs or .js workflow script. Must live under ~/.pi/workflows/ or the current working directory.",
  }),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        "JSON object passed to the script as the first argument. The script decides what to do with it (e.g. { files: [...] }).",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory the script runs in. Default: ctx.cwd.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({
      description:
        "Default bounded concurrency for parallel() calls inside the script. Default: 8. Lower this on memory-constrained hosts.",
    }),
  ),
  maxDurationMs: Type.Optional(
    Type.Number({
      description:
        "Hard wall-clock cap. The script is aborted (AbortSignal fired) after this many ms. Default: 600000 (10 min).",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description:
        "Run in the background; returns a workflowId immediately. Use get_workflow_status / get_workflow_result to poll. (Same semantics as subagent_with_context async mode.)",
    }),
  ),
  notifyOnComplete: Type.Optional(
    Type.Union([Type.Literal("notify"), Type.Literal("inject")], {
      description:
        'When async, deliver completion notification. "notify" emits a UI hint; "inject" also sends the return value as a user message.',
    }),
  ),
});
```

**Return shape:**

```ts
// sync
{
  content: [{ type: "text", text: JSON.stringify(workflowReturnValue) }],
  details: {
    durationMs: number,
    spawnCount: number,
    spawnUsage: { input: number; output: number; cost: number; turns: number },
    modelWarnings?: string,
  },
  isError: boolean,
}

// async (returns immediately)
{
  content: [{ type: "text", text: "Workflow wfid12345 started. ..." }],
  details: { workflowId, status: "started" }
}
```

### 3.2 Companion tools (reused, not new)

- `get_workflow_status({ workflowId })` — reuses the same shape as `get_subagent_status`. In v2.1.0 we **alias** `get_workflow_status` to `get_subagent_status` by storing `workflowId` in the same `jobRegistry` with a `kind: "workflow"` discriminator. This avoids writing a parallel status tool.
- `get_workflow_result({ workflowId })` — same alias strategy.
- `cancel_workflow({ workflowId })` — calls `session.abort()` on the underlying session, same as `cancel_subagent`.
- `prune_subagent_jobs` — already cleans up everything, no change.

**Decision rubric: `run_workflow` vs `subagent_*`**

| Use `subagent_with_context` / `subagent_isolated` | Use `run_workflow` |
|---|---|
| 1–3 sub-tasks, each independent | 4+ sub-tasks, especially with branching/loops |
| You want the intermediate text in your context | You want only the final aggregate |
| The sub-tasks have no internal dependencies | Phase 2 depends on Phase 1's output |
| The orchestration is "fire 3 and pick best" | The orchestration is "spawn 500, dedupe, vote" |

## 4. Architecture & data flow

```
┌──────────────────────────────────────────────────────────────────┐
│ Parent Pi process                                                 │
│                                                                   │
│  ┌─────────────────────┐      registerTool("run_workflow", ...)  │
│  │  subagent.ts        │ ◀──────────────────────────────────────┐│
│  │  default export     │                                          ││
│  └─────────┬───────────┘                                          ││
│            │ execute()                                            ││
│            ▼                                                       ││
│  ┌─────────────────────┐    ┌──────────────────────────────────┐ ││
│  │  run_workflow       │    │  node:vm.Script                   │ ││
│  │  tool handler       │───▶│  + new vm.createContext(sandbox) │ ││
│  └─────────┬───────────┘    └──────────┬───────────────────────┘ ││
│            │                            │ script.runInContext     ││
│            │                            ▼                         ││
│            │                  ┌────────────────────┐              ││
│            │                  │  workflow script   │              ││
│            │                  │  (user's .mjs)     │              ││
│            │                  │                    │              ││
│            │                  │  default export    │              ││
│            │                  │  async (args, ctx) │              ││
│            │                  └────────┬───────────┘              ││
│            │                           │ spawn, parallel, ...    ││
│            │                           ▼                          ││
│            │                  ┌────────────────────┐              ││
│            │                  │  ctx.spawn         │              ││
│            │                  │  → startSubagentJob│ ◀── same ────││
│            │                  │    (helpers.ts)    │     process  ││
│            │                  └────────┬───────────┘              ││
│            │                           │                          ││
│            │                           ▼                          ││
│            │                  jobRegistry.set(workflowId, ...)    ││
│            │                           │                          ││
│            │                           ▼                          ││
│            │                  subagent session completes          ││
│            │                           │                          ││
│            │◀────── promise resolves ───┘                          ││
│            │                                                      ││
│            ▼                                                      ││
│   AgentToolResult { content: [{text: JSON.stringify(retval)}] }   ││
│            │                                                      ││
└────────────┼──────────────────────────────────────────────────────┘│
             ▼                                                        │
       LLM sees ONLY the return value                                │
                                                                      │
   ──────── process boundary (none — all in-process) ────────        │
   ──────── thread boundary (none — all on event loop) ──────        │
   ──────── context boundary (workflow↔sub-agent is async fn call) ──┘
```

**Key invariants**

- The workflow script and the parent Pi share one V8 isolate, one event loop, one heap. A `while (true)` in the script blocks the parent.
- Each `spawn()` call creates a real `AgentSession` via `startSubagentJob` (from `helpers.ts`) — same as the existing tools. The session is owned by the workflow's `WorkflowContext`, and disposed on script completion.
- The workflow's `workflowId` is the same shape as a sub-agent `jobId` (16 hex chars from `generateJobId`). The `jobRegistry` entry gets a new `kind: "workflow"` field so status tools can format it differently. Existing `subagent_*` tools will reject workflow ids in the `kind: "subagent"` filter.

## 5. File-by-file implementation outline

### 5.1 New files

#### `workflow.ts` (NEW — ~550 LOC)

The main workflow runtime. Lives at the repo root next to `subagent.ts` and is exported via `package.json` `files`.

**Purpose:** Script loading, validation, vm execution, context construction, lifecycle.

**Key exports:**

```ts
// ── Public types ──
export interface WorkflowContext {
  args: Record<string, unknown>;
  cwd: string;
  concurrency: number;
  signal: AbortSignal;
  /** Sub-agent spawner bound to this workflow's jobId and session. */
  spawn: (req: SpawnRequest) => Promise<SubagentResult>;
  /** Combinators exposed to the script via the vm sandbox. */
  parallel: typeof parallel;
  series: typeof series;
  /** Reusable step definitions. */
  define: typeof define;
  /** Logger that prepends [workflow <id>] and writes to a per-workflow log. */
  log: (...args: unknown[]) => void;
  /** Sub-agent jobId under which the spawned sub-agents are registered. */
  readonly workflowId: string;
}

export interface SpawnRequest {
  task: string;
  persona?: string;
  model?: string;
  cwd?: string;
  async?: false;            // workflows always await spawns; no nested async mode in v1
  includeContext?: boolean;
}

// ── Main entry point ──
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

// ── Combinators (also exported for tests) ──
export async function parallel<T>(
  tasks: Array<() => Promise<T>>,
  opts?: { concurrency?: number; signal?: AbortSignal },
): Promise<T[]>;

export async function series<T>(
  tasks: Array<() => Promise<T>>,
  opts?: { signal?: AbortSignal },
): Promise<T[]>;

// ── define() ──
export interface DefinedStep<I, O> {
  name: string;
  input: I;
  output: O;
  run: (input: I, ctx: WorkflowContext) => Promise<O>;
}
export function define<I, O>(step: DefinedStep<I, O>): DefinedStep<I, O>;
```

**Internal structure:**

1. **Imports & types** (~50 LOC) — bring in `vm`, `path`, the artifact helpers, `startSubagentJob` from `helpers.ts`, etc.
2. **`loadAndValidateScript(scriptPath, cwd)`** (~60 LOC) — checks file exists, is `.js`/`.mjs`, is inside `~/.pi/workflows/` or `cwd` (realpath containment check, mirroring `findArtifactById` in `subagent.ts:859-908`), reads text. Returns `{ source, realPath, mtimeMs }`.
3. **`buildSandbox(ctx)`** (~40 LOC) — creates a `vm.createContext` with the frozen global API surface. Includes `console` shim, but strips `process`, `require`, `globalThis.setTimeout` (use ctx.log instead). Re-adds `setTimeout`/`setImmediate`/`AbortSignal` since the script may need them.
4. **`executeWorkflow(...)`** (~180 LOC) — composes the above, runs `script.runInContext`, calls the `default` export with `(args, ctx)`, awaits the result, returns a `WorkflowResult`. Handles:
   - Top-level error catch → `WorkflowResult { isError: true, errorMessage }`
   - Abort signal handling (setTimeout-based, fires `signal` after `maxDurationMs`)
   - Aggregated usage accounting (sums `usage` from each `spawn()` call)
   - Returning the final value as `JSON.stringify(retval)` (with a size cap of 1 MB; otherwise truncated to first 1 MB + marker)
5. **`ctx.spawn` factory** (~80 LOC) — closes over `workflowId`, `defaultModel`, `parentModelRegistry`. Calls `startSubagentJob` with `cwd: ctx.cwd`. Returns the `SubagentResult` (no `async` mode inside workflows; v1).
6. **`parallel` / `series` combinators** (~80 LOC) — `parallel` uses a simple semaphore over the input array. `series` is a `for…of` reduce. Both check `signal.aborted` and throw `WorkflowAbortError` on abort.
7. **`define()`** (~30 LOC) — type-only no-op at runtime. Exists so the script-side `import { define } from "pi-subagentura/workflow"` resolves and the type narrows.

**~LOC estimate:** 550.

#### `workflow-protocol.ts` (NEW — ~120 LOC)

Protocol text the workflow script is told in its banner comment (since the script is `node:vm`-executed, not a child pi process — there is no child-pi system prompt to lean on). Mirrors `buildChildSubagentProtocol` in `interactive-tmux.ts:23-42`.

**Key exports:**

```ts
export const WORKFLOW_PROTOCOL_BANNER = `
You are running inside a pi-subagentura workflow script.
The parent agent is the LLM that called run_workflow().
Your return value (the JS value returned from default export) is delivered to the parent as JSON.
Intermediate work MUST stay in script variables — do not call back into the parent.
Available API: spawn({ task, persona?, model?, cwd?, includeContext? }), parallel([...], {concurrency?}), series([...]), define({...}), log(...), ctx.args, ctx.cwd, ctx.signal.
Abort: ctx.signal fires on maxDurationMs. Throw WorkflowAbortError to short-circuit cleanly.
`;
```

#### `workflow-allowlist.ts` (NEW — ~80 LOC)

Path validation matching the security posture of `findArtifactById`.

**Key exports:**

```ts
export function isAllowedWorkflowPath(
  absPath: string,
  cwd: string,
  homedir: string,
): { ok: true; realPath: string } | { ok: false; reason: string };
```

Checks: (1) the file extension is `.mjs` or `.js`; (2) `realpathSync(absPath)` is contained inside `~/.pi/workflows` (or `~/.pi/workflows-<workspace-hash>`) **or** inside `cwd`; (3) file is readable. Returns a structured result so the tool handler can produce a precise error message.

#### `workflow.test.ts` (NEW — see §6 for cases)

A vitest file colocated next to `workflow.ts` per the repo convention (`artifact.test.ts`, `subagent-notify.test.ts` etc.).

### 5.2 Modified files

#### `subagent.ts` (MODIFIED — +120 LOC delta)

Add the `run_workflow` tool registration, the `get_workflow_status` / `get_workflow_result` / `cancel_workflow` aliases, and the per-workflow completion notification path.

**Changes:**

1. Add a new import: `import { executeWorkflow, type WorkflowContext, type SpawnRequest } from "./workflow"`.
2. Extend the `BaseParams` schema (or define a new `RunWorkflowParams`, `WorkflowIdParams`) — see §3.1.
3. Inside the default export, after the `prune_subagent_jobs` registration (currently at line 2113-2165), add:

```ts
pi.registerTool({
  name: "run_workflow",
  label: "Run Workflow",
  description: [...],
  parameters: RunWorkflowParams,
  renderCall, renderResult,
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    return runWorkflowToolExecute({
      toolCallId: _toolCallId,
      params,
      parentSignal: signal,
      onUpdate,
      ctx,
    });
  },
});

pi.registerTool({
  name: "get_workflow_status",
  // delegates to get_subagent_status logic with kind="workflow" filter
});

pi.registerTool({
  name: "get_workflow_result",
  // delegates to get_subagent_result logic
});

pi.registerTool({
  name: "cancel_workflow",
  // delegates to cancel_subagent logic
});
```

4. Add `runWorkflowToolExecute` (~110 LOC, new function in `subagent.ts`) that:
   - Validates `params.script` via `isAllowedWorkflowPath`.
   - Generates a `workflowId = generateJobId()`.
   - For `async: true`: calls `executeWorkflow(...)` detached, registers a `JobState` (kind="workflow") in `jobRegistry`, returns the started-details.
   - For `async: false`/`undefined`: calls `executeWorkflow(...)` and awaits it. On error, returns an error `AgentToolResult`. On success, returns the final value as `JSON.stringify(retval)`.
   - Forwards `ctx.model` as `defaultModel` and `ctx.modelRegistry` as `parentModelRegistry`.
   - Honors `params.notifyOnComplete` exactly like `subagent_with_context`'s async path (calls `deliverNotification` on completion).
5. Re-export the new types from the bottom of `subagent.ts` (where `formatUsage`, `SubagentResult`, etc. are re-exported — see lines 2220-2235) so external consumers (e.g., future tests) can import them.

#### `helpers.ts` (MODIFIED — +10 LOC delta)

Extend the `JobState` interface with a discriminator:

```ts
export interface JobState {
  // ... existing fields ...
  kind: "subagent" | "workflow";  // NEW
  /** For workflows: a future hook for checkpointing (always undefined in Plan A). */
  checkpoint?: never;
}
```

Also update `pruneCompletedJobs` and `pruneOldestJob` (lines 172-192) to be `kind`-agnostic — they already are, since they look at `status`. **No logic change**, just the type addition. All existing call sites that construct `JobState` (lines 1071-1087, 1287-1303 in `subagent.ts`) get `kind: "subagent"` added.

#### `package.json` (MODIFIED — +1 line)

Add `"workflow.ts"` to the `files` array. No new dependencies. No new scripts.

#### `README.md` (MODIFIED — +60 LOC)

New "Workflows" section under "Tools" describing `run_workflow`, a tiny example script, and the "use workflows vs sub-agents" decision rubric.

### 5.3 Files NOT modified

- `interactive-tmux.ts` — workflow scripts do not spawn tmux panes. (But you can still call `subagent_interactive` from a workflow via `ctx.spawn`? No — `spawn` always uses `startSubagentJob`, not the interactive path. If users want attachable sub-agents inside a workflow, they'd need to extend `SpawnRequest` in a v2.)
- `artifact.ts` — workflow scripts have no per-script artifact; their spawned sub-agents have artifacts via the existing path.
- `subagent-artifact-cli.ts` — irrelevant; no shell CLI for workflows.

## 6. Test plan

### 6.1 Unit tests (`workflow.test.ts` — ~400 LOC)

- **`loadAndValidateScript`**
  - accepts `~/.pi/workflows/x.js`
  - accepts `<cwd>/workflows/x.mjs`
  - rejects paths outside the allow-list (`/tmp/x.js` → error with `reason: "outside_allowlist"`)
  - rejects symlinks that escape the allow-list (create a real symlink and try)
  - rejects non-`.js`/`.mjs` extensions
  - rejects missing files
- **`parallel`**
  - runs 10 tasks in parallel, returns in input order
  - honors `concurrency: 2` (verify with a `running` counter that never exceeds 2)
  - rejects on `signal.abort` (returns partial + throws)
  - propagates first rejection (the rest are short-circuited)
- **`series`**
  - runs in order, returns last value
  - short-circuits on first rejection
- **`define`**
  - returns its input unchanged (type-level smoke test)
- **`executeWorkflow` integration (in-vm)**
  - script returns `{ count: 3 }` → result is `{ kind: "workflow", value: { count: 3 }, ... }`
  - script throws → result has `isError: true, errorMessage`
  - script returns a non-JSON-serializable value (BigInt, circular) → result is the JSON parse error message, isError=true
  - script runs forever and `maxDurationMs: 100` → abort fires, result.isError=true, errorMessage includes "aborted"
  - script imports nothing from outside the sandbox → still works (vm sandbox auto-binds `Object`, `Array`, etc., but `node:fs` requires `import()`)
- **`isAllowedWorkflowPath`**
  - homedir expansion works (`~/.pi/workflows/x.js` resolves to `/Users/<u>/.pi/workflows/x.js`)
  - trailing-slash differences are normalized
- **`ctx.spawn` (mocked `startSubagentJob`)**
  - calls `startSubagentJob` with the right params (`task`, `model`, `cwd`, `parentModelRegistry`)
  - aggregates `usage` from multiple spawns
  - propagates spawn errors as `WorkflowResult.isError=true`

### 6.2 Integration tests (`workflow-integration.test.ts` — ~200 LOC)

These spin up a real workflow with a fake LLM and verify end-to-end behavior.

- **end-to-end happy path**: workflow script spawns 2 sub-agents (mocked via `vi.mock("./helpers")` to return a fixed `SubagentResult`), returns `{ count: 2 }`. Assert the tool returns the right `AgentToolResult.content`.
- **aggregation**: spawn 3 mocked sub-agents with usage `{ input: 10, output: 20, ... }`. Assert `details.spawnUsage` is `{ input: 30, output: 60, ... }`.
- **job registry integration**: a workflow with `async: true` registers a `JobState` with `kind: "workflow"`. Calling `get_workflow_status({ workflowId })` returns the live status. Calling `cancel_workflow` aborts it.
- **max-duration abort**: workflow that sleeps 30s with `maxDurationMs: 100` → `get_workflow_result` returns `isError: true` within 200ms.

### 6.3 Manual smoke tests

Prompts a user can type into a Pi session after `npm install` of the new release:

1. `"Run the workflow at ~/.pi/workflows/echo.js with args { msg: 'hi' }."`
2. `"Spawn 3 sub-agents in parallel to review README.md, README.fr.md, and README.de.md, then return a diff."` (uses an inline workflow script)
3. `"Run ~/.pi/workflows/audit-xss.js with args { files: ['src/a.ts', 'src/b.ts'] } and maxDurationMs: 30000."`
4. `"Start ~/.pi/workflows/long-job.js in the background and notify me when it's done."`

A bundled demo script `demos/hello-workflow.mjs` should pass `args: { name: "world" }` and return `\`hello, ${args.name}!\`` — used by the integration test.

### 6.4 Backward compat checks

- All existing test files (`artifact.test.ts`, `subagent-notify.test.ts`, `interactive-tmux.test.ts`, `subagent-shutdown.test.ts`, `published-tarball.test.ts`, `subagent-extension.test.ts`, etc.) must pass unchanged.
- `npm run typecheck` must pass with the new `kind` field added to `JobState`.
- `npm run pack:check` must list `workflow.ts` and `workflow-protocol.ts` in the published tarball.
- Smoke test: load the new package in a Pi session, confirm `subagent_with_context` / `subagent_isolated` / `get_subagent_status` etc. are still registered, confirm the new `run_workflow` tool is also registered.

## 7. Risk register

| Risk | Description | Likelihood | Impact | Mitigation |
|------|-------------|------------|--------|------------|
| **R1. Infinite loop blocks parent event loop** | A workflow script that runs `while (true)` blocks the parent Pi UI. | High | High — parent Pi becomes unresponsive. | (a) Enforce `maxDurationMs` default 10 min, abortable by the user. (b) Document that workflows are sync. (c) Add a `workflows.timeouts` env override for power users. (d) Long-term: consider yielding via `setImmediate` in `parallel` so a giant batch still keeps the UI responsive. |
| **R2. Workflow script escapes sandbox** | A user-authored script imports `node:child_process` and runs `rm -rf ~`. The vm sandbox does not restrict Node builtins. | Medium | Catastrophic — but only affects the user who wrote the script. | (a) Document the trust model: workflows are user-authored and trusted. (b) Path-allowlist already exists for the *script file location*; once loaded, the script can do anything the parent Pi can. (c) Future Plan: add a `--trust=untrusted` mode that uses `vm` with restricted builtins. |
| **R3. Big return value blows up LLM context** | A script returns a 50 MB object that gets `JSON.stringify`'d into the tool result. | Medium | High — OOM in parent Pi. | (a) Hard cap return value at 1 MB; truncate + marker if larger. (b) Document: write big results to a file and return `{ path: "..." }`. |
| **R4. `parallel` with 500 concurrent sub-agents OOMs** | Each sub-agent session holds model state; 500 in flight = heap exhaustion. | High | High. | (a) `parallel` is bounded by default `concurrency: 8`. (b) Sub-agents are awaited, so the event loop drains between batches. (c) Document the tradeoff in the workflow's "Best practices" section. (d) For real "hundreds parallel" use cases, recommend Plan B/C. |
| **R5. `vm.Script` cache poisoning across workflows** | The vm global object is created fresh per `run_workflow` call, but if a future maintainer reuses the sandbox they could leak state between workflows. | Low | Medium. | (a) Code review: every `runWorkflowToolExecute` call gets a fresh `vm.createContext()`. (b) Test: run workflow A that mutates `globalThis.foo = 1`, then workflow B that reads `globalThis.foo` — assert B sees `undefined`. |
| **R6. `JobState.kind` discriminator is a breaking type change** | If a third-party extension imports `JobState` from `./helpers` and constructs one without `kind`, TypeScript complains. | Low | Low — only affects the package's published `.d.ts`. | (a) Default the field to `"subagent"` so existing code keeps working. (b) Note in CHANGELOG. |
| **R7. `node:vm` microtask queue behavior on abort** | `vm.Script` runs in the host's microtask queue. Aborting via `signal.abort` does NOT interrupt synchronous code in the script. A tight `for` loop won't notice the abort. | Medium | Medium. | (a) Combinators check `signal.aborted` between iterations. (b) Document: workflows are cooperative, not preemptive. (c) For preemptive abort, recommend Plan C. |
| **R8. `import()` inside a vm context** | A workflow script does `import { something } from "pi-subagentura/workflow"`. The vm context doesn't have a module loader; dynamic `import()` may resolve relative to the script file. | Medium | High — authors will hit this immediately. | (a) Test all three import styles in the integration test: dynamic `import("pi-subagentura/workflow")`, relative `import("./helpers.js")`, `node:` builtins. (b) Provide a tiny `workflow-shim.mjs` re-export if needed. (c) Document the supported import set in the README. |
| **R9. Concurrent workflow writes to the same `ctx.log` destination** | If two workflows log simultaneously, lines interleave. | Low | Low. | (a) Each workflow gets its own log file under `<artifactRoot>/workflows/<id>.log`. |
| **R10. Tool result schema drift with `pi-coding-agent` SDK** | If the SDK changes the `AgentToolResult` shape (e.g., adds a required `details.kind` discriminator), this plan's `details` payload may need updating. | Low | Low. | (a) Pin the SDK peerDependency. (b) Mirror the existing `subagent_with_context` payload shape exactly. |

## 8. Effort estimate

### New files

| File | LOC |
|------|-----|
| `workflow.ts` | ~550 |
| `workflow-protocol.ts` | ~120 |
| `workflow-allowlist.ts` | ~80 |
| `workflow.test.ts` | ~400 |
| `workflow-integration.test.ts` | ~200 |
| `demos/hello-workflow.mjs` | ~15 |
| **Total new** | **~1,365** |

### Modified files

| File | Δ LOC | Description |
|------|-------|-------------|
| `subagent.ts` | +120 | New tool registration + helpers + re-exports |
| `helpers.ts` | +10 | Add `kind` discriminator to `JobState` |
| `package.json` | +1 | Add `workflow.ts` to `files` |
| `README.md` | +60 | Workflows section |
| **Total Δ** | **+191** | |

### Estimated dev time

- **T = 3 working days** for one focused dev familiar with the package, broken down as:
  - Day 1: `workflow-allowlist.ts` + `workflow.ts` skeleton (load + sandbox + executeWorkflow) + unit tests for the allowlist and `parallel`/`series`.
  - Day 2: `runWorkflowToolExecute` in `subagent.ts`, the `JobState.kind` discriminator, integration tests for the happy path and async mode.
  - Day 3: error paths, abort handling, demos, README, doc review, `npm run typecheck` + `npm test` + `npm run pack:check`.

### Order-of-magnitude token cost

For the LLM at runtime, calling `run_workflow` is one tool call whose `result` payload is the workflow's return value. If the workflow returns `{ count: 500, sample: [...3 items] }`, the LLM sees ~3 KB of text. The cost of *running* the workflow is `Σ` of the spawned sub-agents' costs, which is identical to the cost of running those sub-agents directly. **The plan introduces zero new token overhead per sub-agent call.** The total LLM-context cost is bounded by `O(retval_size)`, not `O(spawns × per-spawn output)`.

## 9. Migration & compatibility

### Does this break existing users?

No. This is a purely additive change.

- The public package entry (`./subagent.ts` via the `pi` field) is unchanged.
- All existing `subagent_*` tools keep their exact signatures, schemas, return shapes.
- The `JobState` interface gains an optional `kind` field with a default of `"subagent"`, so any external code that constructs one without setting `kind` still type-checks.
- `package.json` `files` adds one entry.

### Deprecation path

None needed — nothing is being removed.

### Version bump

**Minor bump: `2.0.2` → `2.1.0`.** SemVer: new functionality in a backwards-compatible manner.

## 10. Open questions

### Q1. Should `run_workflow` accept an inline string for `script`, or only a path?

- **Option A (path only).** Cleaner: file-on-disk is the source of truth, easy to lint, easy to share. Forces the LLM to use `write` to create a file before running, which is two tool calls.
- **Option B (path or string).** More flexible: a workflow can be a one-shot snippet. But: where is the file? `write` to a tmpfile? Inline `vm` eval? Inline eval skips the allowlist, which weakens security.
- **Recommendation:** Path only in v1. Add `script: <inline>` in v2 if users ask for it.

### Q2. Should `ctx.spawn` allow `async: true` (returning a `jobId` to be awaited later)?

- **Option A (no, v1).** All spawns are awaited; the workflow waits for every sub-agent before continuing. Simpler. The script's intermediate state is in variables.
- **Option B (yes).** Scripts can fire-and-forget sub-agents and check in on them later via `ctx.jobRegistry`. More flexible. More complex abort semantics.
- **Recommendation:** No in v1. The whole point of Plan A is "intermediate state in script variables, not in the parent." If the script wants parallelism, it uses `parallel`. If users really need fire-and-forget, that's Plan B/C territory.

### Q3. Should `define()` provide any runtime validation, or is it type-only?

- **Option A (type-only).** Pure TypeScript helper. `define({...})` returns the same object. Cheap, no runtime cost.
- **Option B (Zod/TypeBox).** Validates `input` and `output` against the schema at runtime. Useful for cross-workflow composition.
- **Recommendation:** Type-only in v1. Validation is the responsibility of the script's own assertions or a future Zod add-on.

### Q4. What's the right default for `concurrency`?

- **Option A (8).** Matches the existing job registry cap. Fits most hosts.
- **Option B (4).** Conservative; safer on memory-constrained laptops.
- **Option C (configurable per-call only, no default).** Force authors to think.
- **Recommendation:** Default 8, overridable per `parallel()` call and per `run_workflow` invocation. The `concurrency` param at the tool level is the new global knob.

### Q5. How do we handle workflow errors that occur *after* `run_workflow` has returned to the LLM (e.g., a spawn that was queued but rejected)?

- **Option A (collect all into the return value).** The script is responsible for try/catch around every spawn. `parallel` already does this.
- **Option B (partial failure protocol).** `parallel` returns `{ fulfilled: T[], rejected: Error[] }` and the script decides. More flexible for "best-effort 500 audits" use cases.
- **Recommendation:** `parallel` returns `PromiseSettledResult<T>[]` (the `Promise.allSettled` shape). Authors opt into "fail-fast" via `Promise.all(await parallel(...))` if they want.

## 11. Why this over the other two

Plan A is the cheapest path to a working workflow primitive: it reuses `startSubagentJob` and `jobRegistry` from `helpers.ts` verbatim, ships ~700 LOC of new code, and is a minor version bump. Plan B (sidecar subprocess) requires a new npm bin, stdio protocol, lifecycle CLI mirrors `subagent-artifact-cli.ts`, and survives parent crashes — overkill for the v1.0 use case where users are authoring their first workflows. Plan C (worker_threads) gives true heap isolation but inherits the same `startSubagentJob` reuse and adds `postMessage` boilerplate for no v1 win. **Pick Plan A if you want to ship the feature, learn what users actually do with it, and decide later whether the isolation or subprocess story matters.**
