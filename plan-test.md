# End-to-End Terminal Visual Test Plan

## Status and decisions

- Worktree branch: `feat/visual-e2e-tests`
- Base commit: `62cb305`, from `feat/interactive-subagent-overlay`
- Primary strategy: run real Pi and `pi-subagentura` in an isolated tmux PTY.
- Automated terminal assertions are the regression-test source of truth.
- The same deterministic scenarios should also support optional WezTerm recordings.
- All parent and child model responses must come from a scripted provider. No real LLM or HTTP calls are allowed.
- Test processes must not inherit real provider credentials, and a test-only Node preload must reject outbound network APIs.
- Current visible-pane capture is authoritative for screen-state assertions; scrollback is diagnostics only.
- Process-backed workflow and interactive panes remain inspectable through each scenario and are cleaned up only by suite teardown.
- WezTerm is a presentation/recording layer, not a required CI dependency.

## Goal

Exercise the actual Pi TUI, extension registration, tool execution, custom rendering, async notifications, workflow progress, multiplexer integration, and keyboard interaction in a real terminal. Cover these user-visible paths:

1. Synchronous `subagent_with_context`.
2. Synchronous and asynchronous `subagent_isolated`.
3. Synchronous and background workflows.
4. Interactive tmux-backed subagents, including their child Pi session and completion delivery.
5. Async-subagent supervisor UI and important cancellation/error states.

The result should provide both:

- deterministic automated assertions over terminal output; and
- repeatable human-viewable sessions that can be recorded and replayed in WezTerm.

## Non-goals for the first iteration

- Pixel-perfect screenshots as the main CI assertion.
- Testing a real model provider or network stack.
- Making WezTerm GUI availability a CI requirement.
- Testing every terminal emulator or every Pi theme.
- Replacing existing unit, integration, rendering, or protocol tests.

## Existing useful context

### Deterministic Pi provider/session harness

`tests/helpers/pi-session-harness.ts` already demonstrates the core no-network provider technique:

- creates a Pi session runtime;
- registers a faux provider with `streamSimple`;
- uses `createAssistantMessageEventStream()`;
- controls when a response completes or fails; and
- records provider contexts for assertions.

`tests/pi-session-delivery.integration.test.ts` uses that harness to verify notification and provider-turn behavior. The new terminal tests should reuse the same concepts but launch the real Pi CLI in a PTY instead of only exercising the SDK session.

### Existing real tmux integration harness

`tests/tmux.integration.test.ts` already demonstrates:

- a dedicated tmux server/socket;
- a temporary fake `pi` executable;
- isolated environment and session directories;
- interactive subagent launch and follow-up delivery;
- pane output capture;
- cancellation; and
- cleanup of the complete tmux server.

The terminal E2E harness should combine this isolated tmux setup with a real Pi process and scripted provider.

### Production rendering and UI entry points

Important files to inspect while implementing scenarios:

- `src/rendering.ts`
- `src/workflow-ui.ts`
- `src/workflow-tree-ui.ts`
- `src/workflow-tool.ts`
- `src/interactive-supervisor-ui.ts`
- `src/interactive-supervisor-registration.ts`
- `src/tools/in-process.ts`
- `src/tools/interactive.ts`
- `src/helpers.ts`
- `src/pi-sdk-compat.ts`
- `src/artifact-poller.ts`
- `src/delivery.ts`
- `src/child-protocol.ts`
- `src/interactive-tmux.ts`
- `src/multiplexer-tmux.ts`

Existing rendering-focused tests include:

- `tests/rendering.test.ts`
- `tests/workflow-tree-ui.test.ts`
- `tests/interactive-supervisor.test.ts`

### Relevant Pi documentation

Use the documentation from the installed Pi package:

- `node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/terminal-setup.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/tmux.md`

Useful APIs and behavior:

- `pi.registerProvider()` can register a complete deterministic `streamSimple` implementation.
- `createAssistantMessageEventStream()` emits text, thinking, tool-call, completion, and error events without HTTP.
- `PI_TUI_WRITE_LOG` captures the raw ANSI stream when style-level debugging is needed.
- Pi supports real TUI rendering only in interactive mode; RPC/JSON/print modes are not substitutes for this test.

## Proposed architecture

```text
Scenario definition
      |
      v
Scripted mock provider extension
      |
      v
Real Pi CLI + real src/subagent.ts
      |
      v
Dedicated tmux server and fixed-size PTY
      |                         |
      v                         v
tmux capture-pane         WezTerm attach/record
      |                         |
      v                         v
Automated assertions       Human visual review
```

### Why tmux is the automation boundary

- It provides a real PTY and terminal screen model.
- It runs headlessly in CI.
- It supports deterministic pane dimensions and text capture.
- It is already required and exercised by interactive-subagent integration tests.
- WezTerm can display the same tmux session without becoming an automation dependency.

## Test-only scripted provider

Create a Pi extension such as `tests/terminal-e2e/fixtures/mock-provider.ts`.

It should:

1. Register provider `subagentura-e2e` and model `mock`. Set the same custom API identifier, such as `api: "subagentura-e2e"`, on both the provider configuration and model definition.
2. Use a fake API key and a non-routable `.invalid` base URL.
3. Supply `streamSimple`, so no transport implementation is called.
4. Route each request from the most recent actionable context entry and an exact scenario/task marker, not fuzzy matching or the first matching marker anywhere in accumulated history.
5. Emit stable tool-call IDs, output content, and usage values.
6. Avoid writing anything to terminal stdout/stderr.
7. Write diagnostic events to a temporary JSONL file when `SUBAGENTURA_E2E_LOG` is set. Each event should include PID, provider, model, selected marker, state-machine stage, and request sequence.
8. Fail explicitly on an unrecognized request, provider, model, or state transition so an accidental path cannot silently pass.
9. Honor abort signals while waiting on gates.

Suggested top-level markers:

```text
[E2E:SYNC_CONTEXT]
[E2E:SYNC_ISOLATED]
[E2E:ASYNC_ISOLATED]
[E2E:WORKFLOW_SYNC]
[E2E:WORKFLOW_ASYNC]
[E2E:WORKFLOW_PROCESS]
[E2E:INTERACTIVE]
[E2E:CANCEL]
[E2E:ERROR]
```

Child tasks should use distinct markers such as `[E2E:CHILD_SYNC_CONTEXT]` and `[E2E:CHILD_WORKFLOW_PROCESS]`. Because prior markers remain in conversation history, the router must derive the next transition from the newest user/custom/tool-result messages rather than testing whether a marker appears anywhere in the context.

### Provider state-machine behavior

For a normal parent scenario:

1. The first parent request emits one scripted tool call.
2. The selected tool starts its child session or workflow.
3. Child requests are recognized by their exact child-task marker and return deterministic output.
4. The parent receives the tool result.
5. The next parent request emits a stable final assistant response.

For asynchronous scenarios:

1. The parent emits the async tool call.
2. The tool returns its started/job state.
3. The parent emits a stable response and becomes idle.
4. The child remains behind a controllable gate long enough to inspect running UI.
5. Releasing the gate completes the child and exercises notification delivery.
6. The provider asserts the exact number and order of subsequent parent requests.
7. Non-triggering async-subagent and interactive baselines expect no automatic parent request.
8. Background workflows always enqueue a triggering follow-up in the current production implementation, so their state machine must handle exactly one deterministic completion follow-up.
9. Triggering variants handle exactly one additional parent request and then become idle.

### Deterministic gates

Do not make test correctness depend on arbitrary sleeps. Use a temporary gate directory, for example:

```text
$SUBAGENTURA_E2E_GATE_DIR/release-async-isolated
$SUBAGENTURA_E2E_GATE_DIR/release-workflow
$SUBAGENTURA_E2E_GATE_DIR/release-interactive
```

