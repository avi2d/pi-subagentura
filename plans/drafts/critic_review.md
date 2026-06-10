# Critic Review — Plan B (sidecar workflow runner) — v2 re-review

**Reviewer:** Critic (ralplan)
**Date:** 2026-06-09
**Source draft:** `plans/drafts/plan_draft.md` (v2, 319 lines)
**Prior review:** `plans/drafts/architect_review.md` (v2, APPROVE)
**Source spec:** `plans/spec-workflow-B-sidecar.md`
**Mode:** DELIBERATE

---

**VERDICT: REVISE**

**Overall Assessment**: The v2 plan is architecturally sound, addresses all v1 findings, and the Architect's review was thorough. **However, the v2 plan did not actually resolve the original R12 (high/high) risk** — the new "Note" in T4 acceptance (b) hand-waves the import-resolution mechanism in a way that is demonstrably false on the engine floor (`engines.node: ">=18.0.0"`). I verified by running Node 26.2.0 against the proposed `import { startSubagentJob } from "../helpers.js"` path: it fails with `ERR_MODULE_NOT_FOUND` because the package only ships `helpers.ts`, not `helpers.js`. This is a Day-1 spike failure that the plan does not propose a fix for. Several smaller issues (placeholder-bin spec drift, TUI widget coexistence, no secret redaction) also survived both prior reviews. One CRITICAL + 3 MAJOR must be resolved before implementation; everything else is implementable.

---

## Pre-commitment Predictions (Phase 1)

Before reading the v2 plan in detail, I expected the most likely problem areas to be:

1. **R12 (runner ↔ helpers.ts ↔ pi-coding-agent dependency chain)** — flagged "high/high" in v1, claimed resolved in v2. Skeptical the resolution is real.
2. **The "Day-1 spike" is paper over, not solve** — plans often add a spike task to defer a real architectural decision.
3. **TUI widget key collision** — the existing `subagentura-activity` widget at `subagent.ts:590` and a new `subagentura-workflow-activity` widget both call `ui.setWidget`; the spec doc/plan doesn't show how they coexist.
4. **Engine floor vs. type-stripping** — `engines.node: ">=18.0.0"` is incompatible with `import .ts` at runtime; the plan picks one or the other.
5. **Test count / `subagent.ts` LOC accounting** — the +300 LOC delta in T6 is a re-baseline, easy to get wrong.

**What I found:** #1 is a CRITICAL confirmed issue; #2 is a symptom of #1; #3 is a MAJOR; #4 is part of the R12 fix; #5 is verified accurate.

---

## Verification of Plan Claims (Phase 2)

### New file:line citations I verified (NOT in Architect's 20 spot-checks)

| # | Claim (from v2 plan) | Verified? | Method | Notes |
|---|----------------------|-----------|--------|-------|
| 1 | `subagent.ts` has 12 `registerTool` calls; lines 992, 1236, 1439, 1521, 1623, 1735, 1841, 1890, 1917, 1986, 2030, 2114 | **Verified** | `grep -nE "registerTool" subagent.ts` | 12 matches at exactly the lines the plan claims. |
| 2 | `subagent.ts` ends at line 2236 (not 2235) | **Verified** | `wc -l subagent.ts` | Plan says "re-exports block at `:2220-2235`"; the helpers re-export block does end at 2235 (`} from "./helpers";`), but the file has one more line (2236) for `export { interactiveSubagentRegistry } from "./interactive-tmux";`. Plan is technically correct but slightly imprecise. |
| 3 | `package.json` lists `pi-coding-agent` as a **peer** dep | **Verified** | `cat package.json` | Line 53: `"@earendil-works/pi-coding-agent": "*"`. This means a user installing `pi-subagentura` without `pi` itself gets a missing-peer warning, and the runner can't actually start. The plan does not call this out. |
| 4 | `tsconfig.json` is `noEmit` with `moduleResolution: "bundler"` | **Verified** | `cat tsconfig.json` | `noEmit: true`, `moduleResolution: "bundler"`. The `bundler` resolution allows extensionless imports; **this is a tsc-side concern only** — Node's runtime resolution at the bin level is still extension-sensitive. |
| 5 | `package.json` has no `bin` field, no `bin/` directory | **Verified** | `ls bin/` → no such file; `grep bin package.json` → 0 matches | Correct. T7 + T4 are net-new. |
| 6 | `.github/workflows/ci.yml` exists and runs only on `ubuntu-latest` | **Verified** | `cat .github/workflows/ci.yml` | Line 12: `runs-on: ubuntu-latest`. T14 needs to add `macos-latest` and `windows-latest`. |
| 7 | No `eslint.config.js` or `.eslintrc.*` exists | **Verified** | `ls eslint.config.* .eslintrc*` | Both missing. R10 mitigation b says "to be confirmed in the Day-1 R10 spike" — this is honest. |
| 8 | `subagent-artifact-cli.ts:75-77` contains the existing `chmodSync` | **Verified** | `sed -n '70,78p' subagent-artifact-cli.ts` | Lines 75 (`const { writeFileSync, chmodSync } = require("node:fs")`), 76 (`writeFileSync(...{ mode: 0o700 })`), 77 (`chmodSync(...0o700)`). R10 lint scope exemption is correctly scoped. |
| 9 | `helpers.ts:18-24` imports `createAgentSession` from `@earendil-works/pi-coding-agent` | **Verified** | `sed -n '18,24p' helpers.ts` | Lines 18-24: `import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";`. **This is the actual transitive chain the runner inherits if it imports `startSubagentJob`.** |
| 10 | `npm view pi-subagentura version` returns 2.1.0 | **Verified** | `npm view pi-subagentura version` | 2.1.0 confirmed. Local `package.json` is 2.0.2 (drift; standard for a dev branch). Plan's "2.1.0 → 2.2.0" target is correct. |
| 11 | **`import { ... } from "./helpers.js"` works in a vanilla Node process against this repo** | **REFUTED** | Ran `node /tmp/test-resolve.mjs` against `/Users/applesucks/dev/pi-agents-workflow/helpers.{js,ts}` | **`helpers.js` does not exist; `helpers.ts` cannot be loaded by Node's default ESM resolver** (tested on Node 26.2.0, returns `ERR_MODULE_NOT_FOUND`). The plan's T4 acceptance (b) is **unverifiable as written**. See CRITICAL-1. |

