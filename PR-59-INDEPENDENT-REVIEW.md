# PR #59 Independent Review Findings

**PR:** `feat: integrate open PRs 55 through 58`

**Compared against:** `origin/master...HEAD`

**Review scope:** correctness, concurrency, persistence, workflow/API behavior, integration quality, security, resource safety, and test coverage.

**Review method:** four independent read-only reviews of the combined diff. Reviewers inspected the implementation and ran focused tests/reproductions where possible. No repository source files were changed.

## Executive summary

The integration branch passes the normal validation suite:

- `npm run typecheck`
- `npm test -- --run` — 48 files, 1,088 tests passed
- `npm run format:check`
- `npm run pack:check`
- `git diff --check`

However, the independent review found several behavioral and concurrency issues. The most important are cross-session delivery isolation, state-lock ownership, shutdown races, and structured-output validation. PR #59 should not be merged until the P1 findings are resolved or explicitly accepted.

## P1 findings

### 1. Queued completions can cross an extension reload

**Location:** `src/notifications.ts`, `deliverNotification()` and `flushInProcessDeliveries()`.

The queue stores `ownerPi`, but flushing never compares it with the current Pi context. If an extension reload creates a new Pi context while retaining the same session ID, an old queued completion can be delivered through the new context.

**Observed behavior:** Pi A queues a completion with session ID `same`; Pi B replaces it with the same session ID; flushing sends the old completion to Pi B.

**Suggested direction:** Track a parent-context generation/identity, or use the captured Pi context as part of the delivery isolation check.

### 2. Queued completions can cross sessions when IDs are unavailable

**Location:** `src/notifications.ts:345-351`.

Delivery isolation is only applied when both `ownerSessionId` and `currentSessionId` are defined. During shutdown/startup transitions, the current session manager can be temporarily absent. Programmatic/direct spawns can also lack an owner session ID.

**Observed behavior:** A completion queued by the old context was dispatched through the replacement `__piSubagenturaPiRef` when the current session ID was unavailable.

**Suggested direction:** Drop or defer deliveries whose owner session is known but whose current session cannot be positively identified. Use captured parent context/generation as a fallback for entries without IDs.

### 3. Interactive state lock can be stolen by a slow owner

**Location:** `src/artifact.ts:1603-1636`, `withInteractiveStateLock()`.

The lock is considered stale solely from `mtimeMs` after 30 seconds. The owner does not renew the lease or use an ownership token. A second process can delete and recreate the lock while the first process is still inside its critical section. The first process then unconditionally removes the replacement lock in `finally`.

**Observed behavior:** A slow process held the lock for more than 30 seconds; a second process reclaimed it; the first process later removed the second process's lock and state entries were lost.

**Suggested direction:** Use an OS-held lock or an owner token/fencing mechanism with compare-before-delete. Add a slow-owner contention regression test.

### 4. Async spawn can escape `session_shutdown`

**Location:** `src/tools/in-process.ts:310-364`, `src/tools/in-process.ts:504-558`, `src/session-handlers.ts`.

The tool awaits `startSubagentJob()` before inserting the returned job into `jobRegistry`. If shutdown occurs during that await, shutdown clears the registry; when the await resolves, the tool can insert a new job afterward. That job is not tied to shutdown and may continue running in the replacement session.

**Suggested direction:** Register the job before the await, or add a shutdown generation/token check before insertion and abort/discard jobs created under the old session.

### 5. Process-mode structured output cannot return scalar JSON values

**Location:** `src/workflow-core.ts:extractJson()`, `src/workflow-worker.ts:runAgentCall()`.

`extractJson()` searches only for `{` and `[`. The documented schema/types allow strings, numbers, integers, booleans, and null. With default process isolation, outputs such as `5`, `true`, or `"ok"` are treated as missing JSON, retried, and ultimately returned as `null`.

**Suggested direction:** Support scalar JSON extraction safely, or explicitly restrict the documented schema contract to objects and arrays.

### 6. Unsupported schemas can silently disable validation

**Location:** `src/workflow-core.ts:validateSchema()` and `matchesType()`; `src/workflow-worker.ts:runAgentCall()`.

Unsupported schema values and unknown type strings can result in an empty validation-error list. For example, `{ type: "bogus" }` may accept arbitrary parsed output.

**Suggested direction:** Validate the schema itself before spawning/retrying and reject unsupported keywords, types, and schema shapes.

## P2 findings

### 7. Rehydration admits persisted entries when the current session ID is unknown

**Location:** `src/rehydrate.ts:46`, `rehydrateInteractiveSubagents()`.

The session filter only runs when `currentSessionId` is truthy. A persisted entry with an old `parentSessionId` can therefore be rehydrated when startup/reload has no current session ID.

**Suggested direction:** Only admit entries with persisted ownership when the current identity is positively known and matches. Allow the no-filter path only for legacy entries with no owner session.

### 8. Session-log partial-line cursor is not restart-safe

**Location:** `src/artifact-poller.ts:368-399`, `src/artifact-poller.ts:473-479`, `src/rehydrate.ts:93-95`.

The poller advances and persists the session byte cursor for bytes fed to an in-memory NDJSON parser. After reload, the parser state is gone, but the cursor remains at the partial-line end. When the remainder is later appended, the new parser sees only the suffix and permanently loses the entry.