The provider can stream a stable initial update and wait for the relevant gate file. The harness waits for a current-screen or provider-log predicate, captures/asserts the running state, creates the gate file, and then waits for the final state.

Short polling intervals are acceptable inside the harness, but every wait must have a timeout and a useful failure message containing the current visible screen, diagnostic scrollback, provider log, and relevant artifact events. Interactive notification waits must allow at least one full production artifact-poller interval of five seconds plus startup/rendering margin. Use a 60-second Vitest timeout for each terminal E2E test while retaining tighter per-predicate timeouts.

## Interactive child Pi process

In-process children can use the provider copied from the parent model registry by `startSubagentJob()` and `copyProviderConfig()`.

Interactive subagents and process-isolated workflow agents are separate `pi` processes. They therefore need a test-only `pi` wrapper placed first in `PATH`. The wrapper should call the known real Pi executable with only the required explicit extensions:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec "$SUBAGENTURA_E2E_REAL_PI" \
  --offline \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e "$SUBAGENTURA_E2E_REPO/src/subagent.ts" \
  -e "$SUBAGENTURA_E2E_REPO/tests/terminal-e2e/fixtures/mock-provider.ts" \
  "$@"
```

The parent harness should launch the real Pi executable directly, while child processes resolve `pi` through this wrapper. The wrapper must inherit the sanitized test environment and network-denial preload.

The scripted interactive-child response should exercise the real completion contract instead of merely exiting. It should emit a tool call that writes deterministic content to `$ARTIFACT_DIR/output.md`, invokes `$ARTIFACT_DIR/cli.mjs done 0`, waits for success, and then returns a final assistant response. The child protocol remains responsible for lifecycle events and completion deduplication.

An explicit completion event is not proof that the child is idle because it is written before the final assistant response settles. Before sending a follow-up, wait for provider-log evidence that the child response ended and for the child TUI to return to its idle editor state.

Pass `model: "subagentura-e2e/mock"` in every interactive tool call and every process-isolated workflow `agent()` call. Process-isolated workflow agents do not inherit the parent model automatically.

## Terminal harness

Proposed helper responsibilities:

- allocate a unique tmux socket name and a temporary tmux configuration for every test;
- detect the tmux version, enable `extended-keys`, and use `extended-keys-format csi-u` when tmux is 3.5 or newer;
- create temporary home, agent, session, workspace, artifact, gate, log, and wrapper directories;
- build a sanitized child environment that removes all provider credential variables documented by the installed Pi version, including cloud-provider fallback credentials;
- install a test-only Node preload that throws on `fetch`, WebSocket, `http`, `https`, `http2`, `net`, `tls`, `dgram`, and DNS outbound connection attempts;
- launch a fixed-size parent pane, initially `100x32`;
- send literal text and explicit key sequences;
- capture the current visible pane separately from diagnostic scrollback;
- find child panes/windows from structured tmux metadata;
- wait for screen, idle, artifact, event, or provider-log predicates;
- normalize unstable values;
- include current screen, scrollback, provider log, artifact events, pane metadata, and process IDs in timeout diagnostics;
- track pane process groups and detached descendants whose command paths remain under the unique harness root; and
- during suite teardown, terminate Pi, kill every dedicated tmux server, wait for tracked processes to exit, force-kill stragglers, verify each server is gone, and remove temporary files. Process-level exit and signal handlers provide emergency cleanup when normal suite teardown is interrupted.

Successful process-backed workflow and interactive panes are intentionally retained for inspection until suite teardown. Individual scenario assertions must not require automatic pane cleanup.

### Isolated tmux configuration

Do not read the developer's `~/.tmux.conf`. Generate a temporary config containing at least:

```tmux
set -g extended-keys on
# Add only when tmux >= 3.5:
set -g extended-keys-format csi-u
```

Start the dedicated server with `tmux -f "$tmux_config" -L "$socket" new-session ...`. Subsequent commands use the same `-L` socket. Open the supervisor through `/subagents` for the portable baseline; exercise `ctrl+alt+a` separately only when the configured tmux version/key mode supports the expected sequence.

### Network and credential isolation

`--offline` disables Pi startup network operations; it does not block model-provider inference. Before starting parent Pi, remove all real provider API-key/token/profile variables from the environment. Load `tests/terminal-e2e/fixtures/deny-network.cjs` through `NODE_OPTIONS=--require=...` in parent and child Pi processes so any accidental transport call throws immediately and appears in diagnostics.

Conceptual launch environment:

```bash
HOME=<temporary-home>
PI_OFFLINE=1
PI_CODING_AGENT_DIR=<temporary-agent-dir>
PI_CODING_AGENT_SESSION_DIR=<temporary-session-dir>
PI_SUBAGENTURA_TMUX_SOCKET=<unique-socket>
SUBAGENTURA_E2E_GATE_DIR=<temporary-gates>
SUBAGENTURA_E2E_LOG=<temporary-provider-log>
SUBAGENTURA_E2E_REAL_PI=<absolute-real-pi-path>
SUBAGENTURA_E2E_REPO=<absolute-repo-path>
NODE_OPTIONS=--require=<absolute-deny-network.cjs>
PATH=<wrapper-bin>:<sanitized-original-path>
TERM=xterm-256color
```

Conceptual parent command:

```bash
"$SUBAGENTURA_E2E_REAL_PI" \
  --offline \
  --approve \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e "$SUBAGENTURA_E2E_REPO/src/subagent.ts" \
  -e "$SUBAGENTURA_E2E_REPO/tests/terminal-e2e/fixtures/mock-provider.ts" \
  --model subagentura-e2e/mock
