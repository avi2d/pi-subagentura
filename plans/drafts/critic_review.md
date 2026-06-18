**VERDICT: APPROVE**

**Overall Assessment**: The revision correctly resolves the previous critical finding. `cancelInteractiveSubagentByState(state)` is a clean bypass of the registry-lookup problem, and the snapshot-before-clear pattern is sound. Bug B's fix is a targeted 4-line guard. No new issues introduced.

**Pre-commitment Predictions**: I expected the Architect to confirm the fix was correct and flag any edge cases. I found: the Architect correctly identified the issue was resolved, verified the new export has no registry dependency, and confirmed the existing test at `subagent-shutdown.test.ts:164` is unaffected. I agree with the APPROVE verdict.

**Critical Findings** (blocks execution):
None.

**Major Findings** (causes significant rework):
None.

**Minor Findings** (suboptimal but functional):
None.

**What's Missing** (gaps, unhandled edge cases, unstated assumptions):
- The plan correctly notes (line 129) that `cancelInteractiveSubagentByState` does NOT update `state.status` and documents this as intentional because "the registry is already cleared." This is correct for shutdown, but a future caller who reuses this export in a non-shutdown context might expect status to be updated. The JSDoc comment at plan lines 113-116 should explicitly note this as a pre-condition (caller must not need status bookkeeping). This is minor — the export is clearly scoped to the shutdown use case — but explicit is better than implicit.

**Multi-Perspective Notes**:
- **Executor**: The plan is fully implementable from the draft alone. The 3-section shutdown pattern (snapshot → clear → cancel) and the Bug B guard are precisely described with file:line anchors to current code. No guesswork required.
- **Stakeholder**: Bug A (duplicate notification) is fixed by eliminating the race window: clearing the registry first means any queued tick finds zero entries and returns immediately. Bug B (stale footer/widget) is fixed by excluding `exited` states from the running count. Both fixes preserve the existing shutdown test (`subagent-shutdown.test.ts:164`) which asserts only the end-state (`registry.size === 0`).
- **Skeptic**: The strongest failure mode is if `shouldNotify` at `src/subagent.ts:562` still delivers a notification for a `cancelled` event written by the EXIT trap (step 2 of `cancelInteractiveSubagentByState`'s pane kill). But `shouldNotify` at line 562 is a filter — if it returns `true` for `cancelled` events, the plan's clear-first approach doesn't prevent re-delivery of that specific event. However: the clear-first approach prevents any tick from observing the registry at all, so no events can be re-delivered for entries that no longer exist in the registry. The tick exits the for-loop immediately. This is sufficient.

**Verdict Justification**: The revision correctly implements the snapshot-before-clear pattern I required. `cancelInteractiveSubagentByState(state)` at plan lines 118-130 is a clean, registry-independent primitive — it accepts a pre-built `InteractiveSubagentState` and performs `.cancelled` write + pane kill without any `interactiveSubagentRegistry.get()`. The shutdown handler now clears the registry before the cancel loop (plan line 147 vs line 152), which is the key ordering change that prevents any queued tick from observing in-progress cancel state. Bug B's fix is a targeted 4-line guard excluding `exited` from running counts. The plan is complete, implementable, and introduces no new issues.

**Open Questions (unscored)**: None.

---
*Ralplan summary row*:
- Principle/Option Consistency: Pass — all 5 principles are applied correctly. Snapshot-before-clear (Option A) is sound; Options B and C correctly rejected. Bug B guard respects `idle` counting per Open Question B-1 default.
- Alternatives Depth: Pass — three options evaluated with explicit pros/cons and rejection rationale. Option C (kill panes directly in shutdown) was correctly rejected for duplicating kill logic. Option B (shutting-down flag) correctly rejected for runtime overhead.
- Risk/Verification Rigor: Pass — regression test at `subagent-shutdown.test.ts:164` verified as unaffected; AC-A1/AC-A2 tests will fail before fix and pass after; Bug B regression guard (AC-B3) is present. Risk register covers all major risks.
- Deliberate Additions (if required): Pass — SHORT mode; no DELIBERATE additions required. ADR section is complete and accurate.
