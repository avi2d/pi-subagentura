# Interactive Subagent Supervisor Overlay Plan

## Status

Approved direction: **hybrid, phased implementation**.

- Pi provides the portable supervisor overlay.
- tmux/zellij continue to own durable interactive terminal sessions.
- Native tmux popup/zellij floating views are optional presentation capabilities, not lifecycle primitives.
- No implementation work should begin until PRs #60 and #61 are incorporated into the working base or their relevant changes are deliberately superseded.

## Goal

Add a keyboard-accessible supervisor that lets users:

- see all interactive subagents owned by the current root Pi session;
- inspect their status, activity, artifacts, and bounded terminal output;
- focus or attach to their tmux/zellij terminal;
- cancel one agent or an entire descendant subtree;
- view the recursive tree of interactive subagents spawned by other interactive subagents.

The supervisor must work consistently in Pi TUI sessions running in a plain terminal, tmux, or zellij.

## Non-goals

- Do not move artifact polling, completion delivery, or cancellation receipts into mux backends.
- Do not treat tmux popups or zellij floating panes as authoritative process handles.
- Do not inject descendant completions directly into the root parent session.
- Do not enable workflows or in-process subagents automatically inside interactive children.
- Do not promise custom overlay UI in Pi print, JSON, or RPC modes.

## Current State

The repository already provides:

- a `Multiplexer` interface for pane creation, liveness, input, close, and attach-command formatting;
- tmux and zellij implementations;
- an in-memory interactive-subagent registry;
- crash-safe persisted direct-parent state;
- artifact-backed lifecycle and immutable output snapshots;
- focus/attach command generation;
- cancellation with retained artifacts;
- a reusable overlay pattern in `src/workflow-tree-ui.ts`.

The main missing pieces are:

1. Child Pi processes currently call `registerChildProtocol()` and return before interactive tools and session handlers are registered.
2. No parent-agent/root-agent lineage is propagated or persisted.
3. The root process cannot discover registries owned by descendant Pi processes.
4. `Multiplexer` exposes focus as a formatted shell command rather than a structured operation.
5. There is no backend-neutral bounded pane-capture API.
6. There is no interactive-subagent supervisor UI.

## Architecture Decision

Keep three separate layers.

### 1. Supervisor/domain layer

Owns:

- lineage discovery;
- tree projection;
- status and artifact summaries;
- focus/view/cancel action coordination;
- depth and total-agent limits;
- descendant ownership rules.

This layer must not depend on tmux or zellij command syntax.

### 2. Multiplexer transport layer

Owns:

- durable pane/window/tab creation;
- liveness checks;
- sending text and keys;
- structured focus;
- bounded output capture;
- best-effort close;
- attach instructions;
- optional native presentation capabilities.

### 3. Presentation layer

The primary presentation is a Pi overlay created with `ctx.ui.custom(..., { overlay: true })`.

Optional later adapters may offer:

- a tmux popup viewer;
- a zellij floating-pane viewer;
- backend-specific output streaming.

These optional surfaces must read the same supervisor projection and must not own lifecycle state.

## Why Native Popup/Floating Cannot Be the Common Primitive

### tmux

A tmux popup is a transient client-local overlay running a command. It does not have a stable pane ID and cannot be rehydrated or managed like a durable pane. Viewing another pane requires capture/polling or a separate client convention.

### zellij

A zellij floating pane is a persistent, addressable pane. Hide/show behavior is largely tab-scoped, and its lifecycle differs materially from a tmux popup.

### Common denominator

Both backends can safely support:

- create;
- focus;
- liveness;
- send input;
- close;
- attach instructions;
- bounded output capture.

Popup/floating behavior therefore belongs behind optional capabilities.

## User Experience

### Entry points

- Command: `/subagents`
- Default shortcut: choose an unused key during implementation, with `ctrl+alt+a` or `ctrl+shift+a` as candidates.
- The command is the reliable fallback where a terminal cannot distinguish the chosen shortcut.
- While the overlay is focused, the component must handle the toggle shortcut itself because extension shortcuts normally route through the editor.

### Main tree

Each row should show:

- status icon and state;
- display name;
- short ID;
- mux backend;
- elapsed time;
- latest tool/activity summary;
- stale/orphan indicators when applicable.

Suggested controls:

| Key                  | Action                                                    |
| -------------------- | --------------------------------------------------------- |
| `↑` / `↓`, `j` / `k` | Select row                                                |
| `→`, `Enter`         | Expand or open details                                    |
| `←`                  | Collapse                                                  |
| `v`                  | View bounded artifact and terminal snapshot               |
| `f`                  | Focus the durable pane/window/tab                         |
| `a`                  | Show attach instructions when direct focus is unavailable |
| `x`                  | Cancel selected agent                                     |
| `X`                  | Cancel selected subtree after confirmation                |
| `r`                  | Refresh                                                   |
| `q`, `Esc`           | Close overlay without affecting agents                    |

Use `matchesKey()`/`Key` rather than raw escape-sequence comparisons.

### Detail view

A stacked detail overlay may show:

- task preview;
- full status and lineage path;
- model and thinking level when available;
- pane/window/tab/session identity;
- artifact and Pi session paths;
- recent lifecycle events;
- bounded latest output snapshot;
- bounded captured terminal viewport/scrollback;
- attach command.

Closing the detail view should return focus to the tree overlay.

## Recursive Lineage

### Child runtime

When `PI_SUBAGENTURA_CHILD=1`, register a minimal interactive runtime:

- child lifecycle protocol;
- message renderer needed for child-owned completion notifications;
- session handlers and artifact poller for direct descendants;
- interactive spawn/status/send/cancel/read tools;
- supervisor command and overlay;
- artifact cleanup/model listing only where required.

Do not register workflows or in-process spawning by default.

### Propagated identity

Launch scripts should propagate validated internal values such as:

- current interactive-agent ID;
- parent interactive-agent ID;
- root Pi session/tree ID;
- lineage-store path;
- current depth;
- configured maximum depth.

These values are internal. Do not expose them as model-controlled public tool parameters.

### Lineage store

Keep lineage separate from delivery/rehydration state.

Recommended layout:

```text
<session-root>/subagentura/trees/<root-hash>/
  root.json
  nodes/
    <agent-id>.json
```

Use one atomically-written node manifest per interactive agent to avoid shared-file append contention.

A node manifest should contain only bounded, validated routing and display metadata:

- schema version;
- agent ID;
- parent agent ID, if any;
- root tree/session identity;
- owner Pi session ID;
- name and bounded task preview;
- start time;
- target cwd;
- mux backend, pane ID, mux session, and window/tab name;
- artifact directory and child Pi session file.

Do not persist mutable child arrays. Derive children from parent IDs when projecting the tree.

### Bounds and validation

- Validate IDs before using them in paths.
- Hash or safely encode root session IDs used as directory names.
- Enforce path containment and reject symlink escapes.
- Cap manifest bytes, tree nodes, and traversal depth.
- Detect cycles and place malformed/orphaned nodes in a non-actionable bucket.
- Always retain zellij `muxSession`, because zellij pane IDs are session-scoped.
- Treat persisted pane IDs as stale until liveness has been checked.

### Delivery ownership

Each Pi process owns completion delivery for its direct interactive children.

The root supervisor may read descendant lineage and artifacts, but it must not:

- insert descendants into the root `interactiveSubagentRegistry`;
- advance descendant delivery cursors;
- enqueue descendant completion messages;
- reconcile descendant receipts against the root session.

Tree projection is read-only except for explicit user actions.

## Multiplexer API Plan

Preserve existing APIs and add structured operations.

Conceptual additions:

```ts
interface PaneCaptureOptions {
  scope: "viewport" | "scrollback";
  ansi?: boolean;
  maxBytes: number;
  maxLines: number;
}

interface MultiplexerCapabilities {
  capture: boolean;
  nativeOverlay: "transient" | "persistent" | false;
  streamOutput: boolean;
}

interface Multiplexer {
  // Existing create/liveness/send/close methods remain.
  focusPane(ref: PaneRef): void;
  capturePane(ref: PaneRef, options: PaneCaptureOptions): Promise<string>;
  capabilities(): MultiplexerCapabilities;
}
```

Use a structured `PaneRef` containing backend, pane ID, mux session, and optional window/tab identity. Do not parse `attachCommand` or `focusCommand` strings to perform actions.

### tmux implementation

- Focus with `select-window`/`select-pane` using stable IDs where possible.
- Capture with `capture-pane` and explicit bounds.
- Keep popup support optional and non-authoritative.

### zellij implementation

- Focus with `go-to-tab-name` or `focus-pane-id` within the recorded session.
- Capture with `dump-screen` and explicit bounds.
- Keep floating-pane support optional and account for tab-scoped visibility.

## Cancellation Semantics

### Single node

Cancel through the existing cancellation path where the current process owns the node. This retains artifacts and writes cancellation metadata.

For a descendant owned by another Pi process, use a dedicated supervisor action that:

- validates lineage and mux routing metadata;
- records a cancellation marker/event without claiming root delivery ownership;
- closes the pane best-effort;
- allows the direct owner to observe and deliver the cancellation.