### Other claims checked

- **`subagent.ts:972-974`** — `pi.on("session_start", (_event, ctx) => { g2.__piSubagenturaUi = ctx.ui; });` ✓
- **`subagent.ts:590-594`** — `ui.setWidget(WIDGET_KEY, widgetRows.length > 0 ? widgetRows : undefined, { placement: "belowEditor" });` ✓
- **`artifact.ts:67,77`** — `appendEvent` at 67, `writeOutput` at 77 ✓
- **`helpers.ts:183`** — `pruneCompletedJobs` at 183 (the v1 said `:165`, which was a section header) ✓
- **`subagent.ts:2235` helpers re-exports** — ends with `} from "./helpers";` ✓

---

## Critical Findings (blocks execution)

### 1. **R12 is NOT actually resolved — the runner's import path is broken on the engine floor**

- **Evidence:** T4 acceptance (b) says "the runner's `import { startSubagentJob } from "../helpers.js"` resolves at runtime because `tsconfig.json` is `noEmit` and Node resolves `./helpers.ts` as a sibling ESM source." I tested this on Node 26.2.0 (well above the engine floor of 18). The import `from "../helpers.js"` returns `ERR_MODULE_NOT_FOUND` because:
  - `package.json` `files` array ships `helpers.ts` (line 31 of the actual file), not `helpers.js`.
  - Node's default ESM resolver does NOT auto-fallback to `.ts` extensions.
  - `tsconfig.json:noEmit` is a tsc-side concern; the runtime is unaffected.
- **The chain of failure:** the runner is a `.mjs` file (per spec §5.1, "plain ESM `.mjs` so it runs without a build step"). It is spawned as a child of Pi (`child_process.spawn` per T5). It executes with the user's Node from `$PATH`. The engine floor is `>=18.0.0` (package.json line 35). On Node 18/20/21/22.5 and earlier, no type-stripping. On Node 22.6+ / 23+, requires `--experimental-strip-types` or a shebang hack. **The plan does not commit to any of these mechanisms.**
- **Confidence:** HIGH — I ran the import, it failed, the engine floor guarantees this fails for most users.
- **Could author immediately refute?** NO — they'd have to either commit to a fix (build step, loader, engines bump, or plain-JS shim), or admit the spike fails.
- **Flaw or preference?** FLAW — the T4 acceptance test as written will fail on Day 1.
- **Fix (pick one, commit to it in T4):**
  - **(A) Plain-JS shim file.** Create `bin/runner-helpers.mjs` (or similar) that re-exports the bits the runner needs in plain JavaScript. The plan already has T4 + T5; add T4a (or fold into T4 acceptance) to create this shim with the imports rewritten. Pro: works on any Node 18+. Con: requires duplicating types if the runner wants types.
  - **(B) Bump `engines.node` to `>=22.6.0` and import `../helpers.ts` with `--experimental-strip-types`.** Pro: single source of truth. Con: excludes Node 18/20/21 users; might break the Pi extension's own engine floor.
  - **(C) Build step that emits `helpers.js`.** Add a `tsconfig.build.json` with `noEmit: false` and a `prepublishOnly` script. Con: violates "no new build step" and "no new runtime deps" constraints.
  - **My recommendation:** **(A) plain-JS shim.** It's the smallest change, the most portable, and matches the spec's "no new runtime deps" constraint. The runner does NOT need the full `startSubagentJob` — only its `ctx.spawn` callback, which can be a thin wrapper that calls into a minimal shim. **Alternatively, the spec author can be explicit that v1's runner is a no-op for `ctx.spawn` and reports `error: "subagent_unavailable"`** (which is consistent with the spec's "trust model is user-authored scripts only" but breaks the "the runner reuses `startSubagentJob`" claim from spec G4).

