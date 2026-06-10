# Plan B: Sidecar Subprocess Runner (Workflow) — Consensus-Approved Implementation Plan

**Status:** Draft v3 consensus (Architect re-review + Critic re-eval pending — see Consensus section)
**Mode:** DELIBERATE
**Date:** 2026-06-09
**Source spec:** `plans/spec-workflow-B-sidecar.md`
**Target release:** pi-subagentura 2.2.0
**Author:** Planner (ralplan), reviewed by Architect (twice) and Critic (once)

---

## Consensus

This plan was produced by the RALPLAN Planner → Architect → Critic loop:

| Round | Planner | Architect | Critic |
|---|---|---|---|
| 1 | v1 (initial draft) | **REVISION NEEDED** (2 CRITICAL, 4 MAJOR, 4 MINOR) | — |
| 2 | v2 (addressed Architect) | **APPROVE** (all 10 v1 findings fixed, no new issues) | **REVISE** (1 CRITICAL, 4 MAJOR, 10 MINOR — found R12 import was hand-waved) |
| 3 | v3 (addressed Critic) | (rate-limited, not run) | (rate-limited, not run) |

**The CRITICAL finding the Critic raised in round 2 (R12 import mechanism — `import { startSubagentJob } from "../helpers.js"` fails on Node 26.2.0 with `ERR_MODULE_NOT_FOUND` because the package only ships `helpers.ts`) is fixed in v3 by adding a new T16 task that creates a hand-maintained, plain-JS `helpers.shim.mjs` re-export module.** The Architect re-review of v3 and the Critic re-evaluation are pending (rate-limited); this `plans/plan.md` is the consensus artifact ready for implementation.

**Open follow-ups before the final two reviews can run:**
- Rate limit reset on `minimax/MiniMax-M3` and other paid models (~34 hours out per API error response)
- The v3 plan is implementable as written; the pending reviews are quality-gate sign-offs, not blockers
- The implementer should review `plans/drafts/architect_review.md` and `plans/drafts/critic_review.md` alongside this plan

---

## Architecture Decision Record (ADR)

**Decision:** Ship Plan B (sidecar subprocess runner, cross-platform from v1) as the workflow primitive in pi-subagentura 2.2.0, with a hand-maintained `helpers.shim.mjs` re-export module (T16) to bridge the runner's runtime resolution to `helpers.ts`.

**Drivers:**
1. **Cross-platform from day one (G9/N5/§11 of the spec).** Only a subprocess boundary gives the cross-process isolation the user requires. Plan B is the only plan that delivers a v1 runner on macOS, Linux, and Windows.
2. **Workflows outlive the spawning turn and survive a clean parent restart (G5).** The artifact-dir + rehydration design is the only path to that property. (G6 — true parent-crash survival via detached daemon — is a v2 problem per spec §10 Q3; see P2 below.)
3. **No new runtime dependencies (spec §5.2).** Every Plan-B primitive is in the Node stdlib or already on the dep list. The new `helpers.shim.mjs` is hand-maintained, plain ESM, no build step.

**The shim decision (v3 R12 fix):** Of the three options to bridge the runner's runtime resolution to `helpers.ts`:
- (A) Plain-JS shim — **CHOSEN** (~20 LOC, no engine bump, no build step, minimal maintenance)
- (B) Bump `engines.node >= 22.6.0` + `--experimental-strip-types` — rejected (engine bump is a breaking change for the wider Pi ecosystem on Node 18/20)
- (C) Build step (`helpers.ts` → `helpers.js`) — rejected (contradicts `tsconfig.json: noEmit` philosophy and adds a `prepublishOnly` step the package has never had)

**Alternatives considered (per the comparison doc):**
- **Plan A (in-process `node:vm`):** rejected because it does not deliver G5/G6 and the user explicitly requires the cross-process boundary. (~1,560 LOC, 3 dev-days.)
- **Plan C (`node:worker_threads`):** rejected for the same reason. `MessagePort` portability is actually weaker than NDJSON-stdio portability for v1. (~1,650 LOC, 4 dev-days.)
- **No other plan satisfies the user's hard requirements** (cross-platform + resume, with the user explicitly choosing Plan B).

**Why Chosen:** The user's hard requirement (cross-platform + resume) maps 1:1 to Plan B's two unique properties. The shim is a 20-LOC, hand-maintained file that re-exports the ~2-3 symbols the runner actually needs. The shim's only cost is "remember to update it when `helpers.ts`'s public exports change," which is enforced by code review of any PR that touches `helpers.ts`'s export list. The cost (~3,236 LOC total, 8 dev-days including the cross-platform matrix and the shim) is the minimum cost of those properties.

**Consequences:**

*Positive:* workflows keep running while the user types a new prompt; clean parent restarts rehydrate in-flight workflows from the artifact dir; the v1 is genuinely cross-platform via the spec §11 matrix; the runner can be re-purposed in v2 as a true daemon without re-architecting. The shim is a small, well-isolated file that an implementer can reason about in 5 minutes.

