# Plan Draft — `ralplan-consensus` Workflow (Iteration 3)

> Iteration 3 — addresses both NEW MAJORs introduced by iteration 2
> (see `architect_review.md`):
> - MAJOR #1 (off-by-one): track `iterations` separately from the loop
>   counter so `result.iterations === 1` after dual-approve on the first
>   iteration (AC-4), and `err.iterations === maxIterations` on exhaustion
>   (AC-5).
> - MAJOR #2 (feedback length): skip `feedback.push` for the final
>   iteration because there is no next Planner to consume it; with
>   `maxIterations = 5` this produces `feedback.length === 4` (option a,
>   rationale: "feedback for iteration N feeds iteration N+1").
> MINORs (IR-2 ownership, AC-6 case-folding, analystPrompt template)
> addressed inline — see script body comments, R-6 row, and T1 step 5.
> RALPLAN-DR Summary block stays first per protocol §RALPLAN-DR. Plan
> and ADR follow.

---

## RALPLAN-DR Summary

**Mode:** SHORT (the idea wraps an existing in-process protocol; no security, migration, production, or destructive-change signals are present in the spec)

### Principles (3–5)

- **[P1] Re-host, don't reinvent.** The RALPLAN consensus protocol is already implemented in `pi-ralplan/pi/` (Planner/Architect/Critic role prompts at `pi-ralplan/pi/skills/ralplan/prompts/{planner,architect,critic}.md`). The new artifact is a *mechanical* re-hosting on `pi-subagentura`'s `workflow` primitive (`src/workflow.ts:519-545`).
- **[P2] vm-sandbox honesty.** Workflow scripts run in `vm.runInNewContext` (`src/workflow.ts:798`); non-deterministic `Date.now`/`Math.random`/argless `new Date` throw at call time (`src/workflow.ts:248-282`). All file I/O must be delegated to spawned sub-agents, never performed in-script.
- **[P3] Sequential phases, never parallel.** Per `pi-ralplan/pi/skills/ralplan/SKILL.md:43` and `references/consensus-workflow.md:37-44`, Architect must complete before Critic is invoked. `agent()` is awaited in series; `parallel()` is not used for the Planner→Architect→Critic chain.
- **[P4] Single source of truth, multiple delivery channels.** One self-contained script string lives at `src/workflows/ralplan-consensus.js` in this repo. The same string is (a) imported as a `const` in `src/workflow-ralplan.test.ts` and (b) persisted at runtime via `save_workflow("ralplan-consensus", text)` to `~/.pi-subagentura/workflows/ralplan-consensus.js` (the path produced by `src/workflow.ts:442`).
- **[P5] Verdict parsing is conservative and self-healing.** Architect regex `/i` flag with whitespace tolerance (`ARCH_VERDICT_RE`); Critic regex with 4-way enum. Unparseable → `"UNPARSED"` → treated as iterate (`src/workflow.ts:248` is a good prior art for the strict-but-soft philosophy).

### Top 3 Decision Drivers

1. **The `workflow` tool's API shape is fixed** by `src/workflow.ts:1087-1252` — the script must use `export const meta = {...}` literal, and `agent/parallel/pipeline/phase/log/workflow/args/budget` are the only injected globals. Anything else throws at parse or runtime.
2. **Role prompts are the protocol's contract** — re-encoding them as strings (per OQ-2 resolution in `plans/spec-2026-06-18.md:212`) means we must keep them in sync with `pi-ralplan/pi/skills/ralplan/prompts/*.md`. A header comment with last-synced date + resync procedure is the lightweight mitigation for R-1.
3. **DELIBERATE mode is sticky and auto-detected from `args.idea`** — the substring/word-boundary table at `pi-ralplan/pi/extensions/ralplan/prompts.ts:338-366` is the canonical source (note: `rm` is word-boundary only, bare `auth` is intentionally excluded). **The script pins to the spec §8 list (23 entries) as the contract for this iteration; drift with the 24-entry source is logged as F-6 (see ADR Follow-ups).**

### Viable Options (≥2 required)

**Option A: Self-contained script + in-repo fixture (RECOMMENDED)**
- Pros: One source of truth (`src/workflows/ralplan-consensus.js`); test imports it as a string and runs through `runWorkflow` with mocked `runAgent`; trivially diffable on PR; honors spec §12 step 1 ("Write script text").
- Cons: Two deliveries (repo file + persisted user-scope file at `~/.pi-subagentura/workflows/`) must be kept in lockstep; this is the same drift problem the spec already accepts (OQ-9, R-1, R-9).

**Option B: Script lives only inside a test fixture string**
- Pros: No repo file to maintain; the "delivered" artifact is whatever the parent agent's `save_workflow` call passes. Drift between repo and user-scope disappears entirely (one fewer artifact to keep in lockstep).
- Cons: No reviewer can read the script outside the test file; `git diff` of protocol changes becomes noisy; spec §12 step 1 explicitly recommends a `src/workflows/ralplan-consensus.js` file.

