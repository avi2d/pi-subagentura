# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/lmn451/pi-subagentura/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/lmn451/pi-subagentura/compare/v2.3.3...v3.0.0
