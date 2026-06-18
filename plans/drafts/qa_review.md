# QA Review — commit 4d8f9bd

**Overall Assessment**: The fix correctly addresses both Bug A (duplicate notification on shutdown) and Bug B (stale footer for exited sub-agents). The Bug B guard logic at `src/subagent.ts:632` is sound and excludes `exited` from the running count while preserving tail-read for revival. The Bug A fix introduces a registry-bypass cancellation path and clears the registry before killing panes, preventing the in-flight poll tick race. All 298 tests pass. Minor concerns exist around the AC-A* tests not directly reproducing the setInterval race, but this is acknowledged in the spec as inherently difficult to test in a unit test.

---

**Test Run Results**:
```
Test Files  18 passed (18)
     Tests  298 passed (298)
  Duration  5.31s
```

All tests pass cleanly. No surprises.

---

**Bug B Fix**: PASS

**File**: `src/subagent.ts:620-638`

The 4-line status guard:
```typescript
if (state.status === "running" || state.status === "idle") {
    runningCount++;
    widgetRows.push(formatActivityRow(state));
}
```

Correctly excludes `exited` from both `runningCount` and `widgetRows`. Evidence:

1. **`deriveInteractiveSubagentStatus`** (`src/interactive-tmux.ts:608-618`) returns `exited` when:
   - `lastEvent.type === "error"` → line 614
   - `lastEvent.type === "done"` AND `paneAlive === false` → line 615

2. **`exited` is intentionally NOT in the skip list** at `src/subagent.ts:527`:
   ```typescript
   if (state.status === "cancelled" || state.status === "unknown") continue;
   ```
   This allows the for-loop to continue tail-reading session logs for `exited` sub-agents (user-role revival case), per the comment at lines 520-527.

3. **Status guard at line 632** filters `exited` out of UI display:
   - `running` → included ✓
   - `idle` → included ✓
   - `exited` → excluded ✓
   - `cancelled`/`unknown` → skipped at line 527 (never reach line 632) ✓

4. **Test coverage** (AC-B1, AC-B2, AC-B3 in `src/subagent-poll.test.ts:541-674`):
   - AC-B1 verifies running + idle count as 2, exited excluded from widget
   - AC-B2 verifies all-exited → cleared footer/widget
   - AC-B3 is a regression guard for all-running scenario

**Concern**: The status guard evaluates `state.status` AFTER the status refresh at lines 535-541. For a sub-agent transitioning from `running` → `exited` in the same poll, the guard correctly sees `exited` and excludes it. This is the intended behavior.

---

**Bug A Fix**: PASS

**File**: `src/subagent.ts:2517-2542` + `src/interactive-tmux.ts:587-599`

The shutdown handler sequence:
1. Snapshots running states (lines 2521-2524)
2. Clears registry (lines 2531-2533)
3. Kills panes via `cancelInteractiveSubagentByState` (lines 2538-2542)

**New export `cancelInteractiveSubagentByState`** (`src/interactive-tmux.ts:587-599`):
- Takes `state: InteractiveSubagentState` directly — bypasses registry lookup
- Writes `.cancelled` flag (best-effort)
- Checks `isPaneAlive` before killing pane (best-effort)
- Does NOT update `state.status` — registry is already cleared per comment line 598

**Race condition prevention**: By clearing the registry BEFORE killing panes, an in-flight poll tick (dequeued before `clearInterval` ran) finds an empty registry and iterates over zero entries. The for-loop at `src/subagent.ts:519` becomes a no-op, delivering zero notifications.

**Old `cancelInteractiveSubagent`**: The old function at `src/interactive-tmux.ts:557-580` calls `interactiveSubagentRegistry.get(id)` at line 558 and returns `undefined` if not found. After `clear()`, this would be a no-op. The fix correctly avoids this path in the shutdown handler. The old function is still used by the `cancel_interactive_subagent` tool at `src/subagent.ts:2131`, which is unaffected.

**Evidence of correct registry-clear-first ordering**:
- `src/subagent.ts:2531-2533`: Registry cleared BEFORE `cancelInteractiveSubagentByState` at line 2540
- `src/subagent.ts:2536-2537`: Comment explicitly states "The poller is already safe (registry empty)"

---

**Test Coverage**: CONCERNS (not a blocker)

**AC-A* tests** (`src/subagent-shutdown.test.ts:234-282`):
- AC-A1 and AC-A2 call `pollArtifactChanges` directly at shutdown boundaries
- They verify post-shutdown state (registry empty → no notifications)
- They do NOT test the actual setInterval race (the race is between `setInterval` queuing a tick and `clearInterval` being called)

**The spec's Open Question A-1** acknowledges: "The race is hard to reproduce in a unit test." The tests verify the correctness of the fix's post-condition (empty registry → no work), not the race itself. This is acceptable because:
1. The fix's logic is sound (clear registry before kill panes)
2. The test directly exercises the fix's key invariant
3. The race involves async timer dequeuing which cannot be reliably unit-tested