**Option B steelman (per Architect iteration 1):** The drift argument cuts both ways. (1) Option B has strictly fewer artifacts to keep in lockstep, not the same number — the R-9 mitigation is already in scope but Option A still ships one more public file than B. (2) Inlining role prompts in a test fixture where they are load-bearing for the test makes drift *louder* (broken test) rather than *quieter* (silent script diff). (3) The "read-diff reviewability" benefit is genuine but narrow — most reviewers look at the `agent()` mock fixtures anyway. Option A is still better for this repo, but the win is "protocol is a first-class file", not "one fewer thing to drift".

**Option C: Bundle the script into the npm package as a static asset**
- Pros: Version-locked with the package — reproducible across machines; `npm install pi-subagentura` ships a known-good `ralplan-consensus` for free; no user-scope drift on install/upgrade.
- Cons: Bloats the tarball for users who never invoke `ralplan-consensus`; spec §13 OQ-9 + R-9 explicitly defer this; upgrading the protocol requires a new package release rather than a parent-agent `save_workflow` call; the role-prompt drift story (R-1) is now *version-locked* — every bump of `pi-ralplan` that changes a prompt forces a `pi-subagentura` release.

**Option C invalidation rationale:** Real tradeoff is reproducibility (C) vs distribution flexibility (A/B). Option A wins because: (i) the spec already deferred C at OQ-9, so adopting C would require a planner/spec revision; (ii) parent agents who customize the script can still do so by saving a copy with the same name; (iii) the R-1 drift story is no worse under A (still one upstream source) than under C (same upstream, just versioned with the wrong package).

**Mode decision: SHORT.** No spec keywords match the DELIBERATE signal table — the spec §8 list is 22 substring signals (`security`, `credential`, `secret`, `password`, `token`, `migration`, `schema`, `database`, `production`, `destroy`, `delete`, `authentication`, `authorization`, `authorized`, `authorize`, `authorizing`, `compliance`, `PII`, `GDPR`, `HIPAA`, `public api`, `breaking change`) plus the word-boundary `rm`, for **23 entries total** (see ADR Follow-ups F-6 for the 24-entry source drift). Pre-mortem and expanded test plan are therefore not required in this draft (per `pi-ralplan/pi/skills/ralplan/SKILL.md:124-136`).

---

## Plan

**Dependency graph (textual):**

```
T1 (write script)
   ├── T2 (unit tests, imports T1 as fixture string)
   │      └── T5 (CI verification — runs T2 + typecheck + banned-token test)
   ├── T3 (save/list round-trip, exercises T1 via runWorkflow)
   │      └── T5
   └── T4 (docs + CONTRIBUTING.md resync procedure)
          └── T5
```

T1 must land first. T2, T3, T4 can be developed in parallel against T1's exported text. T5 is the merge gate.

### T1 — Create the workflow script text at `src/workflows/ralplan-consensus.js`

**Files:**
- Create: `src/workflows/ralplan-consensus.js` (the script text — a JS module exporting `default` string content of the workflow)
- Touched (existing): `package.json` `files` array — **deliberately not** extended. Per OQ-9 the script is user-scoped, not bundled (matches `package.json:27-39`).

**What goes in the script body** (the string that gets passed to `save_workflow`/`runWorkflow`):

