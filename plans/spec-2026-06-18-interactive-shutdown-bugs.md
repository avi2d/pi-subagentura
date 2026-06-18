# Spec — Duplicate Notification on Close + Stale Footer/Widget for Closed Interactive Sub-agents

**Date:** 2026-06-18
**Branch:** `feature/we-still-have-the-issue-that-onvce-inter`
**Worktree:** `/Users/applesucks/dev/pi-agents-worktrees/we-still-have-the-issue-that-onvce-inter`

## 1. Restated Bugs

### Bug A — Duplicate notification on parent session close
After an interactive sub-agent completes a turn (child calls `cli.mjs done 0` → `done` event in `events.ndjson`) and the parent correctly delivers one `subagent-notify` pointer notification, a **second** `subagent-notify` is delivered when the user subsequently closes the Pi parent session.

### Bug B — Stale footer/widget for closed interactive sub-agents
When an interactive sub-agent is closed (i.e. the child has finished a turn and the pane is dead → `state.status === "exited"`), it continues to show in:
- the **footer** as `⚡ N sub-agents running` (built at `src/subagent.ts:627-630`)
- the **widget** as a row in the activity list (built at `src/subagent.ts:635-636`)

The user sees a "running" indicator for sub-agents that are no longer running.

## 2. Evidence (file:line)

### Bug B — primary evidence (HIGH confidence)

**`src/subagent.ts:618-622`** — inside the `pollArtifactChanges` for-loop:

```ts
for (const state of interactiveSubagentRegistry.values()) {
    if (state.status === "cancelled" || state.status === "unknown") continue;
    // ... processing ...
    runningCount++;
    widgetRows.push(formatActivityRow(state));   // ← includes "exited" and "idle"
}
```

The `continue` at line 526 only filters `cancelled` and `unknown`. States with `status === "exited"` (terminal, pane dead) and `status === "idle"` (between turns, pane alive) fall through into the loop body and are counted in `runningCount` / pushed into `widgetRows`.

The status update at `src/subagent.ts:534-540` correctly transitions a `done + pane dead` sub-agent to `"exited"`, but the loop body's runningCount/widgetRows does not check status before incrementing/pushing.

### Bug A — supporting evidence (MEDIUM confidence)

**`src/subagent.ts:2489-2535`** — the `session_shutdown` handler:

```ts
(pi as any).on?.("session_shutdown", () => {
    const g2 = typeof global !== "undefined" ? global : globalThis;

    // 1. Stop the poller (synchronous; does NOT abort an in-flight queued tick)
    if (g2.__piSubagenturaInteractivePollerHandle) {
      try { clearInterval(g2.__piSubagenturaInteractivePollerHandle); } catch { /* defensive */ }
      g2.__piSubagenturaInteractivePollerHandle = undefined;
    }

    // 2. Cancel running sub-agents
    try {
      for (const state of interactiveSubagentRegistry.values()) {
        if (state.status === "running") {
          try { cancelInteractiveSubagent(state.id); } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }

    // 3. Clear the registry (last!)
    try { interactiveSubagentRegistry.clear(); } catch { /* best effort */ }

    // 4. Abort jobs, null pi ref...
});
```

**`src/interactive-tmux.ts:557-580`** — `cancelInteractiveSubagent`:

```ts
export function cancelInteractiveSubagent(id: string): InteractiveSubagentState | undefined {
    const state = interactiveSubagentRegistry.get(id);
    if (!state) return undefined;

    // 1. Write .cancelled flag
    try { writeFileSync(join(state.artifactDir, ".cancelled"), "", { mode: 0o600 }); } catch {}

    // 2. Set state.status = "cancelled"
    state.status = "cancelled";

    // 3. Kill the pane (synchronous; trap fires on bash exit)
    const mux = getMuxForState(state);
    if (mux.isPaneAlive(state.paneId, state.muxSession)) {
      mux.killPane(state.paneId, state.muxSession);
    }
    return state;
}
```

**Race mechanism:** A poll tick queued by `setInterval` before `clearInterval` runs (Node does not abort queued callbacks on `clearInterval`). The in-flight tick:
1. Iterates the registry (still populated — `clear()` runs AFTER the cancel loop).
2. May observe a state with `status === "running"` that is mid-cancel (cancel has set `status = "cancelled"` AFTER `killPane`, so a tick between killPane and status assignment can see `status === "running"` with a freshly-written `cancelled` event in the artifact).
3. The events loop reads from `cursor + 1` — if the child's `done` event was just written, or the auto-done fallback synthesizes a fresh event with a NEW ts, the events loop fires `deliverArtifactNotification` for that event.

