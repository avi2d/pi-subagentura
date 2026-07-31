# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.0] - 2026-07-31

### Fixed

- Concurrent parent sessions now keep in-process jobs, interactive sub-agents, delivery queues, streaming state, supervisor actions, and shutdown cleanup isolated by exact session generation.

### Added

- Structured workflow outputs with schema validation, reusable TypeScript declarations at `pi-subagentura/workflow`, immutable `cwd`, explicit phase metadata, and bounded workflow-tree agent records.
- Session-scoped ownership for background workflows, in-process jobs, interactive delivery, cancellation, status surfaces, and multi-owner artifact polling.
- npm release publishing to GitHub Packages alongside the public npm registry.

### Changed

- In-process sub-agent calls now run asynchronously by default; pass `async: false` for a single blocking call.
- `get_subagent_result` returns live state by default and supports explicit bounded waiting with `wait` and `timeoutMs`.
- Interactive pointer completions trigger a parent turn by default; set `triggerTurnOnComplete: false` to persist without waking the parent.

### Fixed

- Completion delivery and workflow notifications no longer cross parent-session, reload, nested-context, or stale-generation boundaries.
- Oversized and partial artifact/session records remain memory-bounded without silently losing completion identity or advancing stale cursors.
- Cancellation propagates through nested orchestration, drains workflow receipts, and suppresses late completion after parent shutdown.
- Published-tarball validation now checks runtime imports, worker assets, declared dependencies, and a clean production consumer install.

## [3.0.3] - 2026-07-19

### Added

- A first-class reusable-workflow guide, user-command reference, and agent-facing tool reference.
- Workflow examples and the bundled RALPLAN skill in the published npm tarball, guarded by parser, behavior, README-surface, and tarball regression tests.

### Changed

- README positioning now leads with parent-orchestrated workflows, bring-your-own agents and prompts, interactive child sessions, and reusable workflows.
- Package description and discovery keywords now cover interactive subagents, orchestration, workflows, tmux, and Zellij.
- Bundled workflow scripts now live under `examples/workflows/` with an index and usage guide.

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

- **Async sub-agents default to inject.** `subagent_with_context` and `subagent_isolated` with `async: true` now default to `notifyOnComplete: "inject"`, delivering the job result into the parent conversation when complete. Pass `notifyOnComplete: "notify"` to persist a pointer-only completion without injecting the full output.

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

[Unreleased]: https://github.com/lmn451/pi-subagentura/compare/v3.1.0...HEAD
[3.1.0]: https://github.com/lmn451/pi-subagentura/compare/v3.0.3...v3.1.0
[3.0.3]: https://github.com/lmn451/pi-subagentura/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/lmn451/pi-subagentura/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/lmn451/pi-subagentura/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/lmn451/pi-subagentura/compare/v2.3.3...v3.0.0