1. `export const meta = { name: "ralplan-consensus", description: "...", phases: [{title:"Analyst"},{title:"Planner"},{title:"Architect"},{title:"Critic"}] }` — must be a pure literal or `parseWorkflow()` throws (`src/workflow.ts:166-179`).
2. Inline constants for `ARCH_VERDICT_RE = /\*\*VERDICT:\s*(APPROVE|REVISION\s+NEEDED)\*\*/i` and `CRIT_VERDICT_RE = /\*\*VERDICT:\s*(REJECT|REVISE|ACCEPT-WITH-RESERVATIONS|ACCEPT)\*\*/i` per spec §7.
3. Inline `DELIBERATE_SIGNALS` array of **exactly 22 entries** + `WORD_BOUNDARY_SIGNALS = new Set(["rm"])` + `isDeliberate(idea)` function — matching **spec §8 verbatim** (the canonical contract for this iteration). The source `pi-ralplan/pi/extensions/ralplan/prompts.ts:338-366` has 24 entries (adds `"remove"`); this drift is logged as F-6 and is out of scope for v1. Bare `"auth"` is intentionally absent from the list (it would match `"author"`/`"authentic"`).
4. `extractFeedbackSection(text, pattern, cap = 2000)` helper. **Pinned semantics** (per NFR-5 + IR-3 + iteration-2 clarification): `text` is one reviewer's full output; `pattern` is a `RegExp` (or `|`-joined string) naming the headings to extract; the function returns a single string ≤ `cap` chars (default 2000) that contains every matched section in order, joined by `\n\n`, with the tail truncated and an `[…truncated…]` marker if the combined extract exceeds `cap`. **Per-iteration total feedback ≤ 4000 chars** (Architect extract ≤ 2000 + Critic extract ≤ 2000).
5. Inline `PLANNER_PERSONA`, `ARCHITECT_PERSONA`, `CRITIC_PERSONA`, `ANALYST_PERSONA` template literals — copy of `pi-ralplan/pi/skills/ralplan/prompts/{planner,architect,critic}.md` content starting at the Markdown title header (`# Planner Role Prompt`, etc.; per iteration-2 clarification: NOT "between fence markers" — the source files have plain `# Title` headers, no code fences). Header comment records source paths + last-synced date.
6. `args` validation, run **before any `agent()` call**:
   ```
   if (!args || typeof args.idea !== "string" || args.idea.trim() === "")
     throw new Error("RalplanConsensus: args.idea is required and must be a non-empty string.");
   if (typeof args.workingDir !== "string" || args.workingDir === "")
     throw new Error("RalplanConsensus: args.workingDir is required.");
   // Banned in sandbox: `path.isAbsolute`. Use string check instead.
   const isAbs = args.workingDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.workingDir);
   if (!isAbs)
     throw new Error(`RalplanConsensus: args.workingDir must be absolute, got: ${args.workingDir}`);
   if (args.specPath != null && typeof args.specPath !== "string")
     throw new Error("RalplanConsensus: args.specPath must be a string when provided.");
   if (args.specPath != null && args.specPath === "")
     throw new Error("RalplanConsensus: args.specPath is empty.");
   ```
7. Loop body — strictly sequential:
   ```
   if (!args.specPath) { phase("Analyst-spec"); await agent(analystPrompt, { label: "ralplan-analyst-1", persona: ANALYST_PERSONA }); }
   const feedback = [];
   let architectVerdict = "UNPARSED", criticVerdict = "UNPARSED";
   let draftPath = args.workingDir + "/plans/drafts/plan_draft.md";
   const maxIterations = (typeof args.maxIterations === "number" && args.maxIterations > 0 && args.maxIterations <= 100)
     ? Math.floor(args.maxIterations)
     : 5;
   // Iteration counter is 1-based and counts completed iterations, not loop passes.
   // - Dual-approve on first try -> iterations = 1 (matches AC-4).
   // - Perpetual-reject exhausts at maxIterations; err.iterations = maxIterations
   //   (matches AC-5).
   // - feedback.push guard `iterNum < maxIterations` skips the final iteration
   //   because there is no next Planner to consume it; with maxIterations = 5
   //   this produces feedback.length = 4 (option a — iteration 3 decision;
   //   rationale: "feedback for iteration N feeds iteration N+1").
   let iterations = 0;
   for (; iterations < maxIterations; iterations++) {
   const iterNum = iterations + 1;  // human-facing 1-based label
   phase(`Iteration ${iterNum}: Planner`);
   const draft = await agent(plannerPrompt(args.idea, feedback), { label: `ralplan-planner-${iterNum}`, persona: PLANNER_PERSONA });
   if (draft == null) throw new Error(`Planner returned null at iteration ${iterNum}`);
   phase(`Iteration ${iterNum}: Architect`);
   const arch = await agent(architectPrompt(draft), { label: `ralplan-architect-${iterNum}`, persona: ARCHITECT_PERSONA });
   if (arch == null) throw new Error(`Architect returned null at iteration ${iterNum}`);
   architectVerdict = parseVerdict(arch, ARCH_VERDICT_RE) ?? "UNPARSED";
   phase(`Iteration ${iterNum}: Critic`);
   const crit = await agent(criticPrompt(draft, arch), { label: `ralplan-critic-${iterNum}`, persona: CRITIC_PERSONA });
   if (crit == null) throw new Error(`Critic returned null at iteration ${iterNum}`);
   criticVerdict = parseVerdict(crit, CRIT_VERDICT_RE) ?? "UNPARSED";
   if (architectVerdict === "APPROVE" && (criticVerdict === "ACCEPT" || criticVerdict === "ACCEPT-WITH-RESERVATIONS")) {
   iterations = iterNum;  // count this completed iteration (1-based); `break` leaves `iterations` set to the 1-based count
   break;
   }
   const archFb = extractFeedbackSection(arch, /Antithesis|Trade-off tension|Recommendations/i);
   const critFb = extractFeedbackSection(crit, /Critical Findings|Major Findings|Verdict Justification/i);
   if (iterNum < maxIterations) {
   feedback.push({ iteration: iterNum, architect: archFb, critic: critFb });
   }
   }
   if (architectVerdict !== "APPROVE" || (criticVerdict !== "ACCEPT" && criticVerdict !== "ACCEPT-WITH-RESERVATIONS")) {
   // Spec §11 AC-5 — error must expose .verdicts / .draftPath / .iterations / .feedback
   const err = new Error(`RalplanConsensus: failed to reach consensus after ${iterations} iteration(s).`);
   err.verdicts = { architect: architectVerdict, critic: criticVerdict };
   err.draftPath = draftPath;
   err.iterations = iterations;
   err.feedback = feedback;
   err.mode = mode;
   throw err;
   }
   log("PIPELINE_RALPLAN_COMPLETE");  // BEFORE return — surfaces in progress stream (per iteration-2 clarification)
   return { planPath: args.workingDir + "/plans/" + (args.planName || "plan") + ".md", planContent: "", iterations, mode, verdicts: { architect: architectVerdict, critic: criticVerdict }, feedback };
   ```
