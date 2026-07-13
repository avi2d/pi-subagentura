# pi-subagentura

[![npm](https://img.shields.io/npm/v/pi-subagentura?label=npm)](https://npmjs.com/package/pi-subagentura) [![GitHub](https://img.shields.io/github/v/tag/lmn451/pi-subagentura?label=github)](https://github.com/lmn451/pi-subagentura)

> **Note:** The `docs/` folder is managed by the [`pi-docs`](https://github.com/lmn451/pi-docs) package.

A public [Pi](https://pi.dev) package that adds in-process and attachable sub-agent tools:

- `subagent_with_context` — spawn a sub-agent that inherits the full conversation history
- `subagent_isolated` — spawn a sub-agent with a fresh, empty context window
- `get_subagent_status` — poll an async subagent job for live progress
- `get_subagent_result` — block until an async job completes and return the final output
- `cancel_subagent` — abort a running async job
- `prune_subagent_jobs` — remove all completed and failed jobs from the registry
- `subagent_interactive` — spawn an attachable mux-backed Pi session (tmux/zellij) with artifact-based progress
- `get_interactive_subagent_status` — list attachable sessions with pane/session/artifact metadata
- `cancel_interactive_subagent` — kill an attachable interactive sub-agent pane
- `send_interactive_subagent_message` — send a follow-up into a live sub-agent's REPL (preserves child context)
- `read_subagent_artifact` — read an interactive sub-agent's lifecycle events and output
- `list_subagent_artifacts` — list all known interactive sub-agents (in-session and on-disk)
  The default sub-agents run inside the current Pi process, stream live progress back to the UI, and inherit the active model by default. Async sub-agents run in the background — the main agent continues immediately while you poll for progress and collect results when ready. Interactive sub-agents run as separate `pi --session ...` processes in tmux or zellij panes so you can attach and continue follow-ups directly there, and write structured progress to a per-sub-agent artifact directory on disk.

Interactive sub-agents support **follow-up turns**: the parent can push a new prompt into the same child REPL via `send_interactive_subagent_message`. The child is `idle` (not exited) between turns, model context is preserved, and each completion maps its Pi `turnId` to an immutable `outputs/<eventId>.md` snapshot recoverable through `read_subagent_artifact`.

## Why use it?

- Delegate focused side-tasks without leaving the current session
- Compare context-aware vs isolated reasoning
- Keep tool feedback lightweight with live status updates
- Run sub-agents in the background while continuing the main conversation
- Poll, collect, or cancel background jobs on demand
- Get live previews of running sub-agents (current turn, active tool, usage)
- Attach to interactive sub-agent sessions for direct follow-ups and debugging

![Sub-agent demo](working.png)

## Installation

Install globally:

```bash
pi install npm:pi-subagentura
```

Install for just the current project:

```bash
pi install -l npm:pi-subagentura
```

Try it for a single run without installing:

```bash
pi -e npm:pi-subagentura
```

You can also install directly from GitHub:

```bash
pi install git:github.com/lmn451/pi-subagentura
```

## Tools

### `subagent_with_context`

Starts a sub-agent with the current conversation history included in its prompt.

Parameters:

- `task` — required task for the sub-agent
- `persona` — optional system-style persona
- `model` — optional model override like `anthropic/claude-sonnet-4-5`
- `cwd` — optional working directory override
- `async` — run in background; returns a jobId immediately instead of blocking
- `notifyOnComplete` — `"inject"` (default for async) persists full output; `"notify"` persists a pointer only
- `triggerTurnOnComplete` — optional override; notify defaults false and inject defaults true
- `maxAge` — optional TTL in ms for completed job retention (async only)

Best for:

- review tasks that depend on prior discussion
- continuing a line of reasoning in parallel
- focused implementation or research using the current context
- background side-quests that report results later

### `subagent_isolated`

Starts a sub-agent with no inherited conversation history.

Parameters:

- `task` — required task for the sub-agent
- `persona` — optional system-style persona
- `model` — optional model override like `anthropic/claude-sonnet-4-5`
- `cwd` — optional working directory override
- `async` — run in background; returns a jobId immediately instead of blocking
- `notifyOnComplete` — `"inject"` (default for async) persists full output; `"notify"` persists a pointer only
- `triggerTurnOnComplete` — optional override; notify defaults false and inject defaults true
- `maxAge` — optional TTL in ms for completed job retention (async only)

Best for:

- second opinions
- clean-room summaries
- avoiding context contamination from the parent session
- background analysis without polluting the main conversation

### Async Workflow Tools

When you spawn a sub-agent with `async: true`, it returns a **jobId** immediately and runs in the background. Use these tools to manage async jobs:

#### `get_subagent_status`

Poll an async subagent job by jobId. Returns a live preview of the subagent's current turn, active tool, and partial output.

Parameters:

- `jobId` — required job ID returned by the async spawn

#### `get_subagent_result`

Block until an async subagent job completes, then return the final output and usage summary. If the job is already done, it returns immediately.

Parameters:

- `jobId` — required job ID returned by the async spawn

#### `cancel_subagent`

Abort a running async subagent job by jobId.

Parameters:

- `jobId` — required job ID returned by the async spawn

#### `prune_subagent_jobs`

Remove all completed and failed subagent jobs from the registry. Running and cancelled jobs are preserved.

### Interactive Sub-agent Tools

Use these when observability and manual follow-up matter more than in-process execution. They require a terminal multiplexer (tmux or zellij). If the parent Pi session is not running inside one, the sub-agent is automatically spawned in a new detached session that you attach to later. Interactive sub-agents write their progress to a per-sub-agent artifact directory on disk; the pane is for live monitoring, the artifact is the source of truth.

#### `subagent_interactive`

Starts a separate interactive `pi` process in a tmux/zellij pane and returns immediately with:

- sub-agent id
- pane id and mux backend (tmux or zellij)
- `attach` command (works from outside the mux session)
- `focus` command (works from inside the same mux session)
- child Pi session file path
- artifact directory (events.ndjson + output.md)
- the window/tab name (in background mode) so you can find it in your mux UI

Parameters:

- `task` — required initial task
- `name` — optional display name for the pane/session
- `persona` — optional system prompt appended to the child session
- `model` — optional model override
- `cwd` — optional working directory
- `includeContext` — include serialized parent conversation in the child prompt (default: `false`)
- `mux` — optional backend: `"auto"` (default), `"tmux"`, or `"zellij"`. Auto picks the currently attached mux (via ZELLIJ_SESSION_NAME / TMUX env vars) then falls back to whichever backend binary is available. Explicit choice forces that backend.
- `background` — spawn in a detached named window/tab (invisible) instead of a visible horizontal split. Default `true` — your mux layout is undisturbed and you can attach later with the returned `focus` command. Pass `background: false` for a side-by-side split you can watch in real time.
- `notifyOnComplete` — `"inject"` (default) persists full output; `"notify"` persists a pointer-only message.
- `triggerTurnOnComplete` — optional override. Notify defaults to `false`; inject defaults to `true`.

The sub-agent's work is **always** written to the artifact dir as `events.ndjson` (lifecycle log) and `output.md` (clean prose the child writes). The pane is for live monitoring; the artifact is the source of truth. The artifact survives parent restarts — sub-agents that finish while you're away are picked up on the next poll.

The interactive sub-agent **registry state** survives parent reloads and restarts. When spawned,
a per-(cwd) state file is written to `<cwd>/.pi/subagentura-state.json`.

The state file and subagent panes are preserved across these actions:

| Action                                            | State file  | Panes      | Rehydrated next start?                   |
| ------------------------------------------------- | ----------- | ---------- | ---------------------------------------- |
| **Ctrl+D (quit) → restart with `--session`/`-r`** | Kept        | Preserved  | ✅ Same session, parentSessionId matches |
| **Ctrl+D → fresh `pi` (no session)**              | Kept        | Preserved  | ❌ Different session, no match           |
| **`/reload`**                                     | Kept        | Preserved  | ✅ Same session                          |
| **`/resume`** (switch to another session)         | Kept        | Preserved  | ✅ If parentSessionId matches            |
| **`/new`**                                        | **Deleted** | **Killed** | ❌ Clean slate                           |
| **`/fork`**                                       | **Deleted** | **Killed** | ❌ Clean slate                           |

> **Note:** `/new` deletes the state file. If you do `/new` and then `/resume`
> back to the session where subagents were spawned, they **will not reappear**
> — the state file was already deleted. Only `/reload` or a restart with the
> same session (`--session`/`-r`) preserves the registry.

On `/reload` and `/resume`, the `session_start` handler rehydrates
the in-memory registry, filtering by `parentSessionId` so only subagents
that were created in the current session are restored.
Protocol-v2 byte cursors, pending delivery intents, and receipts are restored so
reload does not unconditionally replay already-dispatched completions.

See the [state file gotcha](AGENTS.md#rehydrate-state-file-cwdpisubagentura-state-json)
in AGENTS.md for the crash-safety ordering and inject-mode flood fix.

#### Sub-agent completion protocol

Every interactive child runs protocol-only Pi lifecycle hooks and therefore
requires Pi SDK `>=0.80.6 <0.81.0`. `before_agent_start` creates a provisional
turn, the first `turn_start` binds it to the persisted Pi user-entry id, tool
hooks record activity, and `agent_settled` records the authoritative completion
after retries, compaction, and queued continuations. The explicit CLI remains supported:

```bash
$ARTIFACT_DIR/cli.mjs done 0       # success — parent reads the literal output.md path baked into the child prompt
$ARTIFACT_DIR/cli.mjs error "msg"  # unrecoverable failure
# 'cancelled' is only set by the parent via cancel_interactive_subagent
```

The explicit completion command is mandatory for every initial and follow-up
turn. The child must complete these steps in order: write the final result to
`output.md`, run `cli.mjs done 0`, wait until exactly one completion event is
recorded successfully, then send its final assistant response. The command must
be the final tool call of the turn. If it fails to execute, the child must not
finalize; it fixes the failure and retries until completion is recorded. The
child lifecycle hook at `agent_settled` is a crash-safety fallback, not a
substitute for the explicit command. The system prompt, initial task footer,
and every injected follow-up prompt repeat this requirement so the command
remains the model's most recent instruction.

At each child turn start, mutable `output.md` is atomically reset without
touching earlier snapshots. Before each completion event, the current staging
file (including an empty file when the turn wrote nothing) is copied atomically to
`outputs/<eventId>.md` with byte count and SHA-256 metadata. Events are consumed
in physical NDJSON byte order; timestamps are display-only. Mixed v1/v2 logs and
legacy `output-N.md` snapshots remain readable. New legacy completions are
pointer-only because mutable `output.md` cannot be safely attributed to a turn.

#### Completion notifications: notify vs inject

Interactive sub-agents deliver their completion to the parent through one of two modes (selected via `notifyOnComplete`):

- `"inject"` (**default**, including async in-process tools) persists one attributed custom
  completion message and triggers a turn by default. Explicit
  `triggerTurnOnComplete: false` disables triggering.
- `"notify"` persists an attributed pointer-only custom message in parent
  context without triggering a provider call. Explicit
  `triggerTurnOnComplete: true` wakes the parent immediately.

| Configuration                             | Persisted in parent context | Starts an immediate parent turn |
| ----------------------------------------- | --------------------------- | ------------------------------- |
| `inject` (default)                        | Full completion output      | Yes                             |
| `inject` + `triggerTurnOnComplete: false` | Full completion output      | No                              |
| `notify` (default trigger behavior)       | Artifact pointer only       | No                              |
| `notify` + `triggerTurnOnComplete: true`  | Artifact pointer only       | Yes                             |

Therefore plain `notify` records the completion for both the UI and the parent
conversation, but the LLM does not react immediately. The pointer becomes
available to the model when the user starts the next parent turn. It is not a
visual-only notification and the completion is not discarded.

LLM-facing completions wait while the parent streams and flush as one bounded
message after `agent_settled`. The durable FIFO is limited to 32 records / 256 KiB,
with 32 KiB output per record and 64 KiB per flush. Overflow keeps status and
artifact pointers rather than silently dropping completion. Delivery is
at-least-once: deterministic delivery IDs and session receipts prevent routine
reload replay, but a crash between synchronous dispatch and receipt persistence
can still duplicate one completion.

#### `get_interactive_subagent_status`

Lists tracked interactive sub-agents, attach/select commands, and session paths. It intentionally does **not** capture pane output to avoid consuming model context.

#### `cancel_interactive_subagent`

Kills the mux pane for an interactive sub-agent by id. Writes a `cancelled` event to the artifact before killing the pane so the artifact log is self-describing.

#### `send_interactive_subagent_message`

Sends a follow-up prompt to a running interactive sub-agent by id. The message is delivered into the child's existing REPL via the sub-agent's mux backend (tmux send-keys or zellij write-chars + write 13), so the child's model context is preserved — this is a true follow-up turn, not a fresh spawn. The child will run the new turn and (per its system prompt) call `cli.mjs done 0` again when finished, which wakes the parent via the usual `notifyOnComplete` path.
Refuses to send if the sub-agent is not in the registry, is not in `running` status, or if the mux itself rejects the send call (e.g. the pane was killed between status check and send). All three failure modes return a structured `isError: true` result.

Parameters:

- `id` — required sub-agent id
- `message` — required follow-up prompt text

#### `list_subagent_artifacts`

Lists all known interactive sub-agents: id, name, status, and last-update timestamp. Use this to discover sub-agents that finished while the parent was away.

#### `read_subagent_artifact`

Reads a sub-agent's artifact by id. Returns the lifecycle event log (pass `since` to fetch only new events) and, by default, the sub-agent's `output.md` content (the latest turn's output). This is the canonical way to get the sub-agent's work product — the parent agent does not need to read the tmux pane or capture rendered TUI.

Protocol-v2 completions map each Pi-derived `turnId` to an immutable
`outputs/<eventId>.md` snapshot. Pass `turnId` to read that output; the response's
`details.outputHistory` lists the available `turnId`/`eventId` mappings. Legacy
`output-N.md` history remains available through numeric `turn` and
`details.availableTurns`.

Parameters:

- `id` — required sub-agent id
- `since` — optional unix-ms timestamp; only return events with `ts >= since`
- `includeOutput` — include the output (default `true`); historical selectors imply output
- `turn` — optional turn number; read `output-N.md` for that specific turn instead of the latest `output.md`
- `turnId` — optional protocol-v2 Pi turn id; read its immutable `outputs/<eventId>.md` snapshot

### `list_available_models`

List all available AI models with auth status. Use this to validate model identifiers before passing them to subagent tools — prevents silent fallback to the parent session model.

Parameters:

- `filter` — optional substring filter for provider or model name
- `authOnly` — if true (default), only return models with configured auth

## Example prompts

- “Use a sub-agent to review this change and list risks.”
- “Use an isolated sub-agent to propose a README outline for this repo.”
- “Spawn a context-aware sub-agent to continue debugging while we keep planning here.”
- “Run a sub-agent in the background to run the test suite, then notify me when done.”
- “Spawn two isolated async sub-agents to review this code from different angles, then collect both results.”
- “Start an interactive sub-agent in tmux for investigating the auth bug; I’ll attach and guide it.”

## Development

This repo uses npm for local development.

```bash
npm install
npm test
npm run pack:check
```

### Debug logging

Set `SUBAGENT_DEBUG_LOG_DIR=/some/path` to write a JSONL trace of sub-agent lifecycle events to `debug-YYYY-MM-DD.jsonl` in that directory. Each line is a self-describing JSON object with `timestamp`, `level`, `event`, and event-specific fields.

The `tool_start` event records the `toolName` and full `args` of every tool the sub-agent invokes — useful for replaying or auditing what a sub-agent did. Other events cover session creation, turns, message updates, prompts, and job completion.

The feature is a no-op when the env var is unset.

```bash
SUBAGENT_DEBUG_LOG_DIR=./.pi-debug pi   # writes ./pi-debug/debug-2026-06-10.jsonl
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

A pre-commit hook formats staged files (via `simple-git-hooks` + `lint-staged`). A pre-push hook runs `npm run format:check` across the repository.

Install or refresh the hooks with `npm run hooks:install`. To skip a hook once, set `SKIP_SIMPLE_GIT_HOOKS=1`. To reformat the repository:

`npm run format`.

## License

[MIT](./LICENSE)
