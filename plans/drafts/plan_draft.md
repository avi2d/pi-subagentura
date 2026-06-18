#VV:# Plan — Duplicate Notification + Stale Footer/Widget Fixes
#KM:
#BY:## RALPLAN-DR Summary
#RW:
#WZ:**Mode:** SHORT — bug fix, low-risk, well-understood root causes.
#SY:
#WZ:**Principles:**
#TT:1. Never re-deliver a notification for an event already delivered (`lastDeliveredEventTs` is the sole cursor).
#SY:2. Live UI (`runningCount`, `widgetRows`) reflects only actively processing sub-agents.
#ZB:3. Shutdown must be race-free against in-flight poll ticks; clearing the registry must happen before any cancel writes.
#RJ:4. Registry is cleared on shutdown (existing behavior preserved, existing test enforces it).
#BQ:5. `idle` sub-agents count as "running" in the footer (per Open Question B-1 default, preserves existing behavior).
#ZV:
#YW:**Top 3 Decision Drivers:**
#YM:1. **Race safety** — an in-flight poll tick must not observe the registry mid-cancel; clearing before cancel eliminates the race entirely.
#VK:2. **Minimal blast radius** — Bug B fix is a 2-line guard change inside the existing for-loop; Bug A fix is a new export + 3-section reorder in shutdown.
#SS:3. **Regression coverage** — existing `subagent-shutdown.test.ts:164` test verifies registry cleared on shutdown; must continue to pass.
#KS:
#RP:**Viable Options:**
#YQ:
#KW:| | Option A (snapshot-before-clear + new export) | Option B (shutting-down flag) | Option C (kill panes directly in shutdown) |
#TM:|---|---|---|---|
#TK:| Bug A approach | Snapshot running states; clear registry FIRST; call new `cancelInteractiveSubagentByState(state)` which bypasses registry lookup | Add `__piShuttingDown = true` flag; poller checks and returns early | Inline mux.killPane calls in shutdown using snapshot — duplicates cancel logic |
#PJ:| Pros | Zero new global flags; new export is a clean, reusable primitive; pane-kill is explicit and testable | Explicit opt-out in poller; no cancel refactor needed | No API change needed |
#VP:| Cons | Adds new export; requires understanding the new function's contract | New global flag; runtime check on every poll tick; poller must check on every tick | Duplicates kill logic; more code in shutdown handler |
#QH:| **Chosen** | ✅ | ❌ | ❌ |
#HQ:
#SX:**Why Approach A over C**: Both avoid the registry-dependency problem. Option C duplicates `cancelInteractiveSubagent`'s `.cancelled`-write + `mux.killPane` logic inside the shutdown handler. Option A creates one new export that encapsulates those same operations without touching the registry — cleaner separation of concerns, reusable by other callers, and the duplication is eliminated.
#ZM:
#RX:---
#JQ:
#QH:## Task Breakdown
#WV:
#XZ:### Task 1: Add regression test for Bug A (duplicate notification on shutdown)
#PM:**File:** `src/subagent-shutdown.test.ts`
#RB:
#MY:**What to add (append to existing `describe` block):**
#BH:
#TC:- **Test AC-A1:** "delivers zero notifications when session_shutdown fires while sub-agent is running with no artifact events"
#ZZ:  - Setup: `setupExtension()` → populate registry with one `running` state → capture `setInterval` callback (`const tick = vi.spyOn(globalThis, "setInterval").mock.calls[0][0]`) → call `tick()` (in-flight tick BEFORE shutdown) → call `shutdownHandler()` → call `tick()` again (tick AFTER shutdown) → assert `sendMessage` with `customType: "subagent-notify"` count is 0.
#YH:
#BY:- **Test AC-A2:** "does not re-notify after cancel loop for a running sub-agent with a done event already delivered"
#YH:  - Setup: same as AC-A1 but pre-write a `done` event to the artifact's `events.ndjson` and set `lastDeliveredEventTs` on the state to the done event's ts → call `tick()` (in-flight tick, delivers nothing because done already delivered) → call `shutdownHandler()` → call `tick()` again → assert exactly 1 `subagent-notify` total (the done was already delivered before tick/shutdown).
#QB:
#QX:**Acceptance criteria:**
#NN:- AC-A1 and AC-A2 fail on current code (demonstrating the bug exists).
#NS:- AC-A1 and AC-A2 pass after Task 4 fix.
#VJ:
#SP:**Complexity:** MEDIUM — test infrastructure (setInterval spy, shutdown handler capture) already exists in the file.
#BN:
#PV:---
#PZ:
#QY:### Task 2: Add regression test for Bug B (stale footer/widget for exited sub-agents)
#ZJ:**File:** `src/subagent-poll.test.ts`
#YJ:
#BZ:**What to add (new `describe` block or append to existing `pollArtifactChanges`):**
#HH:- Test AC-B1: Populate registry with one `running`, one `idle`, one `exited` state → call `pollArtifactChanges` with mock `setStatus`/`setWidget` → assert:
#JY:  - `setStatus` called with `⚡ 2 sub-agents running` (running + idle count; idle counted per principle 5).
#VV:  - `setWidget` called with array of length 2 (running + idle rows; no exited).
#XZ:- Test AC-B2: Populate registry with only `exited` states → call `pollArtifactChanges` → assert:
#JP:  - `setStatus(FOOTER_KEY, undefined)` called.
#QS:  - `setWidget(WIDGET_KEY, undefined)` called.
#WZ:- Test AC-B3: All states `running` → assert footer shows `⚡ N running` and widget has N rows.
#JN:
#SN:**Mock approach:** Use `vi.mock("./interactive-tmux", ...)` or `importFresh` to inject a mock mux whose `isPaneAlive` returns appropriate values for each status. Or: use `vi.spyOn(muxModule, "isPaneAlive")` returning `false` for exited, `true` for running/idle.
#PZ:
#QX:**Acceptance criteria:**
#QM:- AC-B1 and AC-B2 tests fail on current code (demonstrating the bug).
#SB:- AC-B3 passes on current code (regression guard).
#YT:- All three pass after Task 4 fix.
#YY:
#WR:**Complexity:** MEDIUM — requires understanding how `deriveInteractiveSubagentStatus` and `isPaneAlive` interact; may need mux mock setup.
#SV:
#RN:---
#HQ:
#PS:### Task 3: Fix Bug B — guard `runningCount++` and `widgetRows.push` in `pollArtifactChanges`
#TX:**File:** `src/subagent.ts`
#VB:
#ZW:**Change at lines 619-622:**
#WB:```ts
#ZH:// BEFORE (lines 619-622):
#WP:    // TUI widget row: every iteration of the loop is a running sub-agent at this point.
#YJ:    runningCount++;
#VS:    widgetRows.push(formatActivityRow(state));
#WR:
#QP:// AFTER:
#BJ:    // Only count sub-agents that are actively processing a turn as "running".
#JH:    // "exited" is terminal — the pane is dead, the sub-agent is done.
#HK:    // "idle" is between turns (REPL open, pane alive) — count it as running.
#RB:    if (state.status === "running" || state.status === "idle") {
#YN:      runningCount++;
#SM:      widgetRows.push(formatActivityRow(state));
#JT:    }
#MJ:```
#MS:
#RT:**Rationale:** The for-loop at line 518 already skips `cancelled` and `unknown`. Adding the `running`/`idle` guard ensures `exited` states (terminal, pane dead) are not counted. The `idle` check preserves existing behavior where between-turn sub-agents show in the footer. The `deriveInteractiveSubagentStatus` at line 534 already correctly sets `status === "exited"` for done+pane-dead; this fix simply respects that status in the UI-building section.
#ZT:
#QX:**Acceptance criteria:**
#KM:- `npm run typecheck` passes.
#MN:- `npm test` passes (including new AC-B1, AC-B2, AC-B3 tests from Task 2).
#WQ:- AC-X1, AC-X2, AC-X3, AC-X4 all pass.
#ZS:
#JN:**Complexity:** LOW — 4-line change inside existing for-loop.
#YS:
#RT:---
#VS:
#KX:### Task 4: Fix Bug A — snapshot-before-clear + new `cancelInteractiveSubagentByState` export
#TX:**File:** `src/interactive-tmux.ts` (new export) + `src/subagent.ts` (shutdown handler)
#YQ:
#PH:**Step 4a — Add new export to `src/interactive-tmux.ts`:**
#WB:After the existing `cancelInteractiveSubagent` function (around line 559), add:
#```ts
#/**
# * Kills a tmux pane and writes the .cancelled flag for an interactive sub-agent,
# * bypassing the registry. Used by the shutdown handler which snapshots running
# * states before clearing the registry.
# */
#export function cancelInteractiveSubagentByState(state: InteractiveSubagentState): void {
#  // 1. Write .cancelled flag (best-effort)
#  try {
#    writeFileSync(join(state.artifactDir, ".cancelled"), "", { mode: 0o600 });
#  } catch { /* best-effort */ }
#
#  // 2. Kill the pane if alive (best-effort)
#  const mux = getMuxForState(state);
#  if (mux.isPaneAlive(state.paneId, state.muxSession)) {
#    try { mux.killPane(state.paneId, state.muxSession); } catch { /* best-effort */ }
#  }
#  // Does NOT update state.status — the registry is already cleared.
#}
#```
#Note: `cancelInteractiveSubagent(id)` is kept unchanged. Other call sites (`send_interactive_subagent_message`, etc.) still use it.
#VP:
#PH:**Step 4b — Update shutdown handler in `src/subagent.ts:2489-2535`:**
#WB:```ts
#YT:// AFTER (snapshot-before-clear pattern with cancelInteractiveSubagentByState):
#VZ:PV:    // Snapshot running states BEFORE clearing, so we can kill their panes.
#ZX:KT:    const runningStates: InteractiveSubagentState[] = [];
#TK:WS:    for (const state of interactiveSubagentRegistry.values()) {
#KN:KV:      if (state.status === "running") runningStates.push(state);
#MZ:KW:    }
#KK:HJ:
#SS:MT:    // Clear the registry FIRST. An in-flight poll tick finds an empty registry.
#SW:PJ:    // The tick's for-loop iterates over zero entries — no work, no notification
#MJ:BQ:    // delivery. `interactivePi` is still valid at this point (pi ref not cleared
#WW:XC:    // until later), so the tick proceeds into the loop and finds nothing.
#WT:PV:    try { interactiveSubagentRegistry.clear(); } catch { /* best effort */ }
#ZN:JB:
#HR:XM:    // Kill the panes using snapshotted states. We cannot call
#NH:JK:    // cancelInteractiveSubagent(id) here — it looks up state from the registry,
#KW:JM:    // which is now empty — so we use cancelInteractiveSubagentByState instead.
#KW:JM:    for (const state of runningStates) {
#PY:BR:      try { cancelInteractiveSubagentByState(state); } catch { /* best effort */ }
#ZP:RV:    }
#QJ:HM:
#HP:XP:
#QX:**Acceptance criteria:**
#KM:- `npm run typecheck` passes.
#PS:- `npm test` passes (including new AC-A1, AC-A2 tests from Task 1).
#ST:- Existing test at `subagent-shutdown.test.ts:164` ("clears interactiveSubagentRegistry in session_shutdown") continues to pass.
#QH:
#MM:**Complexity:** MEDIUM — new export added; shutdown handler reordered into 3 sections.
#TT:
#JZ:---
#TV:
#QH:### Task 5: Verify all tests pass
#HR:**Files:** all
#JB:
#JT:Run:
#BV:```bash
#SH:npm run typecheck && npm test && npm run format:check && npm run pack:check
#KH:```
#QB:
#PV:**Acceptance criteria:** All four commands pass with no regressions across all 17 test files.
#BT:
#XQ:
#HM:---
#RM:## Dependency Graph
#VK:
#MR:```
#JV:Task 1 (Bug A test)          Task 2 (Bug B test)
#NV:       ↓                              ↓
#SB:Task 4 (Bug A fix)   ←  independent →   Task 3 (Bug B fix)
#QP:                    ↓
#JS:           Task 5 (verify all pass)
#MY:```
#QS:
#ZK:**Note:** Tasks 3 and 4 are independent — they touch different lines in different functions. Run Tasks 1+2 first to confirm tests fail on current code, then apply Tasks 3+4, then Task 5.
#NT:
#WB:---
#NB:
#PB:## Risk Register
#HN:
#YZ:| Risk | Probability | Impact | Mitigation |
#JW:|------|-------------|--------|------------|
#WB:| Bug B fix breaks existing footer/widget tests that assume `exited` counts as running | LOW | MEDIUM | AC-B3 regression test; run full suite in Task 5 |
#VB:| Bug A fix breaks `subagent-shutdown.test.ts:164` (registry cleared before cancel) | LOW | HIGH | The test only asserts `registry.size === 0` after shutdown — order of operations within shutdown doesn't affect this |
#WP:| In-flight tick races with cancel AND the auto-done fallback fires | LOW | MEDIUM | Bug A fix (clear registry first) prevents any tick from observing cancel state; auto-done's `lastDeliveredEventTs` guard prevents re-notification |
#SQ:| Mux mock setup in poll tests is complex | MEDIUM | LOW | Use `importFresh` pattern already proven in existing poll tests |
#BW:| `deriveInteractiveSubagentStatus` with `isPaneAlive` returns wrong status for mocked mux | MEDIUM | MEDIUM | Mock `isPaneAlive` explicitly per state type (false for exited, true otherwise) |
#QX:
#YH:---
#ZR:
#KQ:## Architecture Decision Record (ADR)
#JR:
#PZ:### Decision
#YW:Fix Bug A by snapshotting running states before clearing the registry, then calling a new `cancelInteractiveSubagentByState` export that kills panes without a registry lookup. Fix Bug B by guarding `runningCount++`/`widgetRows.push` to exclude `exited` states.
#PZ:
#NB:### Drivers
#PV:- **Race safety:** Node's `setInterval` queues callbacks that cannot be aborted by `clearInterval`. A tick dequeued before `clearInterval` runs will execute after the cancel loop has started but before the registry is cleared.
#VH:- **Preserve existing behavior:** `subagent-shutdown.test.ts:164` asserts the registry is cleared on shutdown — this must continue to pass.
#JK:- **Registry-dependency problem:** The original plan called `cancelInteractiveSubagent(id)` after `registry.clear()`. But `cancelInteractiveSubagent` looks up state from the registry (line 533), so it returns `undefined` after clear() and kills neither the pane nor writes `.cancelled`. The fix requires a new export that accepts full state context, bypassing the registry lookup entirely.
#XQ:
#PS:### Alternatives Considered
#JQ:- **"shutting down" flag** — add `__piShuttingDown = true` before cancel, poller checks and returns early. Rejected because: adds runtime global check to every poll tick, introduces new state that must be managed/reset, and is unnecessary — clearing the registry achieves the same guarantee with zero new state.
#YK:- **Kill panes directly in shutdown** — inline `mux.killPane` calls in shutdown handler using snapshot. Rejected because: duplicates the `.cancelled` write + pane kill logic inside the shutdown handler; a dedicated export is cleaner and reusable.
#ZX:- **Cancel before clear, no snapshot** — current order. Rejected because: a poll tick queued before `clearInterval` can observe registry entries mid-cancel and re-deliver notifications.
#SR:
#RW:### Consequences
#TR:- **Positive:** Bug A eliminated without new global state; existing shutdown test continues to pass; race window completely closed; new `cancelInteractiveSubagentByState` export is a clean, reusable primitive.
#TH:- **Negative:** The cancel loop now iterates `interactiveSubagentRegistry` twice (once for snapshot, once for actual cancel) — O(N) overhead on shutdown only, acceptable. `cancelInteractiveSubagentByState` does not update `state.status` (acceptable — the registry is already cleared, so status bookkeeping is unnecessary for shutdown).
#RZ:
#YN:### Follow-ups
#VY:- [ ] Monitor whether the `idle` footer-counting decision (Open Question B-1) should be revisited; if UX feedback says idle should not count, change the guard in Task 3 from `state.status === "running" || state.status === "idle"` to just `state.status === "running"`.
#TN:- [ ] Consider pruning `exited` sub-agents from registry after a grace period (per Open Question B-2) — out of scope for this fix.
#HT:
#XN:---
#MK:
#PW:## Open Questions
#ST:- [ ] **A-1** (from spec): Is the duplicate reliably reproducible in a unit test? We will write the tests in Task 1 and observe whether they fail on unfixed code.
#WH:[x] **A-2**: Clear registry before cancel OR "shutting down" flag? **Chosen: snapshot-before-clear + cancelInteractiveSubagentByState** (Option A — eliminates race without global flags, new export is a clean primitive).
#NZ:[ ] **A-3**: Which of the two hypothesized Bug A causes is operative — auto-done re-delivery or cancel-event re-delivery? Task 1 tests will determine this empirically. The snapshot-before-clear fix handles both regardless.
#NY:- [x] **B-1**: Should `idle` count as "running"? **Chosen: yes** (preserve existing behavior).
#YB:- [ ] **B-2**: Should `exited` sub-agents be pruned after grace period? **Out of scope** for this fix.
