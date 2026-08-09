# PR #84 frozen acceptance evidence

Status: **not merge-ready**. This matrix is the authoritative snapshot for the
current `0bd6efb..HEAD` worktree. A green targeted suite is not treated as
closure when the frozen requirement calls for a crash, child-process, packed,
or production command lane.

| ID  | Current status | Evidence currently present                                                                                                                            | Missing before closure                                                                           |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| F01 | PARTIAL        | `workflow-storage-foundation.test.ts`: “F01 leaves no dispatchable run when creation fails before publication” and “F01 keeps a complete immutable prefix when publication fails after rename”; atomic run/event helpers | Broader run-creation crash matrix and recovery assertions across all publication boundaries      |
| F02 | PARTIAL        | `workflow-owner.test.ts`, `workflow-recovery.test.ts`                                                                                                 | Session reload/restart integration and foreign-owner rejection across a real restart             |
| F03 | PASS           | `workflow-concurrency.test.ts`: “F03 lets exactly one of two same-owner stores win a CAS append”; production `appendIfCurrent` path | —                                                                                                  |
| F04 | PASS           | `workflow-lease-cross-process.test.ts`: “allows one initial child acquire and fences takeover to epoch two after death”; `workflow-lease.test.ts` release/interlock coverage | — |
| F05 | PASS           | `workflow-storage-foundation.test.ts`: run-directory symlink, final-target symlink, hardlink, non-regular target, and inode-replacement probes | — |
| F06 | PASS           | `workflow-storage-foundation.test.ts`: short-write probe plus ENOSPC and event/run/owner quota prefix-preservation tests; journal validation tests | — |
| F07 | PARTIAL        | `workflow-concurrency.test.ts`, durable runner tests                                                                                                  | Full block/append/settlement/finalization race matrix with one-winner assertions                 |
| F08 | PARTIAL        | blocker projection and cancellation targeted tests                                                                                                    | Exhaustive task × approval × budget permutation evidence                                         |
| F09 | PARTIAL        | mutation hash/CAS implementation and targeted tests                                                                                                   | Tampered/missing hash matrix proving no authority advance and production call-site coverage      |
| F10 | PARTIAL        | dispatcher cap and parallel sibling tests                                                                                                             | Stop-on-failure admission/drain stress and deterministic terminal-selection lane                 |
| F11 | PARTIAL        | runner accounting tests                                                                                                                               | Crash/replay accounting lane proving lower-bound semantics for interrupted attempts              |
| F12 | PARTIAL        | `workflow-cancellation.test.ts`, recovery tests                                                                                                       | Every cancellation/settlement crash prefix with idempotent repair assertions                     |
| F13 | PARTIAL        | durable broker tests: deterministic ID, retry, crash reclaim, stale settlement fence                                                                  | Persisted matching Pi-entry integration and normal/recovered shared-broker proof                 |
| F14 | PARTIAL        | retention/interlock implementation and storage tests; `workflow-retention-command.integration.test.ts` exercises registered `/workflow-retention` against matching intent → dispatched → receipt state | Active-writer, blocked, interrupted, and undelivered retention interleavings                    |
| F15 | PARTIAL        | production command registration, approval/cancellation tests, authority-envelope handlers; declarative task approval gate and matching-task skip test | Registered-command integration with exact envelopes, idempotency, reload, and explicit resume    |
| F16 | PARTIAL        | session-scoped continuity snapshot, Pi-owner filtering, generation/owner clearing, and multi-session extension test                                   | Session startup/shutdown/reload evidence through the real Pi lifecycle and bounded output audit  |
| F17 | PARTIAL        | fenced mutation/controller tests                                                                                                                      | Registered command stale-editor tests with unchanged journal bytes and refresh data              |
| F18 | PARTIAL        | tool schema/rejection and compatibility tests                                                                                                         | Full legacy script/name lane plus durable JS/process rejection before creation/dispatch          |
| F19 | PARTIAL        | `format:check`, `typecheck`, `pack:check`, `coverage:check`; full `npm test` 79 files/1572 tests passed; tmux 10/10 and Pi delivery 24/24 passed; zellij lane 13 skipped by environment | Pi min/latest lanes and an exercised zellij environment remain missing |
| F20 | PARTIAL        | README public-surface assertion and this matrix                                                                                                       | Final audit of `todo.md`, `qa.md`, README, and PR language after all implementation work         |

Deferred boundaries: X01–X05 remain explicitly deferred. X06 remains the
helper-only threat-model boundary; this worktree does not claim `openat2`-class
containment against a malicious same-user parent-directory rename race.

Required final verdict: every F01–F20 must become `PASS` with named permanent
evidence. `PARTIAL`, inferred helper existence, or targeted-only evidence is not
merge-ready.
