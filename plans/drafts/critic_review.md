# Critic Review — Final Round (Round 3)

**Plan:** `plans/drafts/plan_draft.md`  
**Date:** 2026-05-22  
**Status:** Final Review

---

## VERDICT: ✅ **APPROVED**

All critical issues (C-1 through C-5) and secondary issues (S-3, O-1, O-2, O-4, E-1 through E-5, M-1, M-3) have been properly addressed.

---

## Critical Issues Verification

### C-1: Graceful Shutdown Protocol ✅
- **Line 495:** `session.shutdown` listed as default method in server
- **Lines 783–797:** Entry script registers `session.shutdown` handler that sends `session.shutdown.ack` and emits `SIGTERM`
- **Lines 1019–1022:** `kill_rpc_subagent` sends `session.shutdown` notification, waits for ack (max 5s), falls back to force kill
- **Line 849, AC-4.6:** Acceptance criteria explicitly require handling session.shutdown

### C-2: Zombie Session Detection ✅
- **Line 630:** "MANDATORY session exit detection via tmux hooks (C-2)"
- **Line 634:** "tmux hooks are the PRIMARY exit notification mechanism, not optional."
- **Lines 636–645:** tmux hook commands defined (session-closed, pane-ended)
- **Line 663:** `setupTmuxHooks()` declared with comment "// Enable tmux hooks for crash detection"
- **Line 732, AC-3.3:** "**tmux hooks MANDATORY** - setupTmuxHooks() enabled on startup"
- **Line 1473:** Risk R-004 mitigation: "tmux hooks MANDATORY for crash detection"

### C-3: Race Condition ✅
- **Lines 368–379:** `ensureSocketDir()` uses `fs.promises.mkdir(dirPath, { mode: 0o700, recursive: true })`
- **Lines 374–378:** Post-creation permission verification with explicit error
- **Line 386–389:** Both directory AND socket file have chmod 0700

### C-4: Heartbeat Mechanism ✅
- **Lines 122–127:** `HEARTBEAT_CONSTANTS` with INTERVAL_MS: 10_000, TIMEOUT_MS: 30_000, MAX_MISSED: 3
- **Lines 267–284:** `HeartbeatPing` and `HeartbeatPong` interfaces with `seq` and `correlationId`
- **Lines 578–606:** `startHeartbeat()` implementation with ping/pong protocol and missed counter
- **Lines 799–805:** Entry script handles `session.heartbeat` ping, returns pong
- **Line 850, AC-3.10:** Acceptance criteria require handling session.heartbeat

### C-5: Backpressure ✅
- **Lines 116–120:** `STREAM_CONSTANTS` with CHUNK_SIZE: 64KB, MAX_BUFFERED_CHUNKS: 16, STREAM_HIGH_WATER: 16
- **Lines 299–307:** `StreamControl` interface with pause/resume/cancel actions
- **Lines 956–969:** Backpressure handling: consumer pauses when buffer exceeds 16 chunks, resumes at high water mark

---

## Security & Operational Issues Verification

| Issue | Status | Evidence |
|-------|--------|----------|
| **S-3:** maxRequestSize, maxDepth, maxStringLength | ✅ | Lines 107–113 (RPC_CONSTANTS), Lines 435–452 (validateRequest function), Line 505 (AC-2.6) |
| **O-1:** Observability + correlation IDs | ✅ | Lines 309–317 (LogEvent interface), Lines 1181–1196 (log events table), Lines 1197–1201 (correlation IDs) |
| **O-2:** Orphan cleanup schedule | ✅ | Lines 1203–1211 (CLEANUP_SCHEDULE: startup + every 5min), Lines 1213–1234 (cleanupOrphans implementation), Line 1420 (AC-5.4) |
| **O-4:** Failure scenario tests | ✅ | Lines 1149–1155 (failure scenarios listed), Line 1160 (AC-6.3), Line 1423 (AC-6.3) |

---

## Edge Cases Verification

| Edge Case | Status | Evidence |
|-----------|--------|----------|
| **E-1:** tmux server crash | ✅ | Lines 1558–1565, Line 1521–1530 (R-009), Line 681–697 (detectZombieSessions fallback) |
| **E-2:** Parent process restart | ✅ | Lines 1567–1576, Lines 1532–1541 (R-010 mitigation) |
| **E-3:** Subagent fork() | ✅ | Lines 1578–1583 (explicitly out of scope, subagents are trusted) |
| **E-4:** Signal delivery | ✅ | Lines 1585–1593, Lines 807–831 (setupSignalHandlers), Line 842 (SIGKILL after 5s) |
| **E-5:** Concurrent calls | ✅ | Lines 1595–1601, Lines 950–954 (concurrent allowed, no ordering guarantees) |

---

## Implementation Decisions Verification

| Issue | Status | Evidence |
|-------|--------|----------|
| **M-1:** Build tool (esbuild) | ✅ | Line 155 ("esbuild is the single, authoritative build tool"), Lines 862–876 (Task 3.3), Line 1368 ("esbuild ONLY") |
| **M-3:** Batch error handling | ✅ | Lines 455–485 (handleBatch: empty batch → -32600, per-item errors with index fallback) |

---

## Reviewer Notes

1. **Architecture is sound**: tmux + Unix sockets is a well-justified choice for RPC isolation (ADR-001, ADR-002, ADR-003)

2. **Execution model clarified**: Parent runs `RpcServer` + `UnixSocketTransport` (server), subagent entry script is an RPC **client** that connects to parent. This is explicitly documented in multiple places.

3. **Critical path is clear**: Lines 1361–1374 define execution order with Task 2.1 → 2.5 → 3.1 → 3.2 → 3.3 → 4.1-4.5 as the critical path.

4. **Security model is intentional**: Minimal security per spec §1.4 — OS-level permissions (chmod 0700) only, no token-based auth. This is explicitly stated as intentional.

5. **Registry separation**: `RpcServiceRegistry` is separate from existing `jobRegistry` (in-process subagents). RPC jobs use their own registry. This is documented in lines 1681–1686.

6. **Risk register is comprehensive**: 11 risks identified (R-001 through R-011) with mitigation strategies and status tracking.

7. **Testing strategy is appropriate**: Unit tests mock everything (no tmux dependency), integration tests skip gracefully if tmux unavailable, E2E tests cover failure scenarios.

---

## Conclusion

The plan is **implementation-ready**. All critical issues have been addressed with concrete specifications, code samples, and acceptance criteria. The plan provides clear guidance for implementation while documenting edge cases, risks, and operational concerns.

**No further revisions required.**