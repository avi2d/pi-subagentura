# PR #84 frozen acceptance evidence

Status: **not merge-ready**. This matrix is the authoritative snapshot for the
current `0bd6efb..HEAD` worktree. A green targeted suite is not treated as
closure when the frozen requirement calls for a crash, child-process, packed,
or production command lane.

| ID  | Current status | Evidence currently present                                                                | Missing before closure                                                                           |
| --- | -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| F01 | PARTIAL        | `workflow-storage-foundation.test.ts`; atomic run/event helpers                           | Run-creation crash matrix, including fault injection before/after publication                    |
| F02 | PARTIAL        | `workflow-owner.test.ts`, `workflow-recovery.test.ts`                                     | Session reload/restart integration and foreign-owner rejection across a real restart             |
| F03 | PARTIAL        | `workflow-concurrency.test.ts` dispatcher/CAS coverage                                    | Two-store barrier proving one same-owner CAS winner                                              |
| F04 | PARTIAL        | `workflow-lease.test.ts`, storage lease checks                                            | Child-process takeover/release race and replacement-lease shutdown proof                         |
| F05 | PARTIAL        | final-target and lease checks in storage foundation                                       | Complete lexical/symlink/hardlink/nonregular/inode-replacement probe matrix                      |
| F06 | PARTIAL        | torn-suffix repair and journal validation tests                                           | short-write, ENOSPC/quota, and malformed-record fault matrix                                     |
| F07 | PARTIAL        | `workflow-concurrency.test.ts`, durable runner tests                                      | Full block/append/settlement/finalization race matrix with one-winner assertions                 |
| F08 | PARTIAL        | blocker projection and cancellation targeted tests                                        | Exhaustive task × approval × budget permutation evidence                                         |
| F09 | PARTIAL        | mutation hash/CAS implementation and targeted tests                                       | Tampered/missing hash matrix proving no authority advance and production call-site coverage      |
| F10 | PARTIAL        | dispatcher cap and parallel sibling tests                                                 | Stop-on-failure admission/drain stress and deterministic terminal-selection lane                 |
| F11 | PARTIAL        | runner accounting tests                                                                   | Crash/replay accounting lane proving lower-bound semantics for interrupted attempts              |
| F12 | PARTIAL        | `workflow-cancellation.test.ts`, recovery tests                                           | Every cancellation/settlement crash prefix with idempotent repair assertions                     |
| F13 | PARTIAL        | durable broker tests: deterministic ID, retry, crash reclaim, stale settlement fence      | Persisted matching Pi-entry integration and normal/recovered shared-broker proof                 |
| F14 | PARTIAL        | retention/interlock implementation and storage tests                                      | Active-writer, blocked, interrupted, and undelivered retention interleavings                     |
| F15 | PARTIAL        | production command registration, approval/cancellation tests, authority-envelope handlers | Registered-command integration with exact envelopes, idempotency, reload, and explicit resume    |
| F16 | PARTIAL        | session-scope/continuity implementation                                                   | Multi-session lifecycle evidence: owner filter, bounded factual output, shutdown/new clearing    |
| F17 | PARTIAL        | fenced mutation/controller tests                                                          | Registered command stale-editor tests with unchanged journal bytes and refresh data              |
| F18 | PARTIAL        | tool schema/rejection and compatibility tests                                             | Full legacy script/name lane plus durable JS/process rejection before creation/dispatch          |
| F19 | PARTIAL        | `typecheck`, `format:check`, `pack:check`; 76/80 test files passed in latest full run     | Coverage, Pi min/latest lanes, and full test pass (tmux lane also timed out in this environment) |
| F20 | PARTIAL        | README public-surface assertion and this matrix                                           | Final audit of `todo.md`, `qa.md`, README, and PR language after all implementation work         |

Deferred boundaries: X01–X05 remain explicitly deferred. X06 remains the
helper-only threat-model boundary; this worktree does not claim `openat2`-class
containment against a malicious same-user parent-directory rename race.

Required final verdict: every F01–F20 must become `PASS` with named permanent
evidence. `PARTIAL`, inferred helper existence, or targeted-only evidence is not
merge-ready.