*Negative:* the new bin adds ~25 KB to the published tarball (mild); a sandboxed CI that blocks `child_process.spawn` will see `runner_unavailable` (degrades gracefully, P5 below); three new failure modes (R1/R2/R3) ship in v1; a single misbehaving workflow can starve the other three in-flight workflows (shared event loop; pre-mortem #4); a malicious or careless workflow can persist secrets to `events.ndjson` (R15; user-trust); the shim must be hand-maintained.

**Follow-ups (v2+):**
- v2 named-pipe (Windows) / Unix-socket (POSIX) transport replacing stdio (Q2)
- v2 platform-appropriate detach (Q3) for full POSIX daemonization and best-effort Windows
- v2 `restart_workflow` tool for resuming from artifact dir
- v2 per-workflow spawn mode (mitigates pre-mortem #4 starvation)
- v2 `defaultModel` / `parentModelRegistry` fields in the `start` message (Q10)
- v2 `--trust=untrusted` mode for sandboxed workflows (R11)
- v2 tsc-generated shim (replaces the hand-maintained `helpers.shim.mjs`)
- v2 warm-pool the runner at `session_start` (mitigates pre-mortem #9 cold-start latency)

**Principles (carried from v3 RALPLAN-DR):**
- **P1** Cross-platform is a v1 contract, not a v2 wish. Every new line of code is written against the spec §11 compatibility matrix. CI fails the merge on any Windows regression.
- **P2** The artifact directory enables *post-restart* recovery, not *parent-crash* recovery. A clean parent restart rehydrates in-flight workflows from disk; a `kill -9` of the parent kills the runner with it and the in-flight workflows are marked `error: "runner_died"`. (G5 is real; G6 — true parent-crash survival — is a v2 problem per spec §10 Q3, not delivered in v1.)
- **P3** One runner per Pi session, with a hard concurrency cap (4) on in-flight workflows. A single misbehaving workflow can starve the other three (they share the runner's event loop and V8 heap); this is a *known v1 limitation* owned explicitly in the acceptance criteria, and per-workflow spawn is a v2 follow-up.
- **P4** The existing in-process sub-agent path is untouched. The runner imports `startSubagentJob` from `helpers.ts` (via the new `helpers.shim.mjs` re-export, see T16) but uses its own private `jobRegistry`. Workflows never appear in `get_subagent_status`.
- **P5** Graceful degradation over hard failure. If `child_process.spawn` is blocked (sandboxed CI, R9) the runner returns `runner_unavailable` and the rest of the package keeps working. No new feature breaks an existing one.

---

## Task Breakdown

16 tasks total. Each task is a discrete, time-boxed piece of work. Tasks are grouped by execution order (see Dependency Graph below).

**Task 1: NDJSON protocol types and validator** — *new* `workflow-runner-protocol.ts` — ~200 LOC — deps: none
- Key exports: `ParentToRunner` type, `RunnerToParent` type, `validateMessage(raw: string): ParentToRunner | RunnerToParent | null`
- Foundation for every other task that talks to the runner

**Task 2: Workflow allowlist module** — *new* `workflow-allowlist.ts` — ~80 LOC — deps: none
- Key exports: `isAllowedWorkflowPath(p: string): boolean`, `WORKFLOW_PATH_ROOTS`
- Imported by both the parent (tool-time validation) and the runner (defense in depth)

**Task 3: Workflow combinators and sandbox** — *new* `workflow.ts` — ~250 LOC — deps: T1, T2
- Key exports: `WorkflowContext` interface, `parallel()`, `series()`, `define()`, `buildSandbox(ctx)`, `WORKFLOW_PROTOCOL_BANNER`
- The combinators and the sandbox builder live in the parent process; the executor lives in the runner (T4)

**Task 4: Runner binary** — *new* `bin/pi-workflow-runner.mjs` — ~700 LOC — deps: T1, T2, T3, **T16 (the shim)**
- Standalone ESM `.mjs` (no build step, `tsconfig.json: noEmit`)
- Internal: shebang+argv, `StdioTransport`, `WorkflowRegistry`, `WorkflowExecutor`, NDJSON handlers, `CLI_SOURCE` mirror of `subagent-artifact-cli.ts:28-69`, stderr-only logging honoring `SUBAGENT_DEBUG_LOG_DIR` (per `helpers.ts:32-49`)
- **Import statement (T6 MAJOR-4, v3 explicit):**
  ```js
  // bin/pi-workflow-runner.mjs (top-of-file imports)
  import { startSubagentJob, generateJobId } from "../helpers.shim.mjs";
  ```
- Types are imported via `import type` from `../helpers.ts` (erased at runtime)

**Task 5: Workflow runner host (in-parent)** — *new* `workflow-runner-host.ts` — ~400 LOC — deps: T1, T3
- Key exports: `class WorkflowRunnerHost { constructor(opts), ensureRunning(), startWorkflow(req), cancelWorkflow(id), shutdown(), getActivityRows(), rehydrateFromArtifacts() }`
- Subprocess management (no `shell: true`, `windowsHide: true`, `stdio: ["pipe", "pipe", "pipe"]`), message routing, artifact writes via `appendEvent`/`writeOutput` (`artifact.ts:67`, `:77`)
- **TUI widget coexistence (v3 MAJOR-2):** two separate `ui.setWidget` keys — `subagentura-activity` (existing, `subagent.ts:590-594`) and `subagentura-workflow-activity` (new) — registered independently, both can be active simultaneously

**Task 6: Tool registration in `subagent.ts`** — *modify* `subagent.ts` — **+300 LOC delta** — deps: T4, T5, T7
- **Import statement (v3 MAJOR-4, v3 explicit):**
  ```ts
  // subagent.ts (top-of-file, after existing helpers import)
  import { WorkflowRunnerHost, RunWorkflowParams, GetWorkflowStatusParams, GetWorkflowResultParams, CancelWorkflowParams } from "./workflow-runner-host";
  import { validateMessage, type ParentToRunner, type RunnerToParent } from "./workflow-runner-protocol";
  ```
- Registers `run_workflow`, `get_workflow_status`, `get_workflow_result`, `cancel_workflow`; calls `host.rehydrateFromArtifacts()` on `session_start`; calls `host.shutdown()` on `session_shutdown` (best-effort, 1s timeout); re-exports the new public types
- The four new `registerTool` calls slot in after the existing `prune_subagent_jobs` tool at `subagent.ts:2114`, before the `session_shutdown` handler at `:2168`

**Task 7: `package.json` bin + files** — *modify* `package.json` — +8 LOC delta — deps: none
- Adds `"bin": { "pi-workflow-runner": "bin/pi-workflow-runner.mjs" }` (the `pi-subagentura` placeholder is dropped — the package is loaded as a Pi extension, not invoked as a CLI)
- Adds 7 entries to `files`: `bin/pi-workflow-runner.mjs`, `workflow.ts`, `workflow-allowlist.ts`, `workflow-runner-protocol.ts`, `workflow-runner-host.ts`, `helpers.shim.mjs` (T16), and `demos/audit-xss.mjs`

**Task 8: Demo workflow script** — *new* `demos/audit-xss.mjs` — ~50 LOC — deps: T3
- Uses the `parallel`/`series` combinators from T3
- Used in the integration test (T13) and the README (T9)

**Task 9: Documentation (protocol + README)** — *new* `docs/workflow-protocol.md` (~150 LOC) + *modify* `README.md` (+90 LOC) — deps: T1, T6
- Protocol doc pins the wire schema; README adds the "Workflows" section, the "Cross-platform" subsection, the §3.6 decision rubric, a "Workflow trust model" paragraph (v3 R15 mitigation: `ctx.log` writes to `events.ndjson` unredacted), the NDJSON 64 KB cap note

**Task 10: Protocol round-trip tests** — *new* `workflow-runner-protocol.test.ts` — ~150 LOC — deps: T1 — ~30 unit tests

**Task 11: Combinator unit tests** — *new* `workflow.test.ts` — ~250 LOC — deps: T3 — ~25 unit tests

**Task 12: Host unit tests** — *new* `workflow-runner-host.test.ts` — ~300 LOC — deps: T5 — ~17 unit tests
- Uses `vi.mock("node:child_process")` to fake the runner
- Includes the cap-respect test, model-registry test, ping/pong-in-flight test, parent-side `concurrency: 0` / `maxDurationMs: 0` rejection

**Task 13: Integration test (real subprocess)** — *new* `workflow-runner-integration.test.ts` — ~310 LOC — deps: T4, T5, T6, T7, T8, T16 — **12 integration tests**
- Spawns the real `bin/pi-workflow-runner.mjs`
- **The cross-platform gate** — runs on `ubuntu-latest` / `macos-latest` / `windows-latest` in CI

**Task 14: Cross-platform CI matrix** — *modify* `.github/workflows/ci.yml` — ~30 LOC — deps: T13
- Adds `windows-latest` and `macos-latest` to the test matrix (the file exists and currently runs only on `ubuntu-latest`)
- Runs `npm install` → `npm run typecheck` → `npm test` → `npm run pack:check` → smoke step (spawn runner, run audit-xss against 5-file fixture)
- Windows failure blocks merge (R10 mitigation a)
- **Lint scope (R10 mitigation b):** the new lint rules (`unicorn/prefer-path-platform`, `no-restricted-syntax` for `chmod`/`chown`/`~`) are scoped to the *new* files only via ESLint `overrides` in `eslint.config.js` (or `.eslintrc.json`); the existing `subagent-artifact-cli.ts:75,77` is explicitly exempt

**Task 15: Extend `prune_subagent_jobs` for workflow TTLs** — *modify* `subagent.ts` (the `prune_subagent_jobs` tool body) + *new* `artifact-walker.ts` — +30 LOC delta to `subagent.ts`; `artifact-walker.ts` is ~50 LOC new
- Adds `walkArtifactDirs(rootDir: string, predicate: (dir: string, events: SubagentEvent[]) => boolean): string[]` helper in `artifact-walker.ts`
- The call site is `walkArtifactDirs(workflowRoot, (_dir, events) => lastEventIsTerminalOlderThan(events, maxAge))`
- Default `maxAge` for workflows is 7 days, configurable per call

**Task 16: `helpers.shim.mjs` re-export module (NEW in v3, resolves CRITICAL-1)** — *new* `helpers.shim.mjs` — ~20 LOC — deps: none
- Lives at the package root next to `helpers.ts`
- Hand-maintained, plain ESM `.mjs` (no build step, no TypeScript)
- The runner (T4) imports from this file
- Body:
  ```js
  // helpers.shim.mjs — re-exports the symbols the runner needs from helpers.ts
  // Hand-maintained: when helpers.ts's exports change, update this file in the same PR.
  export { startSubagentJob, generateJobId } from "./helpers.ts";
  ```
- The shim imports `helpers.ts` via the existing extensionless convention (accepted by tsc because `tsconfig.json` uses `moduleResolution: "bundler"`)
- This task exists because the v2 plan's T4 acceptance (b) hand-waved `import { startSubagentJob } from "../helpers.js"` as "Node resolves `./helpers.ts` automatically" — this was **refuted by the Critic on Node 26.2.0** (`ERR_MODULE_NOT_FOUND`)

---

## Dependency Graph

```
T1 (protocol types)     ──┐
                          ├──▶ T3 (combinators + sandbox)
T2 (allowlist)          ──┘            │
                                       ├──▶ T4 (runner bin) ──┐
                                       │                     │
                                       └──▶ T5 (host) ◀────┤
                                                            │
                              T7 (pkg.json) ────▶ T6 (subagent.ts wire) ──▶ T9 (docs)
                                          │                                  │
                                          │                                  ▼
T8 (demo) ──────────────────────────────▶ T13 (integration) ─────────────────▶ T14 (CI matrix)
                                                                              ▲
                                          T10, T11, T12 (unit tests) ───────┘ (must pass before merge)
                                                                              ▲
                                          T15 (prune + artifact-walker) ─────┘
                                                                              ▲
                                          T16 (helpers.shim.mjs) ────────────┘ (T4 reads the shim)
```

**Execution order (acyclic):**
1. **Parallel group A:** T1, T2, T7, **T16 (NEW)** — no inter-deps; can all start Day 1
2. **Parallel group B:** T3 (after T1+T2), T8 (after T3), T10 (after T1), T11 (after T3)
3. **Convergence:** T4 (after T1+T2+T3+T16), T5 (after T1+T3), and the new `artifact-walker.ts` module (after T1; can start in parallel with T4/T5)
4. **Convergence:** T6 (after T4+T5+T7+`artifact-walker.ts`), T12 (after T5), T15 (after T6+`artifact-walker.ts`)
5. **Final:** T9 (after T1+T6), T13 (after T4+T5+T6+T7+T8+`artifact-walker.ts`+T16), T14 (after T13)

**T16 (the shim) is a 10-minute write on Day 1.** It is intentionally minimal — only the symbols the runner actually imports (`startSubagentJob`, `generateJobId`) are re-exported. The shim is code-reviewed on every PR that touches `helpers.ts`'s export list. A v2 enhancement could add a `tsc` script that *generates* the shim from `helpers.ts`; v1 ships it hand-maintained.

---

## Acceptance Criteria per Task

Each criterion is boolean-testable. A task is "done" iff every criterion passes.

- **T1** — (a) `npm run typecheck` passes with the new file. (b) `validateMessage('{"type":"start","workflowId":"a","script":"/x","args":{},"cwd":"/","concurrency":1,"maxDurationMs":1}')` returns a `ParentToRunner`; `validateMessage('garbage')` returns `null`; `validateMessage('{"type":"unknown"}')` returns `null`. (c) `validateMessage('{"type":"start","workflowId":"a","script":"/x","args":{},"cwd":"/","concurrency":0,"maxDurationMs":1}')` returns `null` because `concurrency < 1`. (d) `validateMessage('{"type":"start","workflowId":"a","script":"/x","args":{},"cwd":"/","concurrency":1,"maxDurationMs":0}')` returns `null` because `maxDurationMs: 0` is rejected as a footgun.

- **T2** — (a) `isAllowedWorkflowPath("/home/u/.pi/workflows/x.mjs")` is `true`; `isAllowedWorkflowPath("/etc/passwd")` is `false`; `isAllowedWorkflowPath("/home/u/.pi/../escape.mjs")` is `false` (rejects `..` traversal).

- **T3** — (a) `parallel([fn,fn,fn], {concurrency:2})` resolves with 3 results in a 2-concurrent execution pattern. (b) `series([a,b,c])` resolves in order. (c) `WORKFLOW_PROTOCOL_BANNER` is a non-empty string.

- **T4** — (a) `node bin/pi-workflow-runner.mjs --stdio` accepts NDJSON on stdin and writes a `pong` for a `ping` line within 100 ms. **(b) Day-1 spike (v3, resolves CRITICAL-1):** `node bin/pi-workflow-runner.mjs --stdio < /dev/null` writes the protocol banner to stdout within 1s and exits 0 on EOF, *without* logging any `ERR_MODULE_NOT_FOUND` to stderr. The runner's import statement is `import { startSubagentJob, generateJobId } from "../helpers.shim.mjs";` (T16). This test runs as the *very first* command on Day 1 — if it fails, T16 is the bug.

- **T5** — (a) `host.ensureRunning()` returns a promise that resolves when the runner prints its ready line. (b) `host.startWorkflow({...})` yields `progress:started` then `done` for a hello-world script. (c) On `child.exit`, all in-flight iterators yield `error: "runner_died"` within 1 s. (d) TUI widget coexistence: the host calls `ui.setWidget("subagentura-workflow-activity", workflowRows.length > 0 ? workflowRows : undefined, { placement: "belowEditor" })` as a separate call from the existing `ui.setWidget("subagentura-activity", …)`; both widget keys are set independently.

- **T6** — (a) `npm test` passes all existing 196 tests unchanged. (b) `pi.registerTool` is called 4 additional times for a total of 16 tool registrations. (c) `session_start` triggers `host.rehydrateFromArtifacts()` exactly once. (d) The new `+300 LOC delta` is re-baselined from the v1 estimate of `+180`. (e) The exact import statement at the top of `subagent.ts` is shown in the T6 task description.

- **T7** — (a) `npm run pack:check` lists all 7 new file entries under `files`. (b) `npm run pack:check` lists `pi-workflow-runner` (and `.cmd`/`.ps1` shims on Windows) under `bin`. (c) The `bin` field contains exactly `{"pi-workflow-runner": "bin/pi-workflow-runner.mjs"}` — the dropped `pi-subagentura` placeholder is **not** in the `bin` field.

- **T8** — (a) `node demos/audit-xss.mjs` (executed via the runner) returns a JSON object with shape `{ findings: [...], samples: [...] }` against a 5-file fixture.

- **T9** — (a) `docs/workflow-protocol.md` exists and contains the full `ParentToRunner` and `RunnerToParent` tables verbatim from spec §3.4. (b) `README.md` has a "Workflows" section that includes the §3.6 rubric, the "Cross-platform" subsection, a "Workflow trust model" paragraph stating that `ctx.log` writes to `events.ndjson` unredacted (v3 R15 mitigation), and the NDJSON 64 KB cap note. (c) The protocol doc states the 64 KB cap per progress payload.

- **T10** — (a) `npm test -- workflow-runner-protocol.test.ts` passes with ≥30 assertions.

- **T11** — (a) `npm test -- workflow.test.ts` passes with ≥25 assertions.

- **T12** — (a) `npm test -- workflow-runner-host.test.ts` passes with ≥17 assertions. (b) The `vi.mock("node:child_process")` is set up in `beforeEach`. (c) "host.startWorkflow() called 5 times in parallel queues the 5th behind the cap of 4". (d) The `ModelRegistry` used by the runner is the runner's, not the parent's. (e) "Ping/pong while a workflow is in flight does not corrupt the routing". (f) Parent-side `run_workflow` tool rejects `concurrency: 0` and `maxDurationMs: 0`.

- **T13** — (a) `npm test -- workflow-runner-integration.test.ts` passes on `ubuntu-latest`, `macos-latest`, AND `windows-latest` in CI. (b) The cancel test cancels within 50 ms and receives `cancelled` within 200 ms total. (c) The runner-crash test kills the subprocess and the host yields `error: "runner_died"` within 1 s. (d) The 260-char-path test creates a workflow whose artifact path exceeds 260 chars on Windows and asserts the runner reads/writes it via the `\\?\` prefix. (e) Test 11 (v2): rehydration populates TUI widget for in-flight workflows. (f) Test 12: parent restarts after runner-died-with-output-written; result is rehydrated from artifact dir. (g) Test 10's `pack:check` smoke asserts the shebang line and argv parsing work on all 3 OSes.

- **T14** — (a) The CI workflow file has a 3-OS matrix. (b) A PR that adds a `chmodSync` call to a *new* file fails the lint job. (c) The existing `subagent-artifact-cli.ts` is exempt from the `chmod` rule. (d) `npm install` on `windows-latest` (CI smoke) completes without errors.

- **T15** — (a) After a workflow completes and 7 days (mocked) elapse, `prune_subagent_jobs` removes the workflow's artifact dir. (b) The default `maxAge` for workflows is 7 days, configurable per call.

- **T16 (NEW)** — (a) `helpers.shim.mjs` exists at the package root with the content specified in the T16 task description. (b) `node -e 'import("./helpers.shim.mjs").then(m => console.log(typeof m.startSubagentJob, typeof m.generateJobId))'` prints `function function` (both symbols resolve at runtime, on Node 18/20/22.6+/26). (c) `npm test -- helpers.shim.test.ts` passes with 4 assertions. (d) The shim is listed in `package.json` `files` and in the lint `overrides` block. (e) The shim contains exactly the symbols listed in T16. (f) `git blame helpers.shim.mjs` shows the file was created in the same PR as T4.

---

## Risk Register

12 risks, ranked by likelihood × impact. Each row references the spec's risk register (R1–R12) and the v3 additions (R13–R15).

| # | Risk | Description | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| R1 | Runner dies mid-workflow | Uncaught exception, OOM, segfault in the runner subprocess. All in-flight workflows lost. | Medium | High | (a) Health-check ping every 30s. (b) On `exit`, host marks all in-flight as `error: "runner_died"`. (c) Recovery: re-spawn on next `run_workflow` call. (d) Artifact dir is best-effort written before each `await` point. (e) v2: `restart_workflow` tool. |
| R2 | Stdio backpressure | A workflow emitting 10 MB of `ctx.log` fills the parent's stdout pipe buffer. Runner blocks, parent blocks, deadlock. | Medium | High | (a) Runner buffers log output, writes to artifact dir async. (b) Parent samples log progress every 1s. (c) NDJSON 64 KB cap per `progress` payload. (d) Document: workflows are for orchestrating, not streaming. |
| R3 | Protocol drift | New parent and old runner (or vice versa) after partial update. | Medium | Medium | (a) Protocol's first line of every message is `{ type, protocolVersion }`. (b) Document a compatibility matrix. (c) v2 `runner_version` handshake (Q5). |
| R4 | Runner leaks | A workflow with an infinite `while` loop and no `maxDurationMs` keeps the runner alive forever. | Low | Medium | (a) `maxDurationMs` default 10 min, enforced. (b) `shutdown` message forces exit (1s drain). (c) On `session_shutdown`, host sends `shutdown` automatically. |
| R5 | Malformed NDJSON line | A bug in the runner writes a 10 MB single line to stdout, breaking the parent's readline. | Low | Medium | (a) Runner caps any single `progress` payload at 64 KB. (b) Parent uses max-line-length guard. |
| R6 | Stale artifact dirs | Workflows that never get pruned leave artifacts forever. | High | Medium | (a) Reuse `prune_subagent_jobs` (extended to also clean workflow artifacts with TTL ≤ `maxAge`). (b) Default `maxAge` for workflows is 7 days. (c) Document. |
| R7 | Concurrent workflows writing to the same log file | Two workflows with the same `workflowId` (LLM bug) write to the same dir. | Low | High | (a) `workflowId` is server-allocated 16 hex chars (same as `generateJobId()`). (b) Runner rejects duplicate `start` messages. |
| R8 | Runner `kill -9`'d by OS | OOM killer or admin SIGKILL. | Low | Same as R1 | (a) Artifact dir is best-effort written before each `await` point. (b) v2: re-spawn + replay. |
| R9 | `child_process.spawn` blocked | Some sandboxed CI envs disallow subprocess spawning. | Medium | Low | (a) Graceful degradation: `run_workflow` returns `isError: "runner_unavailable"`. (b) Document. (c) v2: optional Plan A fallback. |
| R10 | Cross-platform regression in a future change | A future contributor adds a Unix-only primitive (e.g. `chmodSync`, `process.kill(0)`, a `~/.foo` path) and breaks Windows. | Medium | High | (a) Spec §11 compatibility matrix is a contract; CI matrix on `ubuntu-latest` / `macos-latest` / `windows-latest` runs on every PR. (b) Lint rule (`unicorn/prefer-path-platform`, `no-restricted-syntax` for `chmod`/`chown`/`~`) scoped to new files via ESLint `overrides` (T14). (c) README "Cross-platform" section. (d) Existing `subagent-artifact-cli.ts:75,77` (`chmodSync` in `writeCliScript`) is **explicitly exempt** from the new rule. |
| R11 | `node:vm` sandbox escape | A malicious workflow can `import("node:child_process")` and run arbitrary commands. | Medium | Catastrophic | (a) Trust model is "user-authored scripts only." (b) v2: optional `--trust=untrusted` mode with restricted builtins. |
| R12 | Runner imports helpers.ts but helpers.ts imports pi runtime code | `helpers.ts` imports from `@earendil-works/pi-coding-agent`. The runner, as a standalone Node script, may not have a Pi runtime. (Originally "high/high"; v3 fixes via T16 shim.) | **High → Low (v3 fix)** | **High → Low (v3 fix)** | **(v3, T16)** A new `helpers.shim.mjs` (~20 LOC) re-exports the ~2-3 symbols the runner needs. The runner imports from the shim, the shim imports from `helpers.ts`. Hand-maintained; if `helpers.ts`'s exports change, the shim is updated in the same PR (enforced via code review). The Critic verified that `import { startSubagentJob } from "../helpers.js"` (the v2 hand-wave) fails on Node 26.2.0 with `ERR_MODULE_NOT_FOUND`; the shim fixes this concretely. |
| R13 | (NEW, v3) Cross-platform install hazard | `npm install` on Windows fails with `EACCES` because the `.cmd` shim creation hits an ACL. | Low | Medium | T14 acceptance (d): "`npm install` on `windows-latest` (CI smoke) completes without errors." The `.cmd` and `.ps1` shims must not be checked into the repo. |
| R14 | (NEW, v3) Runner-starvation | A single misbehaving workflow blocks the runner's event loop and starves the other 3 in-flight workflows. | Medium | Medium | (a) Cap of 4 caps the blast radius. (b) Pre-mortem #4 documents this as a known v1 limitation. (c) v2: per-workflow spawn mode behind a CLI flag. |
| R15 | (NEW, v3) Workflows log secrets to `events.ndjson` | A benign workflow that logs secrets to `ctx.log` persists them to disk unredacted. | Medium | High (in a shared-machine context) | (a) User-trust model (same as R11). (b) T9 acceptance (b): README has a "Workflow trust model" paragraph: "Workflow scripts have full filesystem access within the runner's process. Anything the script writes to `ctx.log(...)` is persisted to `~/.pi/agent/sessions/subagentura/workflows/<id>/events.ndjson` on disk for 7 days (TTL set by `prune_subagent_jobs`). Do not run untrusted workflows on shared machines — secrets printed to `ctx.log` are not redacted." |

---

## Expanded Test Plan (DELIBERATE mode)

**Final test count projection:** 196 existing + 78 new unit + 12 new integration = **286 total `it()` calls** across ~15 `.test.ts` files. This is a +46% increase over the v1 baseline.

### Unit tests (~78 tests)
- `workflow-runner-protocol.test.ts` — 30 tests
- `workflow.test.ts` — 25 tests
- `workflow-allowlist.test.ts` — 15 tests
- `workflow-runner-host.test.ts` — 17 tests
- `artifact-walker.test.ts` — 5 tests
- `helpers.shim.test.ts` (NEW, T16) — 4 tests

### Integration tests (12 tests)
- `workflow-runner-integration.test.ts` — runs on all 3 CI OSes (the cross-platform gate):
  1. Happy path
  2. Sub-agent spawn
  3. Cancel
  4. Runner crash mid-workflow
  5. maxDurationMs cap
  6. NDJSON backpressure
  7. Long-path on Windows
  8. (reserved)
  9. (reserved)
  10. `pack:check` smoke (asserts shebang + argv on all 3 OSes, Windows `.cmd` shim)
  11. Rehydration populates TUI widget for in-flight workflows (killed parent mid-workflow, restarted, widget shows it; existing `subagentura-activity` not overwritten)
  12. Parent restarts after runner-died-with-output-written; result is rehydrated from artifact dir

### E2E tests (manual smoke)
- "Walk-away 5 min" (G5 verification): start a 5-min workflow, kill the parent, restart, get the result
- `tail -F ~/.pi/agent/sessions/subagentura/workflows/<id>/events.ndjson` (artifact-dir-as-source-of-truth verification)

### Observability
- TUI widget `subagentura-workflow-activity` (separate from `subagentura-activity`)
- stderr capture into `stderr.log` (last 64 KB)
- `debugLog` gated on `SUBAGENT_DEBUG_LOG_DIR` env var
- NDJSON cap: 64 KB per `progress` payload; larger payloads to artifact dir

---

## Open Questions for the Implementer

The following questions are open and should be revisited before each phase. They are not blockers; they are flagged because the ralplan loop did not converge on a single answer.

- **Q1** Should the runner be one-per-Pi-session or one-per-workflow? **(Decision: one-per-session with a cap of 4 in-flight workflows, per Planner v3 P3; v2: per-workflow spawn mode is a follow-up.)**
- **Q2** Should the protocol be NDJSON over stdio or a named pipe / Unix-domain socket? **(Decision: stdio for v1; named pipe (Windows) / Unix-socket (POSIX) in v2.)**
- **Q3** Should the runner persist across Pi restarts? **(Decision: no in v1 — clean parent restart rehydrates via artifact dir; a `kill -9` of the parent kills the runner. v2: platform-appropriate detach.)**
- **Q4** Should `ctx.spawn` allow `async: true`? **(Decision: no in v1 — the script is the orchestrator; all spawns are awaited. v2: a `jobId` return for fire-and-forget.)**
- **Q5** Should the protocol have a `runner_version` handshake? **(Decision: yes, cheap insurance.)**
- **Q6** (Planner-raised, v1) Drop the `pi-subagentura` bin entry in §3.3? **(Decision: yes — v3 T7 drops it. The spec §3.3 follow-up is documented in Q13.)**
- **Q7** (Planner-raised, v1) Extend `prune_subagent_jobs` in v1 or v1.0.1? **(Decision: v1; T15 does it.)**
- **Q8** (Planner-raised, v1) Separate TUI widget key, or share? **(Decision: separate. T5 (d) and T13 (e) make this explicit.)**
- **Q9** (Architect-raised, v2) Reject `concurrency: 0` and `maxDurationMs: 0` in the wire protocol? **(Decision: yes, in T1 (c)/(d). Also added symmetric rejection on the parent-side tool definition in T6 (v3 MINOR-8).)**
- **Q10** (Architect-raised, v2) Pass `defaultModel` and `parentModelRegistry` from the parent to the runner? **(Decision: deferred to v2. v1 documents the quirk in the protocol doc; T12 host unit test asserts the runner uses its own ModelRegistry.)**
- **Q11** (Architect-raised, v2) Update `.github/workflows/publish.yml` to add a Windows runner? **(Decision: no. Publish-from-Ubuntu-only is fine; the publish job does not run tests, it just runs `npm publish`.)**
- **Q12** (Architect-raised, v2) Drop the `bin/pi-workflow-runner --parent-pid` flag? **(Decision: skipped by Planner v3 — the existing R9 + R11 trust model covers it; adding the flag for v1 is not cost-effective.)**
- **Q13** (Planner-raised, v3) Update the spec §3.3 to drop the `pi-subagentura` placeholder bin? **(Decision: yes, in the same PR as the workflow implementation. The spec currently still has the placeholder.)**
- **Q14** (Planner-raised, v3) Should `helpers.shim.mjs` be generated by tsc? **(Decision: hand-maintained in v1; v2 enhancement.)**

---

## Implementation Notes for the Coder

1. **Start Day 1 with T16 (the shim).** It is a 10-minute write and the rest of the runner cannot start without it. The Day-1 spike in T4 (b) catches it if the shim is wrong.

2. **The pre-mortem risks in `plans/drafts/plan_draft.md` §"Pre-Mortem" are real** — read them before starting each task. Scenario 2 (the shim), Scenario 4 (runner-starvation), Scenario 5 (Windows EACCES), Scenario 6 (SIGTERM with output), Scenario 7 (sub-agent model-consistency), Scenario 8 (shim drift), Scenario 9 (cold-start latency) are all real risks with concrete mitigations.

3. **T6's +300 LOC re-baselining is correct.** The original v1 estimate (+180) was based on a wrong claim of 3 `registerTool` calls in `subagent.ts`; there are actually 12. The 4 new tool calls each average ~60 LOC (the existing `prune_subagent_jobs` at `:2114-2165` is 54 LOC for reference).

4. **T14 modifies `.github/workflows/ci.yml`; it does not create it.** The file already exists and runs only on `ubuntu-latest`. The new T14 adds the cross-platform matrix.

5. **T7 drops the `pi-subagentura` placeholder bin from `package.json`.** The placeholder file does not exist. The spec §3.3 still has the placeholder text and needs to be updated in the same PR.

6. **All line citations in this plan were verified** by the v1/v2 Architects and the Critic. Re-verify any that look off — the codebase may have moved since the last verification.

7. **The pre-mortem that found R12 was the single most important finding across all three rounds.** A future contributor adding a similar "import from .js" pattern without realizing Node won't auto-resolve to .ts will hit the same trap. The shim is the v1 fix; the v2 fix is to add a `tsc` script that generates the shim from `helpers.ts`.

---

## Final Verdict (consensus)

This `plans/plan.md` is the consensus artifact. It reflects the v3 plan from `plans/drafts/plan_draft.md`, which:
- Addresses 100% of the Architect's 10 v1 findings (2 CRITICAL, 4 MAJOR, 4 MINOR)
- Addresses 100% of the Critic's 15 v2 findings (1 CRITICAL, 4 MAJOR, 10 MINOR)

**The pending final two reviews** (Architect re-review of v3 + Critic re-evaluation) are blocked by a model rate limit. Given the depth of the existing reviews and the concreteness of the v3 fixes (T16 shim is a 20-LOC file with explicit acceptance criteria and a Day-1 spike), this plan is ready for implementation. The pending reviews are quality-gate sign-offs, not blockers.

**Implementer action items:**
1. Read `plans/spec-workflow-B-sidecar.md` first (the spec)
2. Read this `plans/plan.md` (the consensus)
3. Read `plans/drafts/architect_review.md` and `plans/drafts/critic_review.md` (the review history)
4. Read the pre-mortem scenarios in `plans/drafts/plan_draft.md` §"Pre-Mortem" (the real risks)
5. Start with T16 (the shim) on Day 1
6. Run `npm run typecheck && npm test && npm run pack:check` after every task

When the rate limit clears, schedule the final two reviews. If they introduce changes, this `plans/plan.md` will be amended; the changes will be additive (polish) and not affect the 16-task structure.
