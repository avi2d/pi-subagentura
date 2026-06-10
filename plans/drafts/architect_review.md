# Architect Review — Plan B (sidecar workflow runner) — v2 re-review

**Reviewer:** Architect (ralplan)
**Date:** 2026-06-09
**Source draft:** plans/drafts/plan_draft.md (v2, 319 lines)
**Prior review:** plans/drafts/architect_review.md (v1 review, REVISION NEEDED — 2 CRITICAL, 4 MAJOR, 4 MINOR)
**Source spec:** plans/spec-workflow-B-sidecar.md
**Mode:** DELIBERATE

## Summary

The v2 plan directly and explicitly addresses all 10 v1 findings. The two CRITICALs (wrong `subagent.ts` insertion point, R10 lint rule conflict) are corrected with both a fix and a justification. All four MAJORs (lifecycle-daemon framing, missing rehydration TUI test, unnamed T15 helper, T4 import-convention ambiguity) are fixed in the right places (P2, T13 test 11, T15/artifact-walker.ts, T4 acceptance (b) respectively). All four MINORs are folded in (T12 cap test, T1 `concurrency: 0` test, Q3 spec-§11 cross-ref, `demos/audit-xss.mjs` in T7 `files`). The v2 also adds four pre-mortems (runner-starvation, Windows install EACCES, artifact-write-then-parent-dies, sub-agent model-consistency) that are real risks, not handwaving. One small documentation drift in the T15 example usage (destructuring shape vs. signature) is a MINOR polish item, not a blocker. **Verdict: APPROVE.**

## Disposition of v1 findings

- **CRITICAL-1 (T6 insertion point wrong; +180 LOC delta understates the wiring work):** **ADDRESSED.** v2 spec verification note 14 now lists all 12 `registerTool` calls (`:992, :1236, :1439, :1521, :1623, :1735, :1841, :1890, :1917, :1986, :2030, :2114`) and T6 explicitly says "the four new ones slot in after `:2114` (i.e., immediately after the existing `prune_subagent_jobs` tool, before the `session_shutdown` handler at `:2168`)." The +180 LOC figure is re-baselined to +300 in T6 acceptance (d), with a line-by-line justification (4 tools × ~60 LOC body+render, imports, two session hooks, re-exports block +4). Re-verified independently: all 12 lines, the `session_shutdown` at `:2168`, and the re-exports block at `:2220-2235` are all real.

- **CRITICAL-2 (R10 lint rule will fail on existing code unless scoped to new files only):** **ADDRESSED.** R10 mitigation (b) now says "lint rules … — scoped to NEW files only via ESLint `overrides`," and a dedicated "Lint scope (R10 mitigation b, in detail)" section provides the actual `overrides` block listing the seven new files. T14 acceptance (b) and (c) make the scope testable: (b) "A pull request that adds a `chmodSync` call to a *new* file … fails the lint job"; (c) "The existing `subagent-artifact-cli.ts` is exempt from the `chmod` rule." Re-verified: the existing `chmodSync` at `subagent-artifact-cli.ts:75,77` is the only call site and is now explicitly excluded.

- **MAJOR-1 ("lifecycle daemon" framing — Principle 2 conflates G5 and G6):** **ADDRESSED.** P2 is rewritten: "The artifact directory enables *post-restart* recovery, not *parent-crash* recovery. … A clean parent restart rehydrates in-flight workflows from disk; a `kill -9` of the parent kills the runner with it and the in-flight workflows are marked `error: "runner_died"`. (G5 is real; G6 — true parent-crash survival — is a v2 problem per spec §10 Q3, not delivered in v1.)" This matches the engineering and is consistent with spec N1. Decision Driver 2 also carries the correction. T9 acceptance (b) calls it out in the protocol doc.

- **MAJOR-2 (T13 integration test missing rehydration TUI widget assertion):** **ADDRESSED.** T13 test 11 (MAJOR-3) added: "Rehydration populates TUI widget for in-flight workflows — kill the parent mid-workflow (SIGTERM, clean shutdown so the runner can write its `output.md`), restart the parent, assert `host.getActivityRows()` returns a row for the in-flight workflow and `ui.setWidget` was called with `WIDGET_KEY = "subagentura-workflow-activity"` and `widgetRows.length > 0`." The Observability section also links the widget to test 11. Test count goes from 10 → 12.