**Suggested direction:** Persist the start offset of an incomplete line or retain/reconstruct the partial bytes during rehydration.

### 9. Cancelled workflows can report permanently running agents

**Location:** `src/workflow-worker.ts:194-200`, `src/workflow-worker.ts:325-334`, `src/workflow-worker.ts:383-397`, `src/workflow-jobs.ts:129-148`.

Once `engine.closed` is set, later progress is discarded. If cancellation occurs while an agent is in flight, the workflow can become terminal while its snapshot still reports a nonzero `runningCount` and an agent record with `status: "running"`.

**Suggested direction:** On terminal cancellation, close/mark in-flight records and set the running count to zero, or omit live counts for terminal jobs.

### 10. `cancel_workflow` can return before process-agent cancellation snapshots

**Location:** `src/workflow-tool.ts:58-74`, `src/workflow-tool.ts:703-707`, `src/workflow-worker.ts:610-635`.

The workflow promise rejects immediately on worker cancellation. `cancel_workflow` therefore returns before the process-backed agent's polling loop notices the abort and records its cancellation snapshot. The intended grace period is bypassed by the already-settled workflow promise.

**Suggested direction:** Await both workflow settlement and bounded cancellation-receipt collection before returning the cancellation result.

### 11. VM-injected functions retain a constructor escape

**Location:** `src/workflow-script.mjs:makeGuardedDate()`, `makeGuardedMath()`, and `src/workflow-worker-thread.mjs` sandbox setup.

Injected host functions expose their constructors. A workflow can use `Date.constructor(...)` or `Math.max.constructor(...)` to create a function that accesses host state such as `process`.

The documentation says the VM is not a security boundary, so this is not an arbitrary-user-code vulnerability under the stated model. It does, however, contradict the apparent “no Node APIs”/guarded-function expectation and can expose host state to accidental workflow code.

**Suggested direction:** Recreate wrappers inside the VM, remove host function constructors, or explicitly document this exact limitation and rely on real process isolation for untrusted scripts.

### 12. Async workflow code can evade the VM evaluation timeout

**Location:** `src/workflow-worker-thread.mjs`, `runInNewContext()`; `src/workflow-worker.ts` wall timer.

The VM timeout covers initial evaluation but not asynchronous continuations. A script can return a pending Promise and then enter an infinite loop after an `await`, bypassing the per-evaluation timeout. The only remaining backstop is the long workflow wall timeout.

**Suggested direction:** Add cooperative async checks/yield limits or enforce a materially shorter process-level resource timeout. Add an explicit regression test for the resource-limit contract.

### 13. Workflow agents are not linked to the in-process orchestration tree

**Location:** `src/workflow-tool.ts`, `src/workflow-jobs.ts`, `src/tools/in-process.ts:930-936`, `src/helpers.ts:311-366`.

PR #58 tracks nested in-process jobs in `jobRegistry`. Background workflows use a separate `workflowJobRegistry` and do not read orchestration ownership context. If an in-process sub-agent starts a workflow, cancelling the parent does not necessarily cancel the workflow.

**Suggested direction:** Propagate orchestration ownership into workflow jobs, or explicitly document workflows as independent cancellation domains.

### 14. State replacement is not durable across power loss

**Location:** `src/artifact.ts:1640-1647`, `writeInteractiveStatesUnlocked()`.

The temporary file is atomically renamed, but neither the temporary file nor the containing directory is fsynced. A machine/filesystem crash after rename can lose the newly committed cursors, delivery intents, or receipts.

**Suggested direction:** If crash durability is required, fsync the file before rename and the containing directory after rename, with platform-specific handling.

### 15. Published-tarball smoke test is not a clean-install test

**Location:** `tests/published-tarball.test.ts:146-150`, `tests/published-tarball.test.ts:209-225`.

The smoke test extracts into the repository's `node_modules`, so dependencies can resolve from the development install. It does not reliably detect missing runtime dependencies in an isolated package install. Its local-import scan also misses `.mjs` imports and worker-thread URL loading.

**Suggested direction:** Test the packed tarball in a temporary clean project with a fresh install, and include `.mjs`/worker entry points in package validation.

## Low-priority findings

### 16. Workflow authoring contract is inconsistent

**Location:** `src/workflow-tool.ts:294`, `docs/workflows.md:20-24`, `tests/workflow.test.ts`.

The prompt and docs say the metadata export must be the first statement, while the parser accepts and tests helper declarations before `export const meta`.

**Suggested direction:** Either enforce first-statement placement or change the prompt/docs to say the metadata declaration must be top-level and static, not necessarily first.

### 17. `./workflow` package export behavior is ambiguous

**Location:** `package.json`, `types/workflow.d.ts`.

The package exposes `"./workflow"` with a types-only target and no runtime import target. Runtime imports fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

This is correct if the subpath is intentionally only for ambient authoring types. It is a defect if users are expected to import runtime workflow helpers from it.

**Suggested direction:** Clarify the types-only intent in documentation/tests, or add an appropriate runtime export.

## Review conclusion

The integration is structurally complete and its normal checks pass, but the findings above indicate that it is not yet merge-ready. The highest-priority fixes are:

1. Prevent cross-session/reload delivery leakage.
2. Make state-lock ownership safe under slow/crashed processes.
3. Close the shutdown race for async job registration.
4. Make schema validation and scalar structured output match the documented contract.
5. Correct cancellation state/snapshot reporting.