---

## Major Findings (causes significant rework)

### 1. **Spec §3.3 still shows the dropped `pi-subagentura` placeholder bin**

- **Evidence:** `plans/spec-workflow-B-sidecar.md` lines 67-73 show the bin field as:
  ```json
  "bin": {
    "pi-subagentura": "bin/cli-placeholder.mjs",
    "pi-workflow-runner": "bin/pi-workflow-runner.mjs"
  }
  ```
  But Q6 in the plan correctly says "drop the `pi-subagentura` placeholder" because (a) the file doesn't exist and (b) `npm install` of a fresh checkout would fail. The plan drops it. **The spec is now inconsistent with the plan.** An implementer who reads the spec will copy both bin entries into the PR.
- **Confidence:** HIGH.
- **Could author immediately refute?** YES — they can fix the spec in the same PR. Move to MAJOR rather than CRITICAL.
- **Flaw or preference?** FLAW (spec/plan drift; will cause a Day-1 rebuild).
- **Fix:** Update spec §3.3 to drop the `pi-subagentura` line. Or have the planner re-insert a real `bin/pi-subagentura.mjs` (a no-op or version-flag CLI) — but Q6's choice is the cleaner answer.

### 2. **TUI widget coexistence with existing `subagentura-activity` widget is unspecified**

- **Evidence:** The existing `subagentura-activity` widget is set at `subagent.ts:590` with `placement: "belowEditor"`. The plan introduces a second widget key `subagentura-workflow-activity` (Q8). Both call `ui.setWidget(key, rows, opts)`. T5 mirrors "the same shape" at line 590-594. T6 calls `host.getActivityRows()` to feed it. But:
  - Two `ui.setWidget` calls with different keys and the same `placement: "belowEditor"` — is the second one a second widget, a replacement, or do they stack?
  - The spec is silent on the placement of the workflow widget relative to the activity widget.
  - The TUI may not even support two same-placement widgets.
- **Confidence:** MEDIUM — depends on the TUI's actual behavior, which I haven't tested.
- **Could author immediately refute?** PARTIALLY — they can argue "TUI stacks widgets" without verifying. But the plan should test this.
- **Flaw or preference?** FLAW — visual UX will be wrong if the two widgets don't compose.
- **Fix:** T13 test 11 should add an assertion that both widget keys are present after the runner is running (i.e., the existing widget is not overwritten). If the TUI doesn't support two same-placement widgets, switch the workflow widget's placement to a different anchor or merge into the existing widget (Q8 Option B).

### 3. **No secret redaction in the artifact dir**

- **Evidence:** The runner writes `events.ndjson` to `~/.pi/agent/sessions/subagentura/workflows/<id>/` (per T4 §3.5 / spec §4). If a workflow script calls `ctx.log({ apiKey: process.env.OPENAI_API_KEY })` (or, more subtly, an LLM in a sub-agent emits a token in a tool result that gets logged), the secret lands on disk unredacted. The artifact dir persists for 7 days (R6 default). The plan has no redaction layer. R11 is the "trust model is user-authored scripts only" — true, but a user who runs a community workflow on a shared machine is exposed.
- **Confidence:** MEDIUM — depends on threat model. The plan's stated trust model is "user-authored scripts only," so the bar for redaction is low but not zero.
- **Could author immediately refute?** YES — "trust model is user-authored, R11 documents the threat." Move to Open Question.
- **Flaw or preference?** PREFERENCE (for this trust model). **But** the plan should at least *mention* the threat so the README can warn users.
- **Fix:** Add one paragraph to the README's "Workflows" section: "Workflow scripts have full filesystem access; secrets printed to `ctx.log` land in `events.ndjson` unredacted. Don't run untrusted scripts on shared machines."

### 4. **`engines.node: ">=18.0.0"` is incompatible with the plan's import strategy**

- **Evidence:** Even if CRITICAL-1 is fixed via option (A) (plain-JS shim), the plan's spec §11 row 17 (line endings / NDJSON) is fine on Node 18+. But the spec §5.1 says the bin is `.mjs` "so it runs without a build step." On Node 18/20/21, the only way for the bin to import a `.ts` file is via a build step or a custom loader. If the chosen fix is (B) type-stripping, the engine floor must be `>=22.6.0`. The plan does not call this out.
- **Confidence:** MEDIUM (only matters if the fix is (B) instead of (A)).
- **Could author immediately refute?** YES — they can pick (A) and the floor stays at 18.
- **Flaw or preference?** FLAW if fix is (B); PREFERENCE if fix is (A).
- **Fix:** Tied to CRITICAL-1 fix. If (A), no change. If (B), bump `engines.node`.

