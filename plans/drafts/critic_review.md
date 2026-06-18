# Critic Review — `ralplan-consensus` Workflow Plan (Iteration 3)

**VERDICT: ACCEPT**

## Overall Assessment

Iteration 3 mechanically and correctly resolves both MAJOR bugs from iteration 2. Hand-trace of the new loop body confirms `result.iterations === 1` on first-try dual-approve (AC-4) and `err.iterations === maxIterations` with `feedback.length === maxIterations - 1` on exhaustion (AC-5). All cited source line references in `src/workflow.ts` and `pi-ralplan/pi/extensions/ralplan/prompts.ts` verify against the actual files. Pre-existing MINORs and new MINORs are real but non-blocking. Architect's APPROVE is sound.

## Pre-commitment Predictions

Before reading in detail, I predicted the following 5 likely problem areas:

| # | Prediction | Result |
|---|------------|--------|
| 1 | The `iterations` rename would not actually fix the off-by-one (the override-on-break is a known footgun) | **Refuted.** Hand-trace AC-4: `iterations = iterNum = 1; break;` exits with `iterations === 1` because `break` skips the for-update's `iterations++`. Correct. |
| 2 | The `feedback.push` guard would be mis-keyed (e.g., comparing `iterations` instead of `iterNum`) | **Refuted.** Plan line 141 uses `iterNum < maxIterations` (1-based label vs. 1-based cap), not `iterations`. Hand-trace confirms `feedback.length === 4` at exhaustion. |
| 3 | Cited `src/workflow.ts` line numbers would drift | **Refuted.** Verified `442` (WORKFLOWS_DIR), `248-282` (makeGuardedDate/makeGuardedMath), `519-545` (runWorkflow), `798` (runInNewContext), `1087` (registerTool start), `1389-1422` (save_workflow), `166-179` (parseWorkflow validation try/catch), `453-503` (saveWorkflowScript + loadWorkflowScript + listSavedWorkflows). All exact. |
| 4 | DELIBERATE signal count mismatch would be unacknowledged or miscounted | **Refuted.** Source `prompts.ts:338-366` has 24 entries (adds `"remove"`); spec §8 has 22 substring + 1 word-boundary (`rm`) = 23 total. Plan states both counts correctly. Drift is logged as F-6 with reconciliation owner. |
| 5 | The `mode` computation step would be omitted from pseudo-code (between validation and loop) | **Confirmed.** T1 step 6 is `args` validation; T1 step 7 is the loop; T1 step 8 mentions "mode is computed once at script entry" but never shows the call. Implementer must insert `const mode = computeMode(args.deliberate, isDeliberate)`. See MINOR-1. |

## Critical Findings (blocks execution)

None.

## Major Findings (causes significant rework)

None.

## Minor Findings (suboptimal but functional)

### MINOR-1: `mode` computation is mentioned but not shown in T1 pseudo-code

**Evidence:** Plan lines 89-103 (step 6, args validation) jump directly to lines 105-157 (step 7, loop body) without a `const mode = …` declaration. Line 158 (step 8) then references `mode` as if it's already in scope: "Planner prompt is templated with `**Mode:** ${mode}`."

**Impact:** Implementer must insert the missing step. Tri-state logic (`true` → "DELIBERATE", `false` → "SHORT", `null/undefined` → `isDeliberate(args.idea)`) is straightforward but undocumented in T1.

**Fix:** Add 1-3 lines between step 6 and step 7 showing:
```js
const isDeliberate = (idea) => /* check deliberateSignals + word-boundary */;
const mode = args.deliberate === true ? "DELIBERATE"
           : args.deliberate === false ? "SHORT"
           : isDeliberate(args.idea || "") ? "DELIBERATE" : "SHORT";
```

### MINOR-2: `args.deliberate` type is not validated

**Evidence:** Plan lines 89-103 (T1 step 6) validate `args.idea`, `args.workingDir`, `args.specPath` types but not `args.deliberate`. Spec FR-1 declares `deliberate?: boolean | null`. A caller passing `deliberate: "yes"` (string) would silently fall through to auto-detect because `=== true` is false.