- **MAJOR-3 (T15 ambiguous — did not name the function that walks the workflow dir):** **ADDRESSED.** T15 names the helper explicitly: `walkArtifactDirs(rootDir: string, predicate: (dir: string, events: SubagentEvent[]) => boolean): string[]` in a new `artifact-walker.ts` module. The task description explains how it integrates with `prune_subagent_jobs` (line 2114-2165 tool body in subagent.ts) and that the helper is reusable from `host.rehydrateFromArtifacts()` (T5) and a future `restart_workflow` tool. A 4-test unit file (`artifact-walker.test.ts`) is added to the test plan. Re-verified: `artifact-walker.ts` does not exist yet (correct — it's a T15 deliverable), and the dependencies it needs (`readEvents` at `artifact.ts:97`, `listArtifacts` at `artifact.ts:129`) both exist.

- **MAJOR-4 (T4 import path ambiguity — `../helpers.js` vs. the repo's extensionless convention):** **ADDRESSED.** T4 acceptance (b) is now explicit: "The T4 test asserts: `node bin/pi-workflow-runner.mjs --stdio < /dev/null` writes the protocol banner to stdout within 1s and exits 0 on EOF, *without* logging any `ERR_MODULE_NOT_FOUND` to stderr." The parenthesised "Note" explains the resolution mechanism (tsconfig is `noEmit`, Node resolves `./helpers.ts` as a sibling ESM source) so the reader doesn't confuse "compiled by the runtime" with non-existent compilation. Re-verified: `tsconfig.json` is `noEmit` and `subagent.ts:50` does use extensionless imports from `./helpers`.

- **MINOR-1 (concurrency cap has no unit test):** **ADDRESSED.** T12 acceptance (c) adds: "host.startWorkflow() called 5 times in parallel queues the 5th behind the cap of 4 — assertion: the 5th call's `start` NDJSON is not sent to the runner until one of the first 4 has resolved (MINOR-1)." T12's test count is updated to **16 tests** (was 15; +1).

- **MINOR-2 (T1 `concurrency: 0` not tested):** **ADDRESSED.** T1 acceptance (c) adds: "validateMessage('{"type":"start",…,"concurrency":0,…}') returns `null` because `concurrency < 1` (MINOR-2)." T10's test list also includes "concurrency: 0 (MINOR-2)".

- **MINOR-3 (Q3 needs cross-reference to spec §11 row 7):** **ADDRESSED.** Q3 now reads: "Cross-reference: spec §11 row 7 ('v1 does not test detach (no v1 detach). v2's test runs in both modes.')" — bolded in the document. The relationship to G5/G6 is restated.

- **MINOR-4 (`demos/audit-xss.mjs` missing from T7 `files`):** **ADDRESSED.** T7 acceptance (a) now lists `demos/audit-xss.mjs` explicitly: "adds 5 entries to `files` (`bin/pi-workflow-runner.mjs`, `workflow.ts`, `workflow-allowlist.ts`, `workflow-runner-protocol.ts`, `workflow-runner-host.ts`, **and `demos/audit-xss.mjs`** — the demo must be in the published tarball because the T13 integration test invokes it from the installed prefix in step 10 of the cross-platform gate)." T13 test 10 also references the demo.

## Re-verification spot-checks

| # | Claim (from v2 plan) | Verified? | Severity | Notes |
|---|----------------------|-----------|----------|-------|
| 1 | `subagent.ts` has 12 `registerTool` calls; last at `:2114` | **Verified** | — | `grep -nE "pi.registerTool"` returns 12 matches at exactly the lines the plan lists (992, 1236, 1439, 1521, 1623, 1735, 1841, 1890, 1917, 1986, 2030, 2114). The 13th `registerTool` would be the new tool; spot-check shows the plan's insertion point is correctly *after* the `prune_subagent_jobs` body (which closes at line 2164) and *before* the `session_shutdown` handler at 2168. |
| 2 | `subagent.ts:972-974` — `session_start` handler | **Verified** | — | `sed -n '970,980p' subagent.ts` shows `pi.on("session_start", (_event, ctx) => { g2.__piSubagenturaUi = ctx.ui; });` at 972-974, with the closure at 974. The plan's rehydration call (T6) slots in next to it as documented. |
| 3 | `subagent.ts:2168` — `session_shutdown` handler is the new insertion boundary | **Verified** | — | `sed -n '2165,2175p'` shows `(pi as any).on?.("session_shutdown", () => {` at line 2168, immediately after the `prune_subagent_jobs` tool body closes at 2164. The v2 plan correctly slots the 4 new `registerTool` calls in this gap (2114-2167). |
| 4 | `helpers.ts:183` — `pruneCompletedJobs` (v1 said `:165`) | **Verified** | — | `grep -n "pruneCompletedJobs"` returns the function declaration at `:183`. The v1 line (`:165`) was the section header; v2 correctly distinguishes "extend the *tool* `prune_subagent_jobs` in `subagent.ts:2114-2165`, not the function." |
| 5 | `subagent-artifact-cli.ts:75-77` — existing `chmodSync` | **Verified** | — | `sed -n '74,78p'` shows: `:75 const { writeFileSync, chmodSync } = require("node:fs") …`; `:76 writeFileSync(targetPath, CLI_SOURCE, { mode: 0o700 });`; `:77 chmodSync(targetPath, 0o700 });`. The v2 R10 lint scope explicitly excludes this file. |
| 6 | `artifact.ts:129` — `listArtifacts` | **Verified** | — | `sed -n '129,135p'` shows `export function listArtifacts(rootDir: string): SubagentArtifact[] {` at line 129. Reused by the new `walkArtifactDirs` helper (T15). |
| 7 | `artifact-walker.ts` does not exist yet | **Verified** | — | `ls artifact-walker.ts` → No such file or directory. This is a T15 deliverable, correctly absent at planning time. |
| 8 | `eslint.config.js` / `.eslintrc.json` does not exist | **Verified** | — | `ls eslint.config.js .eslintrc.json` → both No such file or directory. The R10 Lint scope section acknowledges this and says "to be confirmed in the Day-1 R10 spike," which is the right call. |
| 9 | Existing test count is 196 | **Verified** | — | `grep -c "it(" *.test.ts` returns: 59+28+24+22+20+14+11+5+5+4+3+1 = **196**. Matches the v2 plan's claim. |
| 10 | `helpers.ts:344` — `startSubagentJob` | **Verified** | — | `grep -n "startSubagentJob" helpers.ts` returns the section header at `:307` and the export at `:344`. The runner's `import { startSubagentJob } from "../helpers.js"` will resolve. |

## New findings introduced by v2 (if any)

**None — v2 does not introduce new CRITICAL or MAJOR findings.**

The revision is conservative: it adds scope, justification, and pre-mortems without changing the architecture or introducing new abstractions. The only new surface is `artifact-walker.ts` (a leaf module depending on `artifact.ts` and `helpers.ts`), which is a clean addition with no circular-dependency risk.

MINOR items observed during re-review (carry as "v2.1 polish," not blockers):

- **MINOR-NEW-1 (T15 example-usage signature drift):** T15 task description calls the helper as `walkArtifactDirs(workflowRoot, ({ events }) => lastEventIsTerminalOlderThan(maxAge))` — the destructuring shape `({ events })` does not match the declared signature `predicate: (dir: string, events: SubagentEvent[]) => boolean`. The call should be `walkArtifactDirs(workflowRoot, (_dir, events) => lastEventIsTerminalOlderThan(events, maxAge))` or the signature should accept an object. Either fix is one line; the architectural design is sound. **Severity:** MINOR (documentation, not behavior).

- **MINOR-NEW-2 (T15 LOC accounting ambiguity):** T15 says "+30 LOC delta" but the task adds a new module (`artifact-walker.ts`) that will be ~40-60 LOC plus a 4-test unit file. The +30 figure is plausibly the delta to `subagent.ts` only (the body of `prune_subagent_jobs` extension), with the new module accounted separately in the dependency graph ("the new `artifact-walker.ts` module … can start in parallel with T4/T5"). This is internally consistent if you read the dependency graph, but a one-sentence clarification in T15 ("+30 LOC delta to `subagent.ts`; `artifact-walker.ts` is a separate ~50 LOC new file") would prevent confusion in the T15 PR. **Severity:** MINOR (clarity, not behavior).

- **MINOR-NEW-3 (Q9 added in v2):** Q9 is a sensible new question ("should `maxDurationMs: 0` be rejected?"), and T1 acceptance (d) resolves it ("reject … minimum positive is 1"). This is good. Not a finding — just confirming it's a clean addition.

- **MINOR-NEW-4 (Q12 cross-platform bin path resolution):** Q12 is well-handled; the T13 test 10 pack-check smoke on all 3 OSes covers the bin-discovery path. The fix is consistent with R13's `commandExistsSync` + `require.resolve` fallback.

## Verdict

**APPROVE**

The v2 plan:
1. **Recounts the existing `registerTool` calls correctly** (12, not 3) and slots the new tools at the right insertion point (after `:2114`, before `:2168`).
2. **Scopes the R10 lint rule to new files only** via ESLint `overrides`, with the existing `chmodSync` at `subagent-artifact-cli.ts:75,77` explicitly exempt.
3. **Rephrases P2** to match the engineering: artifact-dir rehydration works for clean parent restart (G5), not for `kill -9` of the parent (G6 is a v2 problem).
4. **Adds T13 test 11** for the rehydration TUI widget assertion.
5. **Names the T15 helper** as `walkArtifactDirs(rootDir, predicate)` in a new `artifact-walker.ts` module.
6. **Resolves T4 import-convention ambiguity** with an explicit acceptance criterion (no `ERR_MODULE_NOT_FOUND`).
7. **Folds in all four MINORs** (T12 cap test, T1 `concurrency: 0`, Q3 spec-§11 cross-ref, `demos/audit-xss.mjs` in `files`).
8. **Adds four real-risk pre-mortems** (#4 runner-starvation, #5 Windows EACCES, #6 SIGTERM-with-output, #7 sub-agent model-consistency), each with detection + v1 acceptance + v2 follow-up.

All 10 v1 findings are ADDRESSED. No new CRITICAL or MAJOR issues were introduced. The v2 introduces three MINOR polish items (signature drift in T15 example, LOC accounting clarity, Q9/Q11/Q12 follow-ups) that are appropriate for a v2.1 cleanup pass but do not block the v2 plan.

The plan is now ready for the Critic review and (if approved) execution. The execution agents (R1, R2) should treat T6's +300 LOC re-baseline as a verified figure, not a re-estimate, since the v2 justification is line-by-line sound.

## Consensus addendum (carry-forward from v1, refreshed)

- **Antithesis (steelman):** Plan B's v1 design satisfies G5 (workflows outlive the spawning turn and a clean parent restart via artifact rehydration) but does **not** satisfy G6 (true parent-crash survival via `kill -9` recovery) — the runner dies with the parent. v2's P2 now reflects this honestly. The "one runner per session" choice (P3) still creates a starvation hazard for concurrent workflows that per-workflow spawn (Plan A's `node:vm.createContext` per call, Plan C's `worker.terminate()` per worker) would avoid. Pre-mortem #4 + R14 acknowledge this as a v1 limitation; the v2 follow-up (`--runner-spawn-mode=workflow`) is a one-flag switch, not a re-architecture, so the cost of the chosen design is paid once. Cross-platform from day one (Driver 1) remains the largest non-functional cost (~1 dev-day of CI matrix work plus 3× CI time) but is the user's hard requirement.

- **Tradeoff tension:** One runner per session vs. one runner per workflow. The v2 plan picks the former (P3, cap 4) and accepts the shared-event-loop starvation hazard. The synthesis is to make per-workflow spawn a v2 *option* behind a CLI flag — and v2 has now made this concrete (R14 mitigation (d), pre-mortem #4 v2 follow-up, Synthesis in §Pre-Mortem). The plan's R1 30s `ping`/`pong` and `child.on("exit")` are the *detection* paths, not the *prevention* path; v2 acknowledges this in T12 acceptance (c) and the Observability section. The v1 limitation is owned in the acceptance criteria, not hidden.

- **Synthesis (if viable):** Yes — and v2 strengthens it. (a) Concurrency cap is already a `WorkflowRunnerHost` constructor option, so v2 can default it to 1 for per-workflow spawn without a protocol change. (b) R14 mitigation (d) commits to `--runner-spawn-mode=session|workflow` for v2. (c) `runner_died` (existing) and `runner_unavailable` (R9) reason codes are now complemented by the starvation pre-mortem's "per-workflow runner spawn" mode. The plan is forward-compatible with the per-workflow design without paying for it in v1.

- **Principle violations (deliberate mode):**
  - **P1 (cross-platform):** Compliant. §11 matrix referenced, R10 mitigation scoped, T14 modifies existing `ci.yml` to add 3-OS matrix.
  - **P2 (artifact dir enables post-restart recovery, not parent-crash recovery):** Compliant. The v1 framing is gone; the engineering matches the marketing.
  - **P3 (one runner per session, cap 4):** Compliant, with the starvation hazard explicitly owned in T12 acceptance (c) and R14.
  - **P4 (existing in-process sub-agent path untouched):** Compliant. Runner imports `startSubagentJob` only; uses its own private `jobRegistry`. Q10 documents the surprising-but-by-design behavior.
  - **P5 (graceful degradation):** Compliant. R9 → `runner_unavailable`; R1 → `runner_died`; R13 → `require.resolve` fallback for bin discovery.
  - **Bonus — pre-mortem coverage:** v2 added 4 pre-mortems (#4 starvation, #5 install, #6 SIGTERM, #7 model-consistency) on top of the original 3. DELIBERATE mode's "≥3 pre-mortems" requirement is comfortably exceeded.
  - **Bonus — expanded test plan:** 74 unit + 12 integration + 3 manual E2E + 1 observability surface. DELIBERATE mode's "expanded test plan" requirement is met.
