# Architect Review — Revision for Critic's ITERATE Flag

**Reviewing:** `plans/drafts/plan_draft.md` (revised after Critic ITERATE)
**Code under review:** `src/interactive-tmux.ts:557-559` (existing `cancelInteractiveSubagent`), new `cancelInteractiveSubagentByState` export (plan lines 118-130), shutdown handler (plan lines 136-154)

---

## Previous Critical Issue: Status

**[HIGH] Critic's ITERATE — `cancelInteractiveSubagent(id)` early-return after `clear()`**

**RESOLVED.**

The Critic correctly identified that `cancelInteractiveSubagent(id)` at `src/interactive-tmux.ts:558-559` does:
```ts
const state = interactiveSubagentRegistry.get(id);
if (!state) return undefined;  // ← early return when registry is empty
```

Calling this after `interactiveSubagentRegistry.clear()` would be a no-op: no `.cancelled` write, no pane kill.

The revision fixes this with a two-part solution:

1. **Snapshot before clear** (plan lines 127-141): The shutdown handler now collects `runningStates[]` (full `InteractiveSubagentState` objects) into a snapshot BEFORE calling `clear()`. This preserves the state objects themselves, not just IDs.

2. **New bypass export** (plan lines 118-130): `cancelInteractiveSubagentByState(state)` accepts a pre-built state object and performs its operations — `.cancelled` write, pane kill — WITHOUT touching the registry at all.

The cancel-after-clear order in the revised shutdown handler (plan line 144: clear first, then cancel loop at line 152) is now safe because `cancelInteractiveSubagentByState` never looks up from the registry.

---

## New Export Design Review

**`cancelInteractiveSubagentByState(state: InteractiveSubagentState): void`** (plan lines 118-130)

| Aspect | Assessment |
|--------|------------|
| Registry dependency | ✅ None — accepts full state object, no `interactiveSubagentRegistry.get()` call |
| `.cancelled` write | ✅ Present, best-effort, correct file path from `state.artifactDir` |
| Pane kill | ✅ Via `getMuxForState(state)` → `mux.killPane()`, best-effort, guarded by `isPaneAlive` |
| Status update | ✅ Correctly omitted — registry is already cleared; status bookkeeping is unnecessary for shutdown |
| Error handling | ✅ Best-effort throughout, consistent with existing `cancelInteractiveSubagent` pattern |

The function signature is appropriate: callers must pass a complete `InteractiveSubagentState` object, not an ID. The shutdown handler satisfies this by snapshotting state objects from the registry before clearing it (plan lines 138-141).

**No issues with the new export design.**

---

## Any Other New Issues

**None.**

The Bug B fix (guard at plan lines 89-92) is unchanged from the previous approved review and remains correct. The dependency graph, risk register, and open questions in the ADR are complete and accurate.

---

## Verification Checklist

| Check | Result |
|-------|--------|
| Cancel loop no longer depends on registry lookup | ✅ `runningStates[]` snapshot + `cancelInteractiveSubagentByState(state)` |
| Registry cleared before any cancel writes | ✅ Plan line 147 precedes cancel loop at line 152 |
| `cancelInteractiveSubagentByState` has no registry dependency | ✅ Confirmed — no `interactiveSubagentRegistry` access |
| `state.status` not updated (intentional, registry already cleared) | ✅ Documented at plan line 129 |
| Bug B guard unchanged and correct | ✅ `if (state.status === "running" \|\| state.status === "idle")` at lines 89-92 |
| Existing `subagent-shutdown.test.ts:164` unaffected | ✅ Risk noted at plan line 190; test checks end-state only |

---

**VERDICT: APPROVE**

The revision correctly addresses the Critic's ITERATE concern. The new `cancelInteractiveSubagentByState` export eliminates the registry dependency that caused the early-return no-op. The snapshot-before-clear pattern is sound. No new issues introduced.