**Impact:** Silent fallback, not a crash. Could surprise a caller who thinks they forced SHORT but actually triggered auto-detect.

**Fix:** Add to step 6: `if (args.deliberate != null && typeof args.deliberate !== "boolean") throw new Error("RalplanConsensus: args.deliberate must be a boolean or null.");`

### MINOR-3: `args.planName` is not sanitized for path traversal

**Evidence:** Plan line 156: `return { planPath: args.workingDir + "/plans/" + (args.planName || "plan") + ".md", ... }`. No validation of `args.planName`. If `planName = "../escape"`, the Critic agent writes to `workingDir/plans/../escape.md` = `workingDir/escape.md`, escaping the `plans/` directory.

**Impact:** In the trusted-main-agent model this is acceptable (per `src/workflow.ts:20-23`). But the `save_workflow` script does sanitize workflow names via `sanitizeWorkflowName` (`src/workflow.ts:444-451`); the asymmetry is undocumented.

**Fix:** Either (a) accept the risk per the trust model and document it, or (b) reject `planName` containing `/`, `\`, `..`, or starting with `.`. Option (a) is consistent with the codebase's posture.

### MINOR-4: Analyst persona template is not drafted (IR-9)

**Evidence:** Plan T1 step 5 lists `ANALYST_PERSONA` as one of the four inline persona templates, but provides no content or template spec — only the other three have source-file references. IR-9 acknowledges this ("Synthesized Analyst persona (no source file in pi-ralplan for analyst role)").

**Impact:** Implementer must author the Analyst persona from scratch. They have the Analyst's FR (spec §2 FR-2a: "writes `plans/spec.md`") but no behavioral template. This is an ambiguity, not a blocker — the implementer can reason from the spec.

**Fix:** Either (a) provide a 5-10 line stub in T1 (e.g., "Read the idea; produce a spec covering FR/NFR/IR/AC as if for a small feature"), or (b) explicitly call out in T1 AC that "the Analyst persona string is intentionally synthesized in T1; review at PR time." Architect caught this in iter-2 review.

### MINOR-5: Spec §9 `feedback: string[]` vs plan `feedback: {iteration, architect, critic}[]` — pre-existing

**Evidence:** Plan line 156 returns `feedback` as the object array; spec line 157 declares `feedback: string[]`. Plan T2 line 196 and AC-5 row both assume the object shape. Inherited from iteration 2.

**Impact:** Test code works against the plan; spec is stale. No execution impact for v1.

**Fix:** Update spec §9 to match the plan (single-line edit). Logged by Architect as a non-blocking follow-up.

### MINOR-6: AC-6 test sub-cases lack explicit expected-outcome annotation — pre-existing

**Evidence:** Plan line 186 says "Four sub-cases: `"**VERDICT: APPROVE**"`, `"**VERDICT:  approve  **"`, `"VERDICT: REVISION NEEDED"`, `"unparseable noise"`. Last case → `"UNPARSED"`." The expected verdict for sub-cases 1-3 is left implicit.

**Impact:** Test author must derive expected outcomes. Reasonable defaults apply (1=APPROVE, 2=APPROVE, 3=UNPARSED because no `**`) but should be explicit.

**Fix:** Annotate each sub-case with `→ APPROVE`, `→ APPROVE`, `→ UNPARSED`, `→ UNPARSED`. Architect caught this in iter-2 review.

## What's Missing (gaps, unhandled edge cases, unstated assumptions)

### Gap-1: No explicit `mode` propagation to subsequent Planner iterations

The plan says "mode is computed once at script entry… stays sticky across iterations (IR-6)." The pseudo-code shows the Planner prompt is templated with `**Mode:** ${mode}` on every iteration. This works only if `mode` is computed before the loop, which it isn't shown to be (MINOR-1). The intent is clear; the gap is documentation.

### Gap-2: `extractFeedbackSection` implementation is described but not pinned

Plan T1 step 4 describes the function's contract: `(text, pattern, cap=2000) → string ≤ cap`. No implementation is provided. The implementer must write it. Behavior is constrained enough (regex match against section headings, `\n\n` join, `[…truncated…]` marker) that this is implementable, but the truncation policy (truncate the tail of the last section? truncate individual sections proportionally?) is ambiguous.

**Suggested clarification:** "If combined length > cap, take the first section in full, then prepend the next section(s) until cap is exceeded; drop remaining sections; append ` […truncated…]` to the result." Without this, two implementers may produce different truncation behavior.

### Gap-3: No explicit guidance for `args.maxIterations = 1`

Plan line 110-112 allows `maxIterations` from 1 to 100. With `maxIterations = 1`:
- Iteration 1: `iterNum = 1`, feedback skipped (1 < 1 false).
- On dual-approve: `iterations = 1`, break. Return `iterations = 1`. ✓
- On reject: loop exits (1 < 1 false). Throw with `err.iterations = 1`, `err.feedback = []`.

This is sensible behavior, but no test covers `maxIterations = 1` explicitly. Not blocking — AC-9 covers the default-5 path.

### Gap-4: `args.planName` defaults to `"plan"` but `plans/plan.md` is also the final-plan destination from spec §6 FR-2(d)

Spec FR-2(d) says "Critic → writes `plans/drafts/critic_review.md`, AND on ACCEPT verdict copies draft → `plans/<planName>.md`." So `plans/plan.md` is the conventional final plan. The default `"plan"` matches. OK.

### Gap-5: No `extractFeedbackSection` test for multi-line `Antithesis` sections with backticks/quotes

Plan T2 lines 194-196 describe three tests for `extractFeedbackSection`, but none stress the regex against Architect output that contains headings with nested markdown (backticks, fenced code blocks, etc.). The regex `/Antithesis|Trade-off tension|Recommendations/i` is line-anchored in the plan's prose but not defined as such in the test description.

## Multi-Perspective Notes

**Executor:** I have enough to start. The dependency graph (T1 → T2/T3/T4 → T5) is clean. The script body is large (~1500 lines cap, mostly inlined role prompts) but the orchestration logic is ~50 lines. The two bugs that would block me are MINOR-1 (missing `mode` step) and Gap-2 (`extractFeedbackSection` truncation policy); both are answerable in 5 minutes by reading the spec more carefully. The 17-test-file pattern in this repo is well-established; the new test files follow it.

**Stakeholder:** The plan solves the stated problem (encode RALPLAN as a workflow). The 11 ACs map 1:1 to test cases (T2 line 199), so coverage is provable from `git grep`. The success criteria are measurable: `npm test`, `npm run typecheck`, `npm run pack:check` (T5). One concern: the user-facing surface is `workflow("ralplan-consensus", args)` from a Pi session — the plan doesn't include a worked example invocation, but the spec §12 lists the install steps.

**Skeptic:** Strongest argument against: "iteration 2 had MAJOR bugs that the architect caught only by hand-tracing; iteration 3 fixes the symptoms but the same hand-tracing methodology would catch new MAJOR bugs introduced by the rename (e.g., did the rename miss any `iter` reference in helper functions like `plannerPrompt`?)" Counter: the Architect's regression table (lines 51-65) explicitly checks every reference to the loop variable in the script body. No orphan `iter` (non-`iterNum`, non-`iterations`) references. Verified.

Second skeptic: "Spec §9 declares `feedback: string[]`. The plan returns objects. This is a spec violation." Counter: pre-existing, inherited from iteration 2, mechanically small (single-line spec edit), test author has already aligned with the object shape. Not a blocker.

Third skeptic: "The plan claims mode = SHORT, but does the regex count (22 substring + 1 word-boundary = 23) match the spec §8 list? What if there's a 23rd substring I'm missing?" Counter: I independently counted 22 substring signals in spec §8 and confirmed the word-boundary entry. Drift with source (24 entries) is logged in F-6.

## Verdict Justification

This plan is ready to implement.

**What would change to REVISE:**
- A NEW MAJOR bug discovered via independent hand-trace (none found)
- A NEW CRITICAL gap like the script literally not parsing due to a `parseWorkflow` invariant violation (not the case — meta is correctly described as a pure literal)
- Line references in T1 that don't resolve (none found — all verified)

**What would change to ACCEPT-WITH-RESERVATIONS:**
- The 6 MINORs above (already MINOR, not reservations-blocking)

The Architect's APPROVE is correct. The iteration-3 fixes are mechanically sound, the line references are accurate, the alternatives analysis is thorough (3 options with steelmans + invalidation rationale), and the risk register (R-1 through R-14) is comprehensive for a SHORT-mode protocol. The plan does what it says on the tin.

## Open Questions (unscored)

These are speculative follow-ups, not findings:

1. **OQ-Critic-1:** Will `extractFeedbackSection`'s truncation behavior on multi-section Architect output (where `Antithesis` is followed by `Trade-off tension` followed by `Recommendations`) preserve section boundaries or split mid-section? Plan T1 step 4 says "single string ≤ cap chars that contains every matched section in order, joined by `\n\n`" but doesn't specify whether truncation can split a section. Test author will need to decide.

2. **OQ-Critic-2:** Is the `analystPrompt` template content something the implementer should derive from existing pi-ralplan guidance, or is fully open-ended authoring acceptable? The plan doesn't pin the template.

3. **OQ-Critic-3:** When `args.specPath` is provided but unreadable (permissions, missing on disk per IR-2), does the Analyst phase run anyway or is it skipped? Plan T1 step 7 line 106 says "if (!args.specPath) { phase('Analyst-spec'); await agent(...) }" — this skips the Analyst when specPath is truthy. But spec IR-2 says "If `args.specPath` provided but missing on disk → throw, don't silently run Analyst." So the throw is the Analyst's responsibility (the agent fails to read the file, returns null, AC-8 catches it). Plan acknowledges this in R-6. Sound but indirect.

---

## Ralplan Summary Row

- **Principle/Option Consistency:** **Pass.** 5 principles (P1-P5) are stated; each maps to specific decision drivers and chosen options. P1 (re-host) → Option A. P2 (vm-sandbox honesty) → architect verdict regex + banned-token test. P3 (sequential phases) → loop body in T1 step 7. P4 (single source of truth) → `src/workflows/ralplan-consensus.js`. P5 (conservative verdict parsing) → regex `/i` flag + UNPARSED fallback. No principle is violated by any chosen option.

- **Alternatives Depth:** **Pass.** Three options (A/B/C) presented in RALPLAN-DR Summary with pros/cons for each; Option B steelmans explicitly addressed (per Architect iteration 1); Option C invalidation rationale provided. ADR Alternatives section restates this as A1-A5. The 23-vs-24 signal drift (A5) is acknowledged as out-of-scope-for-v1 with F-6 follow-up.

- **Risk/Verification Rigor:** **Pass.** 14 risks in the risk register (R-1 through R-14). Each has a specific mitigation tied to a task (T1/T2/T4). Test coverage: 14 `it()` blocks across two test files (T2), plus the banned-token static check (T2b). The banned-token list is now automated (T2b), addressing the iteration-2 "how is this enforced" gap. Verification steps in T5 cover typecheck + test + format + pack. Acceptance criteria are concrete and testable.

- **Deliberate Additions (if required):** **N/A** — Mode is SHORT. Pre-mortem and expanded test plan are not in scope per Critic protocol for SHORT mode. (The plan does include a soft pre-mortem substitute via R-1 through R-14, but DELIBERATE-mode pre-mortem / expanded test plan gates are explicitly excluded per `pi-ralplan/pi/skills/ralplan/SKILL.md:124-136`.)

---

**VERDICT: ACCEPT**