---

## Minor Findings (suboptimal but functional)

### 1. **T15 example-usage signature drift** — Architect caught this (MINOR-NEW-1). Carry as v2.1 polish.

### 2. **T15 LOC accounting ambiguity** — Architect caught this (MINOR-NEW-2). The +30 LOC figure is `subagent.ts` only; `artifact-walker.ts` is a separate ~50 LOC new file. Worth a one-sentence clarification.

### 3. **`subagent.ts:2235` claim is slightly off** — file is 2236 lines; line 2236 is the separate `export { interactiveSubagentRegistry } from "./interactive-tmux";`. The plan's "re-exports block at `:2220-2235`" is correct for the helpers re-export but imprecise for "the file ends here." Implementation will hit this.

### 4. **No post-implementation test count projection** — plan starts at 196 tests, adds ~70 unit + 12 integration = ~278. Worth stating the final expected count for the PR review.

### 5. **NDJSON 64 KB cap (R5) silently downgrades LLM visibility** — large `ctx.log` payloads go to the artifact dir, not the parent's stream. The LLM only sees the workflow's final return value (spec §3.4); this is by design but should be explicit in the protocol doc.

### 6. **The `bin` field exposes `pi-workflow-runner` as a top-level command** — any user with `$PATH` access can run `pi-workflow-runner --help` (or worse, `pi-workflow-runner --stdio` and inject NDJSON). The plan describes the protocol but not the threat model. R9 covers "spawn blocked," not "bin manually invoked." The bin should refuse `--stdio` without a parent-PI environment fingerprint (or, simpler: only run when invoked with a specific `--parent-pid` flag that the parent always passes).

### 7. **Spec §3.3 example `bin` is also out of date in another way** — it has `"pi-subagentura": "bin/cli-placeholder.mjs"` (the dropped placeholder), and the spec is from 2026-06-08. The plan author updated Q6 but didn't propagate back to the spec text.

### 8. **The plan's T1 `concurrency: 0` and `maxDurationMs: 0` rejection (Q9)** is a sensible addition but the rejection logic should be symmetric with the existing sub-agent `maxDurationMs` semantics. The plan should check that the parent-side `run_workflow` tool definition also rejects these (not just the wire protocol).

### 9. **The `bin/pi-workflow-runner.mjs` shebang/argv parsing** — T4 says ~20 LOC for shebang + bootstrap. Node's `#!/usr/bin/env node` shebang works on POSIX but on Windows requires npm's `.cmd` shim. The shim is auto-generated by npm from the `bin` field. No issue, but worth verifying in the T13 step-10 smoke on Windows.

### 10. **The plan's "long-path" `\\?\` prefix** — spec §11 row 12. The implementation says `longPath(p) = process.platform === "win32" && !p.startsWith("\\\\?\\") ? "\\\\?\\" + p : p`. But `path.join` and `path.resolve` strip the `\\?\` prefix in some Node versions (Node 22.x had a regression on this). Worth a unit test in `artifact-walker.test.ts` or similar.

---

## What's Missing (gaps, unhandled edge cases, unstated assumptions)

### Integration / operational gaps the plan under-counts

- **Pre-mortem 8 (NEW):** The runner's first `run_workflow` call has cold-start latency (spawn + ESM imports + module init). The plan doesn't measure or document this. If it's 500ms-1s, the LLM's tool call is slow on first use. Mitigation: lazy-import the heavy `helpers.ts` symbols; document the cold-start cost.
- **Pre-mortem 9 (NEW):** A workflow script from a shared git repo with CRLF line endings runs on Linux. The script's `default` export signature is JS, not NDJSON — line endings don't matter. But the *workflow's own* `ctx.log(...)` calls JSON-serialize, so NDJSON is fine. **OK, not actually a problem; the spec §11 row 12 covers this.** Removed.
- **Pre-mortem 10 (NEW):** A user with `ignore-scripts=true` in their `.npmrc` (a common security setting) installs `pi-subagentura`. The package's `package.json` has no install scripts, so this is fine. But if any future PR adds a `postinstall` hook for codegen, that user breaks. **OK, not a v1 problem; flagged for v2.**
- **Pre-mortem 11 (NEW):** The runner's 30s `ping`/`pong` health check sends one extra NDJSON message per cycle. If the runner is mid-workflow and the parent's 30s timer fires, the parent's `readline` parser sees `{type:"ping"}` then `{type:"pong"}` interleaved with the workflow's events. The plan's `Map<workflowId, ...>` routing should handle this (pings are not workflow-scoped). Worth a unit test: "ping/pong while a workflow is in flight does not corrupt the routing."
- **Pre-mortem 12 (NEW):** 100+ concurrent workflows → cap of 4 → 96 queued. The plan has no UX for the queue. The 5th-100th `run_workflow` tool calls block in the parent's event loop, which blocks the LLM's turn. Mitigation: the tool should return `async: true` semantics when the queue is full (i.e., return a `jobId` and the user can poll). The spec's Q4 says no `async: true` in v1, so this is a known v1 limitation, but the plan should at least document the queue depth as an error message.

