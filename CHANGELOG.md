# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.2] - 2026-07-17

### Added

- Per-agent `thinkingLevel` controls for synchronous, asynchronous, interactive, and workflow sub-agents.
- Foreground and global cancellation controls, including `ctrl+alt+x`, `/cancel-all-flows`, and abort-aware result waits.
- Default-off cancellation context snapshots with bounded private artifacts and workflow receipt reporting.
- Complete workflow usage accounting across nested agents, retries, failures, status, and completion notifications.

### Changed

- Pi peer compatibility now starts at `>=0.80.6` without blocking future releases; CI verifies both the minimum and latest SDKs.
- Interactive pane-liveness probes are asynchronous so slow mux commands do not block artifact polling.
- Triggering completions use Pi's native follow-up queue while non-triggering delivery preserves idle-only semantics.

### Fixed

- Workflow process agents recognize protocol-v2 completions for the current turn without reusing stale output.
- Completion delivery avoids stale streaming-state delays and duplicate queued follow-ups.
- Cancellation suppresses redundant completion notifications and reliably reports asynchronous snapshot receipts.

## [3.0.1] - 2026-07-16

### Added

- Added a `d` shortcut to delete the selected workflow from the `/workflows` picker.

## [3.0.0] - 2026-07-16

### Breaking

- **Async sub-agents default to inject.** `subagent_with_context` and `subagent_isolated` with `async: true` now default to `notifyOnComplete: "inject"`, delivering the job result into the parent conversation when complete. Pass `notifyOnComplete: "notify"` to restore UI-only completion hints with no model turn.

### Added

- Appendable parent-orchestrator guidance with routing defaults for scouting, planning, review loops, and oracle checks.
- Workflow tool modularization: split runtime into `workflow-core`, `workflow-worker`, `workflow-jobs`, `workflow-tool`, and `workflow-ui`.
- Workflow progress exposes `runningCount` and model visibility; workflow timeout aborts in-flight agents.
- CI coverage thresholds (`npm run coverage:check`) and branch preview release workflow.
- Extensive test coverage for rendering, schemas, and in-process tools.

### Fixed

- Poller skips duplicate inject when a late explicit `done` arrives after auto-done synthesis.
- Interactive sub-agent launch aborts and kills the pane when persisted state cannot be written.
- Workflow `runningCount` decremented on agent failure; timeout propagates abort to in-flight work.
- Shared workflow script parsing (`workflow-script.mjs`) used by main thread and worker thread.

[Unreleased]: https://github.com/lmn451/pi-subagentura/compare/v3.0.2...HEAD
[3.0.2]: https://github.com/lmn451/pi-subagentura/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/lmn451/pi-subagentura/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/lmn451/pi-subagentura/compare/v2.3.3...v3.0.0