8. `mode` is computed once at script entry (`true` / `false` / auto-detect) and stays sticky across iterations (IR-6); Planner prompt is templated with `**Mode:** ${mode}` so the LLM emits the right Summary block.

**Path convention:** All paths are string-concat with `/` (spec §NFR-9, NFR-1): `args.workingDir + "/plans/drafts/plan_draft.md"`, `args.workingDir + "/plans/" + planName + ".md"`. The Critic agent is instructed (in its persona prompt) to write `<args.workingDir>/plans/<planName>.md` on `ACCEPT` and emit `PLAN_WRITTEN: <path>` as the last line; the script greps the Critic's output for the marker as a sanity check (R-8 mitigation). The Critic's file write is the only way `plans/<planName>.md` gets created (OQ-3 resolution).

**Acceptance criteria (T1):**
- [ ] `node -e 'const s=require("fs").readFileSync("src/workflows/ralplan-consensus.js","utf8"); console.log(s.includes("export const meta"))'` prints `true`.
- [ ] `vitest -t "parseWorkflow: ralplan-consensus"` (T2) must show the literal passes.
- [ ] Script body contains zero of: `Date.now(`, `Math.random(`, `new Date(`, `require(`, `process.`, `fs.`, `path.` (case-insensitive grep on the file). **Automated in T2 as a vitest test** (`bannedTokens.test.ts`) — T5 just runs `npm test`, which executes it.
- [ ] `deliberateSignals` constant in the script has **exactly 22 entries** matching spec §8 (the 22 listed above); `WORD_BOUNDARY_SIGNALS = new Set(["rm"])` contains exactly `["rm"]`. A vitest assertion pins the length and membership so silent drift fails CI.
- [ ] `ARCH_VERDICT_RE` and `CRIT_VERDICT_RE` byte-equal the spec §7 values.
- [ ] Script body is ≤ 1500 lines (the planner/architect/critic prompt pastes are the bulk; pure orchestration should be < 200 lines).

### T2 — Unit tests at `src/workflow-ralplan.test.ts`