```

Use a temporary session directory rather than the developer's normal Pi state. Keeping sessions enabled is useful for inspecting custom messages, child session files, and artifact-backed delivery.

### Static test UI settings

The mock/test extension should make moving UI elements deterministic where practical:

- set a static working indicator such as `●`;
- use fixed working text;
- avoid notifications unrelated to the scenario;
- use a fixed terminal size;
- avoid startup network/version checks through offline mode; and
- run terminal scenarios against both the minimum and latest supported Pi SDK matrix entries when CI integration is enabled.

Do not patch production randomness merely to stabilize tests. Normalize generated IDs instead.

## Automated capture and assertions

Basic tmux operations:

```bash
# First command starts the isolated server with the generated config.
tmux -f "$tmux_config" -L "$socket" new-session -d -x 100 -y 32 ...
tmux -L "$socket" send-keys -t "$pane" -l -- "$input"
tmux -L "$socket" send-keys -t "$pane" Enter

# Authoritative current visible screen for predicates/assertions.
tmux -L "$socket" capture-pane -p -t "$pane"

# Full history only for timeout/failure diagnostics.
tmux -L "$socket" capture-pane -p -S - -t "$pane"
```

### Assertion strategy

Use provider/artifact predicates to establish that a transition occurred, then assert the current visible screen. Never let a settled-state predicate pass solely because matching text remains in scrollback from an earlier state.

Prefer semantic assertions and ordering over full-screen golden snapshots. Assert text such as:

- `subagent_with_context`
- `subagent_isolated`
- `Sub-agent working`
- `Sub-agent started`
- `Interactive sub-agent`
- `● workflow`
- `◆ phase:`
- `→ started`
- `→ done`
- expected completion-delivery wording
- expected deterministic child and parent output

Normalize or pattern-match:

- in-process job IDs;
- eight-character interactive-subagent IDs;
- workflow IDs;
- tmux pane IDs;
- absolute temporary paths;
- session files;
- elapsed times;
- timestamps; and
- token/model footer values that are intentionally version-dependent.

Use complete screen snapshots only for a small number of stable, settled states. Avoid golden snapshots of animated frames or the complete ANSI write log.

When color/style debugging is needed:

- use `tmux capture-pane -e` where supported;
- use `PI_TUI_WRITE_LOG` for raw Pi output; or
- use `wezterm cli get-text --escapes` during manual visual review.

## Scenario matrix

### 1. Synchronous context subagent

Parent scripted tool call:

```json
{
  "name": "subagent_with_context",
  "arguments": {
    "task": "[E2E:CHILD_SYNC_CONTEXT] Return the inherited-context fixture.",
    "async": false
  }
}
```

Assertions:

- call row includes `subagent_with_context`;
- running state becomes visible while the child gate is closed;
- child output preview appears;
- final tool result uses success rendering and usage summary;
- final parent response appears; and
- provider log confirms that child context contained the parent conversation marker.

### 2. Synchronous isolated subagent

Assertions:

- call row includes `subagent_isolated`;
- running and final states render correctly;
- child receives its task but not the parent conversation marker; and
- final parent response appears.

### 3. Asynchronous isolated subagent

Use `notifyOnComplete: "notify"` and `triggerTurnOnComplete: false` first to keep the flow easy to inspect.

Assertions:

- initial tool result shows the job-started state;
- parent becomes idle while the child remains running;
- footer/supervisor reflects the active child;
- releasing the gate produces one completion notification;
- no unexpected parent provider turn starts; and
- status/result tools can inspect the same job.

Add an `inject` plus triggering variant after the baseline is stable.

### 4. Synchronous workflow

First workflow should explicitly use `isolation: "in-process"` so workflow rendering is tested independently of mux-backed child startup.

Assertions:

- workflow phase is rendered;
- agent-start and agent-done progress rows appear;
- deterministic token/usage summary appears;
- final workflow result appears; and
- the parent produces its final response.

### 5. Background workflow

The current background-workflow completion path always enqueues a parent follow-up with `triggerTurn: true`. The provider state machine must script that request explicitly rather than treating it as an optional variant.

Assertions:

- workflow-started result includes a workflow ID;
- an explicit later parent request calls `get_workflow_status` while the provider gate is closed;
- completion notification appears once after the gate is released;
- exactly one automatic parent provider request follows the completion notification;
- that request produces a stable response and the parent returns to idle;
- a later explicit request to `get_workflow_result` agrees with the recorded status/result; and
- supervisor/tree UI can show the workflow where applicable.

### 6. Process-isolated workflow

After in-process workflow coverage is stable, exercise default process isolation through the dedicated tmux server. Every process agent must select the scripted model explicitly, for example:

```javascript
const result = await agent(
  "[E2E:CHILD_WORKFLOW_PROCESS] Return the process fixture.",
  {
    label: "process-worker",
    model: "subagentura-e2e/mock",
  },
);
return result;
```

Assertions:

- worker pane/window is created;
- worker resolves `pi` through the scripted provider wrapper;
- provider diagnostics show only `subagentura-e2e/mock`;
- progress reaches the parent;
- completion output is deterministic;
- the completed worker pane remains alive and attachable for inspection through the end of the scenario; and
- suite teardown, not workflow completion, removes all worker panes and processes.

### 7. Interactive subagent

Automated baseline:

- launch with `background: true`, `model: "subagentura-e2e/mock"`, `notifyOnComplete: "notify"`, and `triggerTurnOnComplete: false`;
- assert the compact parent result row;
- find and capture the child pane separately;
- verify child session and artifact files;
- release the child provider gate;
- verify exactly one completion event and parent notification;
- verify no automatic parent provider turn starts;
- wait for provider-log and child-screen evidence that the child is idle;
- send one follow-up message to the same child session; and
- assert the follow-up creates a distinct child turn and completion snapshot.

Add a triggering interactive variant only after the non-triggering baseline is stable; its provider state machine must expect exactly one automatic parent request.

Human recording variant:

- run the parent inside the dedicated tmux session;
- launch with `background: false` so the child appears as a visible split in WezTerm;
- show the child completing and the parent receiving its notification; and
- retain both panes until the demo exits and suite/demo teardown kills the dedicated server.

### 8. Supervisor overlay

Open the async-subagent supervisor with `/subagents` after spawning controlled async and interactive jobs. This command-based baseline avoids making overlay coverage depend on terminal modifier encoding.

Assertions:

- overlay title and active records appear;
- selection/navigation keys work;
- details show the expected type, status, model, and task;
- cancellation updates the record and closes/refreshes cleanly; and
- Escape returns focus to the editor.

Add focused `ctrl+alt+a` shortcut coverage only under the isolated extended-key tmux configuration. Record the tmux version and key mode in failure diagnostics, and skip or separate this assertion when the installed tmux cannot forward the required sequence reliably.

### 9. Error and cancellation

Add focused scenarios for:

- child provider failure;
- synchronous tool cancellation;
- async cancellation;
- interactive pane cancellation; and
- workflow partial failure.

Verify error/cancelled rendering and retained artifact/snapshot wording without depending on exact temporary paths.

## WezTerm demo and recording path

The same scenario definitions should be runnable through a human-facing demo script. The demo script should:

1. create a dedicated tmux server;
2. launch the deterministic parent Pi session;
3. schedule scripted input and gate releases;
4. attach the current terminal to the tmux session; and
5. clean up after Pi exits.

Example usage:

```bash
./tests/terminal-e2e/demo.sh sync-context
./tests/terminal-e2e/demo.sh async-isolated
./tests/terminal-e2e/demo.sh workflow
./tests/terminal-e2e/demo.sh interactive
```

WezTerm can record the terminal stream as an asciicast, and the local recording wrapper converts it to VP9 WebM with `agg` and `ffmpeg`:

```bash
npm run record:tui -- interactive
# Optional explicit output path:
npm run record:tui -- workflow "$PWD/terminal-e2e-recordings/workflow.webm"
```

The command requires `wezterm`, `agg`, and an `ffmpeg` build with `libvpx-vp9`. It keeps intermediate cast/GIF files temporary and writes only the final WebM. Direct cast recording and replay remain available:

The recording path uses `cinematic-demo.mjs`: it types the prompt character by character, displays high-contrast step captions, pauses at deterministic provider stages, opens and expands the supervisor, then closes and detaches automatically. The normal `demo:tui` command remains manually controlled.

```bash
wezterm record --cwd "$PWD" -- bash ./tests/terminal-e2e/demo.sh interactive
wezterm replay <generated-cast-file>
```

A visible WezTerm pane can also be driven with:

```bash
wezterm cli spawn
wezterm cli send-text
wezterm cli get-text
wezterm cli get-text --escapes
```

Generated WebM files remain local review/demo artifacts under `terminal-e2e-recordings/`; they are ignored by Git and are not CI assertions.

## Implemented file layout

```text
tests/terminal-e2e/
  fixtures/
    deny-network.cjs
    mock-provider.ts
    pi-child-wrapper.sh
  harness.mjs
  harness.d.mts
  scenarios.mjs
  scenarios.d.mts
  provider-contract.test.ts
  network-guard.test.ts
  harness-contract.test.ts
  terminal.test.ts
  cinematic-demo.mjs
  demo.mjs
  demo.sh
  record-webm.sh