### Subtree

- Resolve a stable snapshot of descendants.
- Cancel deepest nodes first.
- Continue after individual close failures.
- Report succeeded, already-terminal, stale, and failed nodes separately.
- Require user confirmation.
- Never interpret closing the supervisor overlay as subtree cancellation.

## Lifecycle and Overlay Rules

- Create a fresh component every time the overlay opens.
- Never reuse a disposed `OverlayHandle` or component.
- Clear refresh timers and terminal-input listeners in `dispose()` and `finally`.
- Close the overlay on `session_shutdown`.
- Do not preserve an open overlay across reload/resume; reopen it against rehydrated data.
- Do not use stale `ctx`, `pi`, or session-bound objects after replacement/reload.
- Refresh from the existing poller/event state instead of independently folding lifecycle logs in the UI.
- Bound every rendered line to the supplied width.

## Implementation Phases

### Phase 0: Base preparation

1. Incorporate PR #60 (`feat/only-interactive`).
2. Incorporate PR #61 (`fix/nested-session-footer`).
3. Resolve conflicts on a temporary integration branch if they are not yet merged.
4. Run the full verification suite before feature work.

Acceptance criteria:

- The combined base is clean and pushed.
- Existing delivery, cancellation, workflow, and interactive tests pass.
- Interactive-only registration behavior is covered before reuse in child mode.

### Phase 1: Flat portable supervisor

Likely files:

- new `src/interactive-supervisor-ui.ts`;
- new `src/interactive-supervisor-registration.ts`;
- `src/subagent.ts`;
- `src/session-handlers.ts`;
- `package.json`.

Tasks:

1. Add `/subagents` and a shortcut.
2. Build a centered tree/list overlay using direct registry states.
3. Add expand/collapse, status display, attach instructions, and existing cancel action.
4. Add refresh and complete overlay disposal.
5. Guard TUI-only behavior and provide clear non-TUI fallback messages.

Acceptance criteria:

- The overlay opens in plain terminal, tmux, and zellij Pi TUI sessions.
- Closing the overlay never closes an agent.
- Cancellation uses the existing cancellation flow.
- Reload/shutdown leaves no timer, listener, or stale handle.
- `/subagents` remains available if the shortcut is unsupported.

### Phase 2: Structured focus and capture

Likely files:

- `src/multiplexer.ts`;
- `src/multiplexer-tmux.ts`;
- `src/multiplexer-zellij.ts`;
- `src/interactive-tmux.ts` or a renamed mux-neutral orchestrator;
- `src/interactive-supervisor-ui.ts`.

Tasks:

1. Introduce `PaneRef` and capability metadata.
2. Add structured focus operations.
3. Add bounded asynchronous capture operations.
4. Add detail/artifact and terminal-snapshot views.
5. Keep attach-command generation backward compatible.

Acceptance criteria:

- The supervisor never parses generated shell commands.
- tmux and zellij focus tests cover background and split modes.
- Captured output is bounded by bytes and lines.
- Capture failures are displayed without closing the supervisor.

### Phase 3: Bounded recursive spawning and lineage

Likely files:

- new `src/interactive-lineage.ts`;
- `src/subagent.ts`;
- `src/interactive-tmux.ts`;
- `src/tools/interactive.ts`;
- `src/session-handlers.ts`;
- `src/rehydrate.ts` only if direct-state metadata needs adjustment;
- `package.json`.

Tasks:

1. Refactor registration into parent-full and child-interactive runtimes.
2. Propagate current/parent/root identity and depth in launch scripts.
3. Write atomic lineage manifests before exposing a child as running.
4. Build a bounded, cycle-safe tree projection.
5. Display orphaned or stale nodes without granting unsafe actions.
6. Keep descendant delivery state out of the root registry.

Acceptance criteria:

- An interactive child can spawn an interactive grandchild.
- The root overlay shows the correct hierarchy across differing child cwd values.
- Reload reconstructs the tree without duplicate completion delivery.
- Depth and total-node caps fail explicitly.
- Malformed or cyclic manifests cannot escape configured roots or hang traversal.

### Phase 4: Descendant and subtree actions

Likely files:

- `src/interactive-lineage.ts`;
- `src/interactive-supervisor-ui.ts`;
- `src/interactive-tmux.ts`;
- cancellation helpers and tests.

Tasks:

1. Focus and capture descendants from persisted routing metadata.
2. Implement descendant-safe cancellation.
3. Implement confirmed deepest-first subtree cancellation.
4. Summarize partial failures.