**Hypothesis:** The duplicate notification is one of:
- The auto-done fallback (`maybeAutoDone`) synthesizes a `done`/`error` event during the in-flight tick with `ts = now` and `lastDeliveredEventTs = ts`, but if the artifact already contains an explicit `done` that the poller is mid-reading, the events loop delivers it.
- The cancel writes a `cancelled` event (via the EXIT trap) that the in-flight tick re-delivers because `state.status` is still `"running"` from the poller's perspective.

## 3. Functional Requirements

### For Bug A (duplicate notification)
1. **FR-A1:** The system must deliver exactly one `subagent-notify` pointer notification per terminal artifact event (done/error/cancelled), regardless of parent session lifecycle events.
2. **FR-A2:** When `session_shutdown` fires, no in-flight poll tick may deliver a notification for an event that was already delivered, or for an event written by the shutdown's cancel path.
3. **FR-A3:** The shutdown handler must guarantee that a queued poll tick (one whose callback was already in Node's event loop queue) cannot observe the in-progress cancel state.

### For Bug B (stale footer/widget)
1. **FR-B1:** The footer `⚡ N sub-agents running` must count only sub-agents that are actively processing a turn — i.e. `state.status === "running"`.
2. **FR-B2:** The footer MAY continue to count `state.status === "idle"` (between turns, REPL open, pane alive — still a live sub-agent awaiting follow-up). Decision pending: see Open Question B-1.
3. **FR-B3:** The widget MUST NOT show rows for sub-agents with `state.status === "exited"` (terminal, pane dead).
4. **FR-B4:** The poll loop MUST still tail-read the session log of `exited` sub-agents (for the user-role revival case at `processSessionLogEntry:799`).
5. **FR-B5:** When all sub-agents are terminal (all `cancelled`/`exited`/`unknown`), the footer MUST be cleared (`setStatus(FOOTER_KEY, undefined)`) and the widget MUST be cleared (`setWidget(WIDGET_KEY, undefined)`).

### Cross-cutting
1. **FR-X1:** All existing tests in `src/subagent-shutdown.test.ts`, `src/subagent-poll.test.ts`, `src/subagent-auto-done.test.ts`, and the other 14 test files must continue to pass.
2. **FR-X2:** The fix must work with both the tmux and zellij multiplexer backends.
3. **FR-X3:** The fix must not change the public API of the extension (no new tools, no new exports required).

## 4. Non-Functional Requirements

1. **NFR-1 (Performance):** The poller's per-tick complexity must remain O(N) over the registry. The fix must not introduce a second pass over the registry.
2. **NFR-2 (Memory):** `interactiveSubagentRegistry` must continue to be cleared on `session_shutdown` (existing behavior; see `subagent-shutdown.test.ts:164`).
3. **NFR-3 (UX):** The user must not see "running" indicators for sub-agents that have completed and whose pane is dead.

## 5. Implicit Requirements

1. The auto-done fallback's `lastDeliveredEventTs` cursor mechanism must remain the single source of truth for "have we delivered this event yet" — no parallel bookkeeping.
2. The fix for Bug A must be robust against the in-flight tick regardless of whether the cancel writes `.cancelled` BEFORE or AFTER updating `state.status`.

## 6. Out of Scope

1. In-process sub-agents (`subagent_with_context`, `subagent_isolated`) — they use a different code path and are not affected.
2. The auto-done fallback's correctness — it has its own regression tests in `subagent-auto-done.test.ts` and is a separate concern.
3. The `read_subagent_artifact` and `send_interactive_subagent_message` tools — they don't deliver notifications.
4. The Pi SDK's `session_shutdown` event semantics — we cannot change when the event fires.
5. Refactoring `pollArtifactChanges` to use a different loop structure (e.g. a Set or a Map of "live" sub-agents).

## 7. Acceptance Criteria

### For Bug A

1. **AC-A1:** Given a sub-agent in `status === "running"` with an artifact containing only a `started` event, when `session_shutdown` fires followed by a direct call to `pollArtifactChanges`, the total `sendMessage` calls (with `customType: "subagent-notify"`) across the entire sequence is at most 1.
2. **AC-A2:** Given a sub-agent in `status === "running"` with an artifact containing a `done` event (child called `cli.mjs done 0`), when `session_shutdown` fires, the `cancelInteractiveSubagent` call writes a `cancelled` event to the artifact but no new `subagent-notify` is delivered (the existing one for `done` was already delivered).
3. **AC-A3:** A new test in `src/subagent-shutdown.test.ts` covers AC-A1 and AC-A2.

### For Bug B

1. **AC-B1:** A test in `src/subagent-poll.test.ts` placing one `running`, one `idle`, and one `exited` sub-agent in the registry, then calling `pollArtifactChanges`, must assert:
   - `setStatus(FOOTER_KEY, "⚡ 1 sub-agent running")` is called (or `2` if `idle` is counted — see Open Question B-1)
   - `setStatus(FOOTER_KEY, undefined)` is NOT called when at least one `running` sub-agent exists
   - `setWidget(WIDGET_KEY, [...])` receives a list with at most 2 rows (running + idle, NOT exited)
2. **AC-B2:** A test placing only `exited` sub-agents in the registry must assert:
   - `setStatus(FOOTER_KEY, undefined)` is called (footer cleared)
   - `setWidget(WIDGET_KEY, undefined)` is called (widget cleared)
3. **AC-B3:** All existing `subagent-poll.test.ts` tests that count sub-agents as "running" must continue to pass (i.e. the fix must not break the case where all sub-agents are `running`).

### Cross-cutting

1. **AC-X1:** `npm run typecheck` passes with no errors.
2. **AC-X2:** `npm test` passes with no regressions across all 17 test files.
3. **AC-X3:** `npm run format:check` passes.
4. **AC-X4:** `npm run pack:check` passes.

## 8. Open Questions

### A. Bug A — duplicate notification

- [ ] **A-1** — Is the duplicate reliably reproducible in a unit test that mocks `setInterval` and triggers the race? The test infrastructure (`vi.spyOn(globalThis, "setInterval")` in `subagent-shutdown.test.ts:90-92`) is in place; we can simulate a queued tick by calling the captured callback directly. **Why it matters:** Without a failing test that reproduces the bug, the fix may not actually address the real cause.

- [ ] **A-2** — Does the fix need to clear the registry BEFORE the cancel loop, or is the safer fix to set a "shutting down" flag that `pollArtifactChanges` checks at the top and returns early? **Why it matters:** Two viable approaches with different blast radius. The first changes the shutdown handler order; the second requires touching the poller.

- [ ] **A-3** — Is the duplicate actually caused by the `cancelled` event written by the EXIT trap, or by a `done` event re-read because the cursor wasn't advanced? **Why it matters:** Different fix: one is about the cancel event delivery, the other is about the cursor mechanism.

### B. Bug B — stale footer/widget

- [ ] **B-1** — Should `idle` sub-agents (between turns, REPL open, pane alive) count as "running" in the footer? **Why it matters:** They ARE live (REPL is open, ready for follow-up), but they're not "running" a turn. UX preference. The current code counts them; the fix should preserve this if there's no strong reason to change it. Default: count them.

- [ ] **B-2** — Should the fix prune `exited` sub-agents from the registry after some grace period (e.g. 5 minutes), to prevent the registry from growing unbounded? **Why it matters:** The session_shutdown clear already handles cross-session cleanup, but a long-running session with many closed sub-agents will keep them in the registry forever. Out of scope for this fix per the AGENTS.md principle "minimal changes", but worth flagging.

## 9. Files Likely Affected

- `src/subagent.ts:619-622` — the for-loop body's `runningCount++` and `widgetRows.push(formatActivityRow(state))` need to be guarded by a status check.
- `src/subagent.ts:2489-2535` — the `session_shutdown` handler: order of operations (clear registry before cancel, or set a "shutting down" flag) may need adjustment.
- `src/subagent-shutdown.test.ts` — new tests for AC-A1 and AC-A2.
- `src/subagent-poll.test.ts` — new tests for AC-B1 and AC-B2.

## 10. Requirement Coverage Map

| Requirement | Test |
|-------------|------|
| FR-A1 (one notification per event) | AC-A1, AC-A2 |
| FR-A2 (no shutdown re-delivery) | AC-A1, AC-A2 |
| FR-A3 (queued tick cannot observe in-progress cancel) | AC-A1 |
| FR-B1 (footer counts only `running`) | AC-B1, AC-B3 |
| FR-B2 (footer counts `idle`) | AC-B1 |
| FR-B3 (widget excludes `exited`) | AC-B1, AC-B2 |
| FR-B4 (tail-read `exited` for revival) | existing tests in `subagent-auto-done.test.ts:441-496` |
| FR-B5 (clear UI when all terminal) | AC-B2 |
| FR-X1 (no regressions) | AC-X2 |
| FR-X2 (both mux backends) | existing `interactive-tmux.test.ts` tests |
| FR-X3 (no public API change) | AC-X2 (compilation + tests) |
| NFR-1 (no perf regression) | AC-X2 (existing timing tests) |
| NFR-2 (registry cleared on shutdown) | existing `subagent-shutdown.test.ts:164` |
| NFR-3 (no stale "running" indicators) | AC-B1, AC-B2 |