```

The harness generates the version-appropriate temporary tmux configuration at runtime.

Package scripts:

```json
{
  "test": "vitest run --exclude tests/tmux.integration.test.ts --exclude 'tests/terminal-e2e/**'",
  "test:unit": "vitest run --exclude tests/tmux.integration.test.ts --exclude tests/pi-session-delivery.integration.test.ts --exclude 'tests/terminal-e2e/**'",
  "coverage:check": "vitest run --coverage --exclude tests/tmux.integration.test.ts --exclude 'tests/terminal-e2e/**'",
  "test:tui": "vitest run --testTimeout=60000 tests/terminal-e2e/provider-contract.test.ts tests/terminal-e2e/network-guard.test.ts tests/terminal-e2e/harness-contract.test.ts tests/terminal-e2e/terminal.test.ts",
  "demo:tui": "bash tests/terminal-e2e/demo.sh",
  "record:tui": "bash tests/terminal-e2e/record-webm.sh"
}
```

Keep tmux-dependent tests excluded from normal `npm test`, `test:unit`, and `coverage:check`, consistent with the current `test:tmux` split. Run `test:tui` only in an explicitly provisioned local or CI environment.

## Implementation phases

### Phase 1: PTY harness foundation

Deliver:

- isolated tmux server and generated version-aware tmux config;
- temporary home, Pi configuration/session, and workspace directories;
- sanitized provider-credential environment and Node network-denial preload;
- real Pi startup and clean shutdown;
- current-screen, scrollback, input, wait, normalization, process-tracking, and diagnostics helpers; and
- one smoke test proving the real TUI reaches an idle prompt.

Acceptance criteria:

- test cannot read/write normal user Pi state or inherit real provider credentials;
- any attempted outbound Node network connection fails immediately with a diagnostic error;
- test times out with useful diagnostics rather than hanging;
- assertions use current visible-screen capture rather than stale scrollback;
- tmux server and temporary files are always removed during suite teardown;
- tracked pane processes have exited after teardown; and
- no model-provider transport request occurs.

### Phase 2: Scripted provider

Deliver:

- custom provider extension with matching provider/model `api` identifiers;
- stable text and tool-call event helpers;
- newest-message-based scenario routing and transition validation;
- provider JSONL diagnostics; and
- abort-aware deterministic gates.

Acceptance criteria:

- unknown requests and invalid transitions fail visibly;
- all model calls use `subagentura-e2e/mock`;
- process-isolated agents select the mock model explicitly;
- no HTTP transport is invoked and the network guard records no attempt; and
- streamed and final states can be controlled independently.

### Phase 3: Sync in-process subagents

Deliver synchronous context and isolated scenarios.

Acceptance criteria:

- running and settled rendering are both observed;
- context inheritance difference is proven in the provider log; and
- parent continuation after tool completion is deterministic.

### Phase 4: Async in-process subagent and supervisor

Deliver async spawn, idle completion notification, status/result inspection, and overlay coverage. Open the baseline overlay with `/subagents`; add shortcut coverage only under a supported isolated tmux key configuration.

Acceptance criteria:

- exactly one completion is delivered;
- triggering and non-triggering modes produce the explicitly scripted number of parent turns;
- supervisor command navigation works in the real TUI; and
- shortcut behavior is tested separately with tmux version/key-mode diagnostics.

### Phase 5: Workflows

Deliver synchronous in-process workflow first, then background and process-isolated variants. Every process-isolated `agent()` call must pass `model: "subagentura-e2e/mock"`.

Acceptance criteria:

- phase/start/done progress is observable;
- final counts and result are deterministic;
- background completion produces exactly one scripted automatic parent follow-up;
- process workers remain inside the isolated tmux server and stay inspectable after completion; and
- all process workers are removed only by suite teardown.

### Phase 6: Interactive child

Deliver child wrapper, artifact completion, parent delivery, child-pane capture, idle detection, and a follow-up turn.

Acceptance criteria:

- child uses real Pi plus the test extensions and explicit mock model;
- `output.md` and protocol-v2 completion events are produced;
- no duplicate completion is delivered;
- follow-up input is sent only after child response settlement/idle evidence;
- follow-up produces a distinct turn and immutable snapshot; and
- panes remain available during the scenario and are bounded and cleaned up only by suite teardown.

### Phase 7: WezTerm demo/recording

Deliver scenario selection and a documented recording command.

Acceptance criteria:

- the automated and recorded versions use the same provider and scenario definitions;
- recordings require no API credentials;
- the network-denial preload remains active; and
- interactive split behavior is visible when requested.

### Phase 8: CI integration and hardening

Deliver a dedicated CI step or documented optional job after local stability is proven. When enabled, run it in both the minimum and latest supported Pi SDK matrix entries.

Acceptance criteria:

- normal `test`, `test:unit`, and `coverage:check` scripts exclude terminal E2E tests;
- tmux version and generated configuration are explicit in logs;
- failures upload or print normalized current screen, scrollback, provider, artifact, pane, and process diagnostics;
- tests are non-flaky over repeated runs;
- suite teardown proves the dedicated server and tracked pane processes are gone; and
- the normal package verification commands continue to pass.

## Verification commands during implementation

Run focused tests while building:

```bash
npm run test:tui
npm run test:tmux
```

Before committing completed implementation, run the repository-required checks:

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
```