**Files:**
- Create: `src/workflow-ralplan.test.ts` (vitest, imports `runWorkflow` and a mock `WorkflowAgentRunner` following the `ok`/`fail` pattern at `src/workflow.test.ts:22-53`).
- Create: `src/workflow-ralplan-banned-tokens.test.ts` — vitest test that reads `src/workflows/ralplan-consensus.js` as text and asserts zero matches of the banned token regex (T1's static check, automated for CI).

**Test cases (each maps to one AC in spec §11):**

| AC | Test name | What it asserts |
|----|-----------|-----------------|
| AC-1 | `"saves ralplan-consensus via saveWorkflowScript and lists it"` | After `saveWorkflowScript("ralplan-consensus", scriptText, dir)` the entry appears in `listSavedWorkflows(dir)` with the meta description; `loadWorkflowScript` round-trips byte-identical. |
| AC-2 | `"non-deliberate idea -> SHORT mode"` | `isDeliberate("wrap protocol as workflow") === false`; Planner persona string (returned by mocked `agent`) contains `**Mode:** SHORT`. |
| AC-3 | `"deliberate signals: migration|authentication|PII|schema|production|breaking change -> DELIBERATE"` | One `it` per signal — each must flip `isDeliberate` to `true`. **Plus** a parameterized loop over the remaining 16 spec §8 substring signals (excluding the 6 AC-3-explicit ones) + the `rm` word-boundary signal, so all 22+1 entries are exercised. |
| AC-3.1 | `"bare 'auth' in 'Add an author bio field' does NOT trigger DELIBERATE"` | `isDeliberate("Add an author bio field") === false`. |
| AC-4 | `"mocked dual-approve exits at iteration 1 with expected shape"` | Mocked `runAgent` returns Planner markdown + Architect `**VERDICT: APPROVE**` + Critic `**VERDICT: ACCEPT**`; assert `result.iterations === 1`, `result.verdicts.architect === "APPROVE"`, `result.verdicts.critic === "ACCEPT"`. |
| AC-5 | `"perpetual-reject exits at maxIterations with structured error exposing .verdicts/.draftPath/.iterations/.feedback"` | Mocked reviewer always emits `**VERDICT: REVISION NEEDED**`; assert `runWorkflow` rejects with an `Error` whose `.verdicts` is `{architect:"REVISION NEEDED", critic:"UNPARSED"}`, `.iterations === 5`, `.draftPath === workingDir + "/plans/drafts/plan_draft.md"`, `.feedback` is an array of length 4 (one entry per failed iteration, each `{iteration, architect, critic}`). |
| AC-6 | `"verdict regex: canonical + whitespace + case + UNPARSED fallback"` | Four sub-cases: `"**VERDICT: APPROVE**"`, `"**VERDICT:  approve  **"`, `"VERDICT: REVISION NEEDED"`, `"unparseable noise"`. Last case → `"UNPARSED"`. |
| AC-7 | `"missing args.workingDir throws before any agent() call"` | Spy on `runAgent`; call `runWorkflow(script, { runAgent, args: { idea: "x" } })`; assert throws with `/workingDir/` and `runAgent` was never called. **Plus** a sub-case `"non-absolute workingDir throws"`: `args.workingDir = "relative/path"` → throws `/absolute/`. |
| AC-8 | `"Planner returning null throws 'Planner returned null at iteration N'"` | Mocked `runAgent` returns `fail()` for the first `agent()` call; assert throws with `/Planner returned null at iteration 1/`. |
| AC-9 | `"maxIterations default is 5"` | Mocked perpetual-reject; no `args.maxIterations` passed; assert `result.iterations === 5` after loop terminates (per iteration-2 clarification: drop the `meta.phases` reference — the default comes from `args.maxIterations ?? 5` in the script body, not from `meta.phases`). |
| AC-10 | `"saved workflow invokable by name via workflow() composition"` | Mirror `src/workflow.test.ts:318-328`: pre-save the script to a tmp dir, pass `loadWorkflow` to a parent workflow that does `await workflow("ralplan-consensus", { idea: "x", workingDir: "/tmp" })`; assert parent returns the expected shape. |
| AC-11 (NEW, covers IR-8) | `"empty args.idea throws before any agent() call"` | Spy on `runAgent`; call `runWorkflow(script, { runAgent, args: { idea: "", workingDir: "/tmp" } })` and `args: { idea: "   ", workingDir: "/tmp" }`; assert throws with `/args.idea is required/` and `runAgent` was never called. |

**`extractFeedbackSection` test (R-3 mitigation):**
- `"extractFeedbackSection caps output at 2000 chars"`: synthesize a 5 KB reviewer output with 5 sections; assert return ≤ 2000 chars and contains a `…truncated…` marker.
- `"extractFeedbackSection preserves section order"`: assert extraction order matches source order even when intermediate sections are skipped.
- `"per-iteration feedback total ≤ 4000 chars"`: synthesize Architect + Critic outputs each 5 KB; assert the combined `{iteration, architect, critic}` object passed to the next Planner is ≤ 4000 chars total.

**Acceptance criteria (T2):**
- [ ] `npm test -- src/workflow-ralplan.test.ts src/workflow-ralplan-banned-tokens.test.ts` green; ≥ 14 `it()` blocks across the two files; covers all 11 ACs (AC-1..AC-11).
- [ ] No test depends on real LLM calls (mocked `runAgent` only).
- [ ] Tests run in < 2 s wall clock (mocked agents do no I/O).
- [ ] `deliberateSignals.length === 22` and `WORD_BOUNDARY_SIGNALS.has("rm") === true` are asserted directly (drift fence).
- [ ] Banned-token test (`src/workflow-ralplan-banned-tokens.test.ts`) reads the script text and asserts zero matches for `/\bDate\.now\s*\(/`, `/\bMath\.random\s*\(/`, `/\bnew\s+Date\s*\(/`, `/\brequire\s*\(/`, `/\bprocess\./`, `/\bfs\./`, `/\bpath\./`. Case-insensitive.

### T3 — `save_workflow` + `list_workflows` round-trip

**Files:**
- Touched (existing): `src/workflow.ts` — **no edits expected**; this task only verifies that the existing `saveWorkflowScript`/`listSavedWorkflows` functions (at `src/workflow.ts:453-503`) round-trip the T1 script.
- Test: extended in `src/workflow-ralplan.test.ts` under `describe("saved workflows round-trip", ...)` — three cases:
  1. `saveWorkflowScript("ralplan-consensus", scriptText, tmpDir)` then `loadWorkflowScript("ralplan-consensus", tmpDir)` returns byte-identical text.
  2. `listSavedWorkflows(tmpDir)` after the save includes `{ name: "ralplan-consensus", description: <from meta> }`.
  3. `sanitizeWorkflowName("ralplan-consensus")` does not throw and returns `"ralplan-consensus"`.

**Acceptance criteria (T3):**
- [ ] Three new `it()` blocks in T2's test file, all green.
- [ ] `npm test` shows total tests increased by 3 (or more if T2 uses different `it()` boundaries).
- [ ] No code edits in `src/workflow.ts` or `src/subagent.ts` — verified by `git diff --stat src/`.

### T4 — Documentation: resync procedure + script header

**Files:**
- Touched (existing): `src/workflows/ralplan-consensus.js` — first 30 lines become a comment block listing the four upstream role-prompt source paths and the last-synced date (`// last-synced: 2026-06-18 — see CONTRIBUTING.md "Workflow resync"`). Addresses R-1.
- Touched (existing): `CONTRIBUTING.md` — append a "Resync the `ralplan-consensus` workflow" subsection (≤ 15 lines) documenting:
  - The 4 source files in `pi-ralplan/pi/skills/ralplan/prompts/`.
  - A one-liner: `node -e 'const {saveWorkflow}=...; saveWorkflow("ralplan-consensus", require("fs").readFileSync("src/workflows/ralplan-consensus.js","utf8"))'`.
  - The check: `npm test -- src/workflow-ralplan.test.ts` must remain green after any role-prompt change.

**Acceptance criteria (T4):**
- [ ] `head -30 src/workflows/ralplan-consensus.js` shows a comment block with the 4 source paths and `last-synced:`.
- [ ] `git diff CONTRIBUTING.md` shows a new subsection under the existing "Workflow lifecycle" heading (or a new "Workflow resync" heading if the former doesn't exist).
- [ ] `grep -c "ralplan-consensus" CONTRIBUTING.md` ≥ 3 (mention + install snippet + resync procedure).

### T5 — CI verification

**Files:** none (verification only — except that `src/workflow-ralplan-banned-tokens.test.ts` from T2 is a new test file exercised here).

**Steps run from the repo root:**

1. `npm run typecheck` — must pass. The script text is a `.js` file, so typecheck only covers the TS test files (T2 + the banned-tokens test) and any touched TS files (none expected).
2. `npm test` — must pass. New `src/workflow-ralplan.test.ts` contributes ≥ 14 tests; `src/workflow-ralplan-banned-tokens.test.ts` adds the banned-token static check (per iteration-2 clarification — this is the mechanical answer to the "how is the banned-token list automated" gap).
3. `npm run format:check` — must pass. If `prettier --check src/workflows/ralplan-consensus.js` fails, run `npm run format` once and re-check (one-time, scoped to the new file).
4. `npm run pack:check` — must pass. `src/workflows/ralplan-consensus.js` is **not** in `package.json#files`, so it must not appear in the tarball; if it does, that's a spec deviation (OQ-9 deferred bundling).

**Acceptance criteria (T5):**
- [ ] All four commands exit 0.
- [ ] `npm pack --dry-run` output does NOT list `src/workflows/ralplan-consensus.js` (confirms OQ-9 deferred).
- [ ] The banned-token vitest test (`src/workflow-ralplan-banned-tokens.test.ts`) is part of the `npm test` run — verified by `npm test 2>&1 | grep -c banned-tokens` ≥ 1.
- [ ] Commit body reports: `tests added: <count>`, `mode: SHORT`, `AC covered: AC-1..AC-11`.

---

## ADR

### Decision

Encode the RALPLAN consensus planning protocol (Planner → Architect → Critic, optional Analyst-spec) as a single workflow script named `ralplan-consensus`, persisted at user scope via the existing `save_workflow` tool (`src/workflow.ts:1389-1422`) and invokable from any Pi session via `workflow("ralplan-consensus", args)`. The script text lives in-repo at `src/workflows/ralplan-consensus.js` as the single source of truth; tests and runtime share the same string. The DELIBERATE signal table in the script pins to spec §8 verbatim (22 substring + 1 word-boundary = 23 entries) for this iteration.

### Drivers

1. **Spec completeness.** The spec (`plans/spec-2026-06-18.md`) defines a fixed API surface (`RalplanArgs`/`RalplanResult` in §9), ten acceptance criteria (§11), and a non-trivial ordering invariant (Planner → Architect must be sequential, never parallel — §3 FR-3). The `workflow` primitive is the only existing tool in the codebase that can host this.
2. **Reuse over rewrite.** `src/workflow.ts:519-545` already provides `runWorkflow` with `agent/parallel/pipeline/phase/log/workflow/args/budget` injection, determinism guards, token accounting, and the saved-workflow registry. Building a parallel pipeline would duplicate all of this and split the test surface.
3. **Token economics.** Sequential phases + 5-iteration cap = at most 20 `agent()` calls (NFR-2), well under `MAX_TOTAL_AGENTS=1000` (`src/workflow.ts:49`). The in-process `startSubagentJob` backend (default per NFR-8) avoids the latency cost of tmux/zellij for a protocol that does not benefit from attachability.

### Alternatives Considered

- **A1: Build a new `ralplan` tool in `src/subagent.ts` next to the sub-agent tools.** Rejected: would split the orchestration surface; the `workflow` primitive is the right shape (script-as-data, deterministic vm sandbox, saved-workflow registry); duplicating the parsing/execution lifecycle is unjustified.
- **A2: Distribute the script via npm package `files` instead of user-scoped `save_workflow` (Option C above).** Rejected: OQ-9 explicitly defers distribution; user-scope persistence matches the spec's R-9 mitigation; bundled scripts would bloat the published tarball for users who never invoke `ralplan-consensus`. Acknowledged tradeoff: bundled = version-locked reproducibility, user-scope = distribution flexibility; spec already chose flexibility at OQ-9.
- **A3: Use `isolation: "process"` (tmux/zellij) for one or more roles.** Rejected: NFR-8 + R-9 — the protocol gains nothing from attachability; in-process is faster and avoids the `isolation_process_fallback` debug-log noise on hosts without a multiplexer.
- **A4: Implement DELIBERATE mode pre-mortem and expanded test plan in this iteration.** Rejected: spec §13 OQ-7 tri-state plus the explicit `Mode: SHORT` here; DELIBERATE pre-mortem is opt-in. The script supports the tri-state (`args.deliberate: true | false | null`); it just doesn't emit pre-mortem/test-plan blocks unless `mode === "DELIBERATE"`.
- **A5: Match the 24-entry source (`prompts.ts:338-366`) verbatim instead of spec §8's 23 entries.** Rejected for v1: would silently change the spec §11 AC-3 test list (which enumerates 6 signals from spec §8, all in both lists). Pinning to spec §8 keeps the contract stable; the 24-vs-23 drift is logged as F-6 for a future iteration.

### Why Chosen

Option A (self-contained script + in-repo fixture) over Option B (script-only-in-test-fixture) for read-diff reviewability of the role prompts, which are the load-bearing part of the protocol. User-scoped `save_workflow` over npm-bundled for the same reason OQ-9 deferred it. Spec §8 over source `prompts.ts:338-366` as the canonical signal list — the spec is the contract for this iteration; drift is logged not papered over. The script mirrors the existing signal table byte-for-byte (the spec's FR-6) and reuses the existing verdict regex from spec §7. The implementation is a thin shim — `parseWorkflow` already validates the script; `runWorkflow` already provides the lifecycle; `saveWorkflowScript` already persists.

### Consequences

**Positive:**
- Single source of truth for the protocol (`src/workflows/ralplan-consensus.js`); one file to review on PRs.
- Tests exercise the *actual* script string (no parallel fixture that can drift).
- Reuses all existing `workflow` infrastructure — no new exports, no new tools, no new dependencies.
- The 11 spec ACs map 1:1 to test cases; coverage is provable from `git grep` of the test file.
- Banned-token static check is now a vitest test (T2 + T5), not a manual grep.

**Negative:**
- The script duplicates role-prompt text from `pi-ralplan/pi/skills/ralplan/prompts/*.md` (R-1). Mitigation: header comment + resync procedure in `CONTRIBUTING.md` (T4).
- The Critic agent's file write is the only way `plans/<planName>.md` exists; the script cannot verify the write happened (NFR-1 forbids `fs` in-sandbox). Mitigation: the `PLAN_WRITTEN:` marker grep (R-8).
- The `vm` sandbox is not a security boundary (`src/workflow.ts:20-23`); an adversarial author could escape. Acceptable because the author is the trusted main agent (per `src/workflow.ts:20`).
- DELIBERATE auto-detection inlines the 22-substring signal table; if `pi-ralplan` adds a signal, the script must be re-synced manually (no live import — that would require `fs` in the sandbox). The vitest `deliberateSignals.length === 22` drift fence catches silent drift in CI.
- User-scope persistence (`save_workflow`) means the saved script does not auto-resync with `pi-ralplan` releases; F-6 (mechanical diff tool) is the mitigation and is out of scope for v1.
- **Spec-vs-source signal drift (23 vs 24 entries)** is now an explicit known issue rather than a phantom 19-entry claim. Acknowledged in F-6.

### Follow-ups

- **F-1.** When `pi-ralplan` adds or removes a DELIBERATE signal, update both `src/workflows/ralplan-consensus.js` and the AC-3 test list in `src/workflow-ralplan.test.ts`. The vitest `deliberateSignals.length === 22` fence catches silent drift in CI.
- **F-2.** If the `workflow` tool ever gains structured output capture (currently `runWorkflow` returns only the script's `return` value plus counters), expose a "machine-readable consensus summary" as a follow-up workflow — OQ-10 deferred.
- **F-3.** Add a `npm run sync:ralplan` script that diffs the four role-prompt files against the inlined constants and exits non-zero on drift. Out of scope for this iteration. **(Promoted from "out of scope" by Architect's synthesis — see ADR Alternatives A5 / Consensus Addendum.)**
- **F-4.** Track the `RALPLAN-DR Summary` block in the *plan_draft.md* (top of this file) for the next iteration's RALPLAN review: the "Viable Options" section above considers A/B/C but did not need to enumerate pre-mortem scenarios because mode is SHORT.
- **F-5.** If acceptance of this plan is reached, the next step is `node -e ... saveWorkflow("ralplan-consensus", ...)` from a parent agent — not automated in this iteration, per OQ-9.
- **F-6.** Reconcile the 23-entry spec §8 list with the 24-entry source `pi-ralplan/pi/extensions/ralplan/prompts.ts:338-366` (which includes `"remove"`). Either (a) amend spec §8 to add `"remove"` and update the AC-3 subtest list, or (b) amend `prompts.ts` to drop `"remove"`. Tracked here so it doesn't get lost — out of scope for v1.

---

## Task Breakdown (file-path index)

| Task | File | Status |
|------|------|--------|
| T1   | `src/workflows/ralplan-consensus.js` (create) | pending |
| T2a  | `src/workflow-ralplan.test.ts` (create) | pending |
| T2b  | `src/workflow-ralplan-banned-tokens.test.ts` (create) | pending |
| T3   | `src/workflow-ralplan.test.ts` (extend, same file as T2a) | pending |
| T4a  | `src/workflows/ralplan-consensus.js` (extend header, same file as T1) | pending |
| T4b  | `CONTRIBUTING.md` (append resync subsection) | pending |
| T5   | none (verification) | pending |

## Dependency Graph

```
T1 ─┬─► T2a ─┬─► T5 (CI gate)
    ├─► T2b ─┘
    ├─► T3  ─┘
    └─► T4a ─► T4b ─► T5
```

T1 is the only strict predecessor. T2a/T2b/T3/T4 are independent and may be developed in parallel. T5 is the merge gate and runs all four checks.

## Acceptance Criteria per Task

(Inline above; cross-referenced from the AC table in T2. Total ACs covered: AC-1..AC-11.)

## Risk Register (spec §10 — restated with mitigations already applied)

| ID | Risk | Mitigation in plan |
|----|------|--------------------|
| R-1 | Role prompt drift | T4 header + CONTRIBUTING resync procedure |
| R-2 | Verdict parsing fragility | AC-6 test case covers whitespace + case + UNPARSED |
| R-3 | Token exhaustion | T1 loop calls `extractFeedbackSection(text, pattern, 2000)`; per-iteration total ≤ 4000 chars (2000 per reviewer); ACs in T2 |
| R-4 | Agent `null` returns | AC-8 throws with phase + iteration |
| R-5 | vm sandbox escape | T1 acceptance: zero references to `Date.now/Math.random/new Date/require/process/fs/path.` — automated in T2b + T5 |
| R-6 | Missing `args.specPath` on disk | IR-2 — caller (parent agent) owns the disk-existence check; the script cannot check it because `fs` is banned in the `vm` sandbox (NFR-1). T1 args validation only checks type/emptiness (lines 80-91). If the caller passes a non-existent path, the Analyst agent fails to read it and the workflow surfaces that failure via the agent-null error path (NFR-3, AC-8). Covered by AC-7 derivative. |
| R-7 | MAX_TOTAL_AGENTS cap | 20 max agents; well under cap; T2 default-concurrency test |
| R-8 | Critic fails to write final plan | T1 loop greps for `PLAN_WRITTEN:` marker; surfaced in T2 error-shape test |
| R-9 | Distribution path | OQ-9: user-scoped; `package.json#files` deliberately not extended; T5 verifies |
| R-10 | Machine-readable summary | OQ-10: out of scope for v1; F-2 in follow-ups |
| R-11 (NEW) | Spec §8 vs source drift (23 vs 24 signals) | Pin to spec §8 for v1; vitest length fence catches silent drift; F-6 reconciliation logged |
| R-12 (NEW) | Non-absolute `workingDir` | T1 args validation rejects with explicit error; AC-7 sub-case tests it |
| R-13 (NEW) | Empty `args.idea` (IR-8) | T1 args validation rejects before any `agent()` call; AC-11 covers it |
| R-14 (NEW) | `PIPELINE_RALPLAN_COMPLETE` lost after return | T1 step 7 explicitly logs BEFORE `return` |