Acceptance criteria:

- Cancelling a descendant does not inject its completion into the root session.
- Subtree cancellation handles dead/stale panes idempotently.
- Artifacts remain readable after cancellation.
- One failing mux operation does not stop cancellation of remaining descendants.

### Phase 5: Optional native presentation

Likely files:

- optional supervisor CLI/view module;
- mux capability interfaces and backend implementations;
- integration tests.

Tasks:

1. Prototype a tmux transient popup viewer.
2. Prototype a zellij persistent floating-pane viewer.
3. Reuse the same supervisor tree projection.
4. Keep feature detection explicit and retain Pi overlay fallback.

Acceptance criteria:

- Unsupported backends degrade to the Pi overlay.
- Native view lifecycle cannot kill or orphan the durable child session accidentally.
- Native presentation does not become required for focus, capture, or cancellation.

## Test Plan

### New unit tests

- `tests/interactive-supervisor.test.ts`
  - rendering and width bounds;
  - navigation and expansion;
  - shortcut handling while focused;
  - close versus cancel semantics;
  - timer/listener disposal;
  - action error rendering.

- `tests/interactive-lineage.test.ts`
  - atomic node manifests;
  - parent/root projection;
  - differing cwd values;
  - deterministic ordering;
  - cycle, orphan, malformed, and stale handling;
  - node/depth/size limits;
  - path and symlink containment.

- `tests/child-recursion.test.ts`
  - child minimal-runtime registration;
  - environment identity propagation;
  - grandchild parent edge;
  - explicit cap failures;
  - no workflow/in-process tools by default.

### Extended tests

- `tests/multiplexer-tmux.test.ts`
  - structured focus;
  - bounded capture;
  - dead-pane errors;
  - attach strings unchanged.

- `tests/multiplexer-zellij.test.ts`
  - session-scoped structured focus;
  - bounded capture;
  - hidden/floating state behavior where applicable;
  - attach strings unchanged.

- `tests/subagent-rehydrate-core.test.ts`
  - direct ownership remains session-filtered;
  - descendants do not enter the root delivery registry.

- `tests/subagent-poll.test.ts`
  - no descendant delivery by root poller;
  - tree metadata survives terminal delivery cleanup.

- `tests/artifact-delivery.integration.test.ts`
  - recursive completion ownership;
  - no duplicate injection or receipt reconciliation.

- `tests/subagent-extension.test.ts`
  - parent-full versus child-interactive registration;
  - command and shortcut availability.

### Integration tests

- Extend `tests/tmux.integration.test.ts` for focus, capture, and two-level recursion.
- Add a zellij smoke/integration test where CI support is practical.
- Verify no orphan panes after lineage-write or launch failures.

## Risk Register

| Risk                                                    | Mitigation                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Child mode accidentally enables unbounded orchestration | Register only interactive tools and enforce depth/total caps                           |
| Root delivers descendant completion                     | Keep lineage projection separate from delivery registry and cursors                    |
| Schema downgrade breaks existing state                  | Use a separate versioned lineage schema; avoid unnecessary delivery-state version bump |
| Crash leaves invisible pane                             | Persist direct state and lineage before launch/registry exposure; kill on failure      |
| Stale/reused pane ID targets wrong zellij pane          | Retain session identity, verify liveness, validate expected metadata                   |
| Overlay leaks timers or stale contexts                  | Dispose timers/listeners, close on shutdown, recreate after reload                     |
| Shortcut unsupported or conflicts                       | Always provide `/subagents`; document/change default shortcut                          |
| Capture blocks Pi event loop                            | Use asynchronous commands with timeouts and strict output bounds                       |
| Native popup semantics diverge                          | Keep native views optional and capability-gated                                        |
| Subtree cancellation partially fails                    | Deepest-first best effort with per-node result reporting                               |
| Child-controlled metadata escapes roots                 | Strict schema, ID validation, realpath containment, symlink rejection, and size caps   |

## Required Verification

Run after each coherent phase and before committing:

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
```

For mux changes, also run targeted tests:

```bash
npm test -- tests/multiplexer-tmux.test.ts tests/multiplexer-zellij.test.ts
npm run test:tmux
```

## Delivery Strategy

Keep commits atomic and conventional. Suggested sequence:

1. `feat: add interactive subagent supervisor overlay`
2. `refactor: add structured multiplexer focus and capture`
3. `feat: add bounded interactive subagent lineage`
4. `feat: manage descendant interactive subagents`
5. `feat: add optional native mux supervisor views`

Each phase should be independently reviewable and should preserve existing artifact ordering, delivery ownership, and reload semantics.