### Unstated assumptions (implicit, not enumerated in §Principles)

- **Implicit A1:** The runner's `cwd` is the parent's `cwd`. Spec §11 row 11 says "always set `cwd` explicitly." T5 should be explicit about this.
- **Implicit A2:** The runner inherits the parent's `NODE_PATH` / `node_modules` resolution. Workflow scripts can `import "lodash"` and resolve from the parent's `node_modules`. The plan doesn't say this; it should.
- **Implicit A3:** The user's `pi install npm:pi-subagentura` puts the bin on `$PATH`. This is the case if the user does a global install; for local installs (the common case), the bin is in `node_modules/.bin/`. The R13 mitigation (`commandExistsSync` first, fallback to `require.resolve`) is correct but the parent's `process.env.PATH` may not include `node_modules/.bin/` for local installs. The plan should also fall back to `path.join(require.resolve("pi-subagentura/package.json"), "../.bin", "pi-workflow-runner")` (or similar).
- **Implicit A4:** The runner does not need to load the user's `~/.pi/config.yaml` or similar Pi-level config. It only needs `@earendil-works/pi-coding-agent` (a peer dep) to create an `AuthStorage` and `ModelRegistry`. If those imports trigger a config load, the runner might fail. Mitigation: pass `defaultModel` and `parentModelRegistry` in the `start` message (already in Q10 as a v2 follow-up — fine for v1).
- **Implicit A5:** The runner can write to the parent's `~/.pi/agent/sessions/subagentura/workflows/` dir. If the parent is running as a different user (e.g., a system service), the runner (also a child of the same process) inherits the same user. OK.

### Misc gaps

- **The plan does not discuss the runner's CPU/memory budget.** A misbehaving workflow with `while(true){}` blocks the runner's event loop but doesn't OOM. The plan's 10-min `maxDurationMs` cap is the only backstop. Worth a sentence in the protocol doc.
- **The plan does not discuss the runner's disk budget per workflow.** The artifact dir grows unbounded within the 7-day TTL. A workflow that emits 1 GB of `ctx.log` to the artifact dir consumes 1 GB of disk. The 64 KB NDJSON cap protects the *pipe* but not the *disk*. Mitigation: cap each `ctx.log` payload at 64 KB before writing to the artifact dir (or document the cap).
- **The plan's R11 "sandbox escape" risk is "trust model is user-authored scripts only."** This is fine for v1 but the protocol doc should explicitly say "do not run untrusted workflows on machines with access to secrets." (Already in Major-3 fix above.)

---

## Multi-Perspective Notes (Phase 3)

### Executor perspective: "Can the dev actually do each step with only what's written here?"

**Mostly yes.** Each task has file paths, key exports, LOC estimates, and acceptance criteria that are boolean-testable. The implementer can:
- T1: write `workflow-runner-protocol.ts` with the type union and `validateMessage`. ✓
- T2: write `workflow-allowlist.ts` mirroring Plan A. ✓
- T3: write `workflow.ts` with the combinators. ✓
- T4: write `bin/pi-workflow-runner.mjs`. **BLOCKED by CRITICAL-1.** The import path doesn't work.
- T5: write `workflow-runner-host.ts`. ✓ (after CRITICAL-1 is fixed)
- T6: insert 4 new `registerTool` calls at the right line. ✓
- T7: update `package.json`. ✓ (after spec §3.3 is fixed)
- T8: write `demos/audit-xss.mjs`. ✓
- T9: write docs. ✓
- T10-T12: write unit tests. ✓
- T13: write integration test. ✓
- T14: modify CI. ✓
- T15: write `artifact-walker.ts` and extend `prune_subagent_jobs`. ✓ (with the MINOR-NEW-1 signature fix)

The implementer will hit **two blockers** on Day 1: (a) the T4 import failure, (b) the spec §3.3 bin placeholder. Both are real; the rest is mechanical.

### Stakeholder perspective: "Does this plan solve the stated problem?"