**Updated test at `src/subagent-shutdown.test.ts:162-196`**:
- Correctly verifies `cancelByStateSpy` is called once with the running state
- Correctly verifies `cancelSpy` (old id-based) is NOT called
- The spy mock implementations `((() => undefined) as any)` are appropriate for testing call patterns without side effects

**Bug B tests** (`src/subagent-poll.test.ts:541-674`):
- Correctly mock `isPaneAlive` via `execFileSync` to return different results per paneId
- AC-B1 sets up running (alive), idle (alive), and exited (dead) states
- AC-B2 tests all-exited → cleared footer
- The mock correctly throws for `%exited-pane` and returns success for others

---

**Critical Findings** (blocks merge):
None. The fix is correct.

---

**Major Findings** (causes rework):
None.

---

**Minor Findings** (suboptimal but functional):

1. **AC-A* tests don't directly reproduce the setInterval race**
   - **Location**: `src/subagent-shutdown.test.ts:234-282`
   - **Detail**: Tests call `pollArtifactChanges` directly, bypassing the `setInterval` mock. They test post-shutdown behavior but not the actual async dequeuing race.
   - **Impact**: Low. The fix's correctness is verifiable via post-condition testing. The race cannot be reliably unit-tested per the spec's own acknowledgment.
   - **Recommendation**: Accept as-is. Consider adding an integration test that uses real timers if a follow-up task.

2. **`maybeAutoDone` doesn't update `state.status` immediately**
   - **Location**: `src/subagent.ts:941-947`
   - **Detail**: After synthesizing a `done` event, `maybeAutoDone` leaves `state.status` as `running`. The UI briefly shows the sub-agent as running before the next poll transitions it to `exited`.
   - **Impact**: Cosmetic, self-corrects on next poll. Not introduced by this fix.
   - **Recommendation**: Accept as-is. This is a pre-existing behavior noted in the code comments.

---

**What's Missing**:
- **Gap 1**: Integration test for the actual setInterval race condition (acknowledged as hard to test, not a blocker)
- **Gap 2**: The AC-B1 test at `src/subagent-poll.test.ts:600` asserts `widgetArgs[1].length === 2` (running + idle), but doesn't assert the exact identities of the widget rows. The test would pass if any two states were in the widget. This is minor but could be improved.

---

**Adversarial Pass**:

1. **Does `maybeAutoDone` interact with the new guard or shutdown logic in a way that re-introduces Bug A or Bug B?**
   - **Bug A**: No. `maybeAutoDone` runs inside the for-loop (line 551), which iterates over `interactiveSubagentRegistry.values()`. After shutdown clears the registry, the for-loop has zero iterations, so `maybeAutoDone` never runs.
   - **Bug B**: No. `maybeAutoDone` doesn't affect `runningCount` or `widgetRows`. The status guard at line 632 runs after the for-loop body where `maybeAutoDone` runs, so `maybeAutoDone` cannot affect the guard's decision.

2. **Other call sites of `cancelInteractiveSubagent` affected by the new export?**
   - **Location**: `src/subagent.ts:2131`
   - **Detail**: `cancelInteractiveSubagent` is still used by the `cancel_interactive_subagent` tool (Tool 8). This is correct — the tool is for user-initiated cancellation while the session is live. The registry is populated, so the id-based lookup works correctly.
   - **Verdict**: Unaffected, correct.

3. **Does the for-loop correctly handle `exited` for ALL downstream code, not just footer?**
   - **Tail-read** (`src/subagent.ts:545`): `exited` is NOT skipped, correctly runs for revival ✓
   - **Events delivery** (`src/subagent.ts:558-569`): Runs for `exited`, will deliver notifications for events newer than `lastDeliveredEventTs` ✓ (this is correct — a late-arriving event should be delivered)
   - **Snapshot** (`src/subagent.ts:575-580`): Runs for `exited`, snapshots on `done` events ✓
   - **Inject** (`src/subagent.ts:585-610`): Runs for `exited`, injects on `done` events ✓
   - **Footer/widget** (`src/subagent.ts:632-638`): `exited` excluded ✓
   - **Verdict**: Correct.

4. **Is the for-loop status refresh at lines 535-541 race-safe?**
   - **Detail**: The status refresh reads `isPaneAlive(state)` via mux backend. If the pane is being killed concurrently by the shutdown handler, `isPaneAlive` might return `false`, causing `deriveInteractiveSubagentStatus` to return `exited`. The state would be updated to `exited` in the for-loop.
   - **Impact**: None. The registry is cleared after shutdown, so no further polls can observe this state. Within the same poll, the status guard correctly excludes `exited` from the UI.

---

**Verdict**: APPROVE

**Verdict Justification**: Both Bug A and Bug B are correctly fixed. The Bug B guard logic correctly excludes `exited` from the running count while preserving tail-read for revival. The Bug A fix correctly snapshots states, clears the registry, then kills panes — preventing the in-flight poll tick race. All 298 tests pass. The only concern is that the AC-A* tests don't directly reproduce the setInterval race, but this is acknowledged as inherently difficult to test and the post-shutdown behavior is correctly verified.