Also run the visual suite repeatedly to detect race conditions:

```bash
for i in 1 2 3 4 5; do npm run test:tui || exit 1; done
```

## Risks and mitigations

### Random IDs and timestamps

Mitigation: pattern-match or normalize them. Do not weaken production randomness.

### Animated spinner and transient rendering

Mitigation: use a static test working indicator and provider gates. Capture meaningful controlled states rather than arbitrary frames.

### Pi/theme/version rendering changes

Mitigation: exercise the minimum and latest supported Pi SDKs, fix viewport dimensions, prefer semantic assertions, and keep full snapshots few and intentional. Normalize only values that are intentionally version-dependent.

### Accidental access to user configuration or credentials

Mitigation: temporary `HOME`, `PI_CODING_AGENT_DIR`, and session directories; `--no-extensions`; explicit test extensions; disabled skills/themes/prompts/context files; removal of provider credential environment variables; fake provider auth; offline startup; and a fail-closed Node network preload.

### Interactive or workflow child uses the wrong Pi/provider

Mitigation: resolve the parent real Pi path before prepending the wrapper to `PATH`; pass `model: "subagentura-e2e/mock"` to every interactive and process-workflow spawn; log provider/model on every request; reject mismatches; and keep the network guard active.

### Child pane leaks into the developer's tmux server