**Yes, for the stated problem.** The spec's G1-G9, N1-N6 are all addressed:
- G1 (new bin): T4 + T7. ✓
- G2 (new tool): T6. ✓
- G3 (NDJSON protocol): T1 + T3 (banners) + T9. ✓
- G4 (reuse `startSubagentJob`): T4. **Partial** — see CRITICAL-1.
- G5 (artifact-dir rehydration): T5 + T13 test 11/12. ✓
- G6 (one runner per session): T5 + P3 + Q1. ✓
- G8 (demo + bin shipped): T7 + T8. ✓
- G9 (cross-platform from day one): T14 + R10 + §11 matrix. ✓

The stakeholder cares most about "does my long-running workflow outlive the spawning turn and survive a clean parent restart?" The answer is **yes** for G5 (with T13 tests 11/12 as the proof) and **no** for G6 (`kill -9` of the parent kills the runner) — but G6 was never in v1, per P2.

### Skeptic perspective: "What's the strongest argument against this approach?"

**The strongest argument against Plan B is the runner-starvation hazard (R14 / pre-mortem #4).** One misbehaving workflow with `setInterval(() => {}, 1)` blocks the shared event loop and starves the other three in-flight workflows. The v1 cap of 4 caps the blast radius but does not eliminate it. Per-workflow spawn (P3 v2 follow-up) is the only fix.

A second strong argument: **the v1 design ships three new failure modes (R1 runner-died, R2 stdio backpressure, R3 protocol drift) without a kill-switch fallback.** If a user hits R2 (10 MB of log output filling the pipe buffer), the only mitigation is "reduce per-workflow fanout." The plan offers no `--runner-fallback-to-in-process` flag. The v2 follow-up is fine, but the v1 commitment to a single spawn strategy is a real operational cost.

A third argument: **the v1 ships a new npm bin and a new protocol, but the parent-side fallback (Plan A in-process `node:vm`) is not even an option.** A user with `child_process.spawn` blocked (R9) cannot run workflows at all; Plan A would have given them an in-process fallback. The R9 mitigation ("graceful `runner_unavailable`") is honest but cold comfort.

These are not blockers — the user's spec explicitly chose Plan B — but they're real costs the plan should own in the README's "Known limitations" section.

---

## Pre-Mortem (additional, beyond the plan's 7)

The plan has 7 pre-mortems. Adding 3-5 more from the Critic's view:

- **Pre-mortem 8 (CRITICAL):** The runner's `import { startSubagentJob } from "../helpers.js"` fails with `ERR_MODULE_NOT_FOUND` because the package only ships `helpers.ts`. The plan's T4 spike would catch this on Day 1 but the plan doesn't propose a fix. **→ See CRITICAL-1 fix (A/B/C).**
- **Pre-mortem 9 (operational):** The first `run_workflow` call in a Pi session has cold-start latency. The runner is spawned, the bin's `.mjs` is loaded, the imports resolve, the `WorkflowRegistry` initializes. If 500ms-1s, the LLM's tool call is slow. **→ Mitigation: lazy-import heavy modules in the runner; document the cold-start cost in the README.**
- **Pre-mortem 10 (integration):** A workflow calls `ctx.spawn` (which calls `startSubagentJob`) with a model name that doesn't exist in the runner's `ModelRegistry`. The runner has a different `cwd` and a different `process.env` from the parent. The sub-agent fails to find the model. **→ Already in plan's pre-mortem #7; just confirming.**
- **Pre-mortem 11 (operational):** 100+ concurrent `run_workflow` calls in a single turn. Cap of 4 means 96 are queued. The parent's event loop blocks for 96 spawns. **→ Mitigation: document the queue depth; or return `async: true` semantics when queue is full (contradicts Q4 but solves the problem).**
- **Pre-mortem 12 (security):** A user with `child_process.spawn` available runs `pi-workflow-runner --stdio` from a terminal. They can inject arbitrary NDJSON and have the runner execute a workflow. The runner doesn't authenticate the parent. **→ Mitigation: require a `--parent-pid <pid>` flag and verify the parent is alive via `process.kill(parentPid, 0)` — but wait, §11 row 8 bans `process.kill(0)`. Use `ps -p <pid>` or skip the check; the protocol-level harm is limited to the user's own machine.**

---

## Dependency Audit (Phase 3)

- **T5 (host) — T15 (artifact-walker) — T13 (integration test):** Sequenced correctly. T5 needs `artifact-walker.ts`'s `walkArtifactDirs` for rehydration. T15 writes `artifact-walker.ts` after T6. T13 runs after T4, T5, T6, T7, T8, AND `artifact-walker.ts`. The dependency graph in the plan (lines 122-140) is correct.
- **T4 (runner) — T5 (host):** T5 imports `WorkflowRunnerHost` (well, it defines it) and T4 imports `startSubagentJob`. T5 needs T4's CLI shape (the `--stdio` flag) to be defined first. The plan's "Convergence" step (line 145) puts T4 and T5 in the same group. OK.
- **T7 (package.json) — T6 (subagent.ts wire):** T6 imports the bin, so T7 should be done first or concurrently. The plan correctly puts T7 in parallel group A.
- **T14 (CI matrix) — T13 (integration test):** T14 is the test runner for T13. T14 must be last. The plan correctly sequences this.
- **Missing dependency:** T6's `import { WorkflowRunnerHost, validateMessage }` (line 102) is from `workflow-runner-host.ts` and `workflow-runner-protocol.ts`. The plan does not explicitly call out that T6's import statements must be added in the right order (top of file, after the existing imports). Minor — the implementer will figure it out.

No circular deps. No missing handoffs. **PASS.**

---

## Ambiguity Scan (Phase 3)

- **T6 says "imports `WorkflowRunnerHost` and `validateMessage`"** — from where? The plan does not show the import statement. An implementer can guess `from "./workflow-runner-host"` and `from "./workflow-runner-protocol"`. **MINOR ambiguity.** The plan should show the exact import statement.
- **T13 says "12 integration tests"** — the plan enumerates all 12 in §Expanded Test Plan. ✓ Clear.
- **T1 says "validates every `ParentToRunner` and `RunnerToParent` message type"** — the plan shows the type union in spec §5.1. ✓ Clear.
- **T4 says "stderr-only logging honoring `SUBAGENT_DEBUG_LOG_DIR`"** — this mirrors `helpers.ts:32-49`. ✓ Clear.
- **T15 says "`walkArtifactDirs(rootDir, predicate)`"** — the function signature is explicit. ✓ Clear.
- **The plan's R10 "lint scope"** says "ESLint `overrides`" but no ESLint config exists. The plan acknowledges this. The implementer must choose flat config vs legacy based on the day-1 spike. **Minor ambiguity; acknowledged.**

**No blocking ambiguities.** The implementer can proceed without asking questions, modulo CRITICAL-1.

---

## Feasibility Check (Phase 3)

For most tasks: yes, the implementer has everything. **For T4: no** — the import mechanism is unverified. The plan's "Day-1 spike validates" framing is honest but defers a real decision.

---

## Rollback Analysis (Phase 3)

- **If T4 fails mid-execution (e.g., the T4 import spike fails):** the implementer discovers this on Day 1. The fix is to add a plain-JS shim (CRITICAL-1 option A) or bump engines.node (option B). Either is a 1-2 day detour. Not catastrophic, but the plan should pre-commit to a fix to avoid mid-flight scope creep.
- **If T6 fails (e.g., the 4 new tools break the existing 196 tests):** `git checkout` the T6 commit, fix, retry. Standard. The plan's T6 acceptance (a) — "all existing 196 tests unchanged" — is a good regression net.
- **If T13 fails on Windows (the cross-platform gate):** the plan blocks the release. The implementer triages Windows-specific failures. The §11 matrix is the contract.
- **If the published tarball is broken (e.g., missing `bin/` or wrong `files`):** `npm unpublish` within 72 hours, publish a patch. The plan's T7 acceptance (a) and T13 step-10 are the catch.

**Rollback is feasible. No showstoppers.**

---

## Devil's Advocate (Phase 3)

**The strongest argument AGAINST this approach:**

> "Plan B is over-engineered for a v1. The user's stated requirement is 'cross-platform workflows that survive a clean parent restart.' Plan A (in-process `node:vm`) achieves 80% of this at 50% of the cost. Plan B introduces a new bin, a new protocol, three new failure modes (R1/R2/R3), a shared-event-loop starvation hazard, and a transitive dependency on the Pi runtime via `helpers.ts`. The cross-platform requirement is real but can be deferred to v2 once we know what users actually do with workflows. The v1 should ship Plan A, learn, then invest in Plan B when the use cases justify it."

The plan's R3 / spec §12 explicitly rebuts this: "Pick Plan B if you already have use cases for 'long-running workflow that should outlive the spawning turn' or 'workflows that should survive a parent Pi restart.' If you don't have those use cases yet, ship Plan A first, learn what users do, then build B on top."

The rebut is honest. The plan author is not over-engineering — they're executing the user's explicit direction. The critic accepts this.

---

## Phase 4.5 — Self-Audit of Findings

| # | Finding | Confidence | Refutable? | Flaw or Preference? |
|---|---------|------------|------------|---------------------|
| CRITICAL-1 | R12 import not resolved | HIGH (I tested) | NO (the test will fail) | FLAW |
| MAJOR-1 | Spec §3.3 placeholder bin drift | HIGH | YES (fix spec) | FLAW |
| MAJOR-2 | TUI widget coexistence | MEDIUM | PARTIALLY | FLAW (UX) |
| MAJOR-3 | No secret redaction | MEDIUM | YES (R11 trust model) | PREFERENCE |
| MAJOR-4 | Engine floor vs import strategy | MEDIUM | YES (if fix is A) | DEPENDS |
| MINOR-1..10 | (various) | HIGH/MEDIUM | MOSTLY YES | MOSTLY POLISH |

**No CRITICAL or MAJOR finding is "immediately refutable."** They all require a real response.

---

## Verdict Justification

**Why REVISE:**

The plan has a real CRITICAL flaw that the v2 Architect missed: the T4 import mechanism doesn't work. The T4 acceptance test will fail on Day 1. Without a pre-committed fix, the implementer will discover this and have to redesign mid-flight. The cost of a Day-1 redesign is 1-2 days, plus a possible scope creep into "should we just do Plan A?" This is the kind of "false APPROVE costs 10-100x more" scenario the role prompt warns about.

**What would need to change for an upgrade to ACCEPT-WITH-RESERVATIONS:**

1. **CRITICAL-1 resolved** by committing to one of (A) plain-JS shim, (B) engines bump + type-stripping, or (C) build step. Document the choice in T4 acceptance (b) and add an explicit task for the shim/bump/build.
2. **MAJOR-1 resolved** by updating spec §3.3 to drop the `pi-subagentura` placeholder bin (or replacing it with a real bin).
3. **MAJOR-2 clarified** by adding a T13 sub-test that the two widget keys coexist, or merging the workflow widget into the existing activity widget per Q8 Option B.

Once these are addressed, the plan is ACCEPT. The 4 MINORs and the Open Questions are v2.1 polish.

---

## Open Questions (unscored)

These are speculative follow-ups that the plan doesn't need to address but are worth tracking:

- **Q-A:** Should the runner be a separate npm package (`pi-subagentura-runner`) so its deps don't pollute the parent's? The plan keeps it in the same package for install simplicity. A v3 split could be cleaner.
- **Q-B:** Should the protocol be upgraded to length-prefixed framing (e.g., binary length + JSON payload) instead of NDJSON? NDJSON is line-oriented and has the 64 KB cap. Length-prefixed would remove the cap. Spec §11 row 12 says LF is fine; v2 could revisit.
- **Q-C:** The TUI widget is rendered on every progress event. For 100 events/sec, this thrashes the TUI. Should the widget throttle to 1 Hz? The plan doesn't say.
- **Q-D:** The `walkArtifactDirs` helper is reusable. Should it be in a separate `artifact-utils.ts` (more focused naming) or stay in `artifact-walker.ts`? MINOR — the current name is fine.
- **Q-E:** The 30s `ping`/`pong` interval is hardcoded. Should it be a constructor option? MINOR — fixed interval is fine for v1.

---

## Summary

- **Verdict:** REVISE
- **CRITICAL:** 1 (R12 import mechanism)
- **MAJOR:** 4 (spec drift, TUI widget, secret redaction, engine floor)
- **MINOR:** 10 (various; most are carry-forwards from the Architect's MINOR-NEW-1/2 plus a few additions)
- **Open Questions:** 5

**Single most important thing an implementer should know before starting:**

**The T4 acceptance (b) "no ERR_MODULE_NOT_FOUND" test will fail with `import { startSubagentJob } from "../helpers.js"` because the package only ships `helpers.ts`. The plan needs to commit to one of: (A) a plain-JS shim file the runner imports, (B) bump `engines.node` to `>=22.6.0` and use `--experimental-strip-types`, or (C) a build step that emits `helpers.js`. Without this decision, T4 is un-implementable as written.** This is the blocker.

---

## RALPLAN Summary Row

- **Principle/Option Consistency:** PASS — P1-P5 are all respected; P3 owns the runner-starvation hazard; P2 correctly reframes G5 vs G6.
- **Alternatives Depth:** PASS — Plan A and Plan C are rejected with concrete reasons (no G5, weaker portability); Plan B's two unique properties (cross-platform + artifact-dir rehydration) are tied to the user's hard requirements.
- **Risk/Verification Rigor:** FAIL — R12 is "high/high" in the risk register but the mitigation is a hand-wave that I've shown to be false. R10 lint rule is well-scoped. R6/R11/R13 are adequately mitigated. The 7 pre-mortems + 5 I add cover the major failure modes.
- **Deliberate Additions (if required):** PASS — pre-mortem count is 7 (≥3 required); expanded test plan has 74 unit + 12 integration + 3 E2E + 1 observability; principles are 5 (within 3-5 range); 3 top decision drivers; 3 viable options (≥2 required).

**Overall:** 3 PASS, 1 FAIL. The FAIL is the R12 issue. Address CRITICAL-1 and the plan is ready.

---

*Critic review complete. Hand off to Planner for revision, then Architect re-review (SEQUENTIAL), then Critic re-evaluate.*