Mitigation: unique `PI_SUBAGENTURA_TMUX_SOCKET`, generated isolated tmux config, dedicated server, and unconditional suite-teardown `tmux -L <socket> kill-server`. Successful panes intentionally remain alive only until that teardown. Track pane PIDs/process groups, wait for exit, force-kill stragglers, and verify the dedicated server no longer exists.

### Tests depend on sleeps or poll too quickly

Mitigation: current-screen/artifact/provider-log predicates plus provider-controlled release gates and bounded polling. Allow at least one five-second artifact-poller interval plus margin for interactive delivery, use a 60-second per-test timeout, and print all diagnostics on timeout.

### Scrollback satisfies a stale state predicate

Mitigation: use current visible-pane capture for assertions and retain `capture-pane -S -` output only for diagnostics. Establish transitions with provider or artifact evidence before checking the screen.

### Full ANSI snapshots are brittle

Mitigation: use plain-text semantic assertions by default. Reserve raw ANSI logs and `--escapes` capture for focused style diagnostics.

### Native PTY dependency complexity

Mitigation: use the existing tmux executable approach rather than adding `node-pty` unless tmux proves insufficient.

## Deferred decisions

These can be decided after the first smoke and sync-subagent scenarios work:

1. Whether any settled screens deserve complete golden snapshots.
2. Whether terminal E2E runs on every CI push or in a separate optional/platform job.
3. Whether asciicast recordings are committed, generated only for releases, or kept local.
4. Whether to add Linux-only network namespace blocking as a second no-network safeguard.
5. Whether process-isolated workflow tests belong in `test:tui`, `test:tmux`, or a separate script.

The most reversible initial choice is semantic tmux capture assertions with recordings generated on demand.
