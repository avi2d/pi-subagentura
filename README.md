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
- `subagent_interactive` — spawn an attachable tmux-backed Pi session with artifact-based progress
- `get_interactive_subagent_status` — list attachable sessions with pane/session/artifact metadata
- `cancel_interactive_subagent` — kill an attachable sub-agent tmux pane
- `read_subagent_artifact` — read an interactive sub-agent's lifecycle events and output
- `list_subagent_artifacts` — list all known interactive sub-agents (in-session and on-disk)
The default sub-agents run inside the current Pi process, stream live progress back to the UI, and inherit the active model by default. Async sub-agents run in the background — the main agent continues immediately while you poll for progress and collect results when ready. Interactive sub-agents run as separate `pi --session ...` processes in tmux panes so you can attach and continue follow-ups directly there, and write structured progress to a per-sub-agent artifact directory on disk.

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
- `notifyOnComplete` — `"notify"` or `"inject"`; auto-deliver completion notification (async only)
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
- `notifyOnComplete` — `"notify"` or `"inject"`; auto-deliver completion notification (async only)
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


### Interactive tmux Tools

Use these when observability and manual follow-up matter more than in-process execution. They require running Pi inside tmux. Interactive sub-agents write their progress to a per-sub-agent artifact directory on disk; the pane is for live monitoring, the artifact is the source of truth.

#### `subagent_interactive`

Starts a separate interactive `pi` process in a tmux window and returns immediately with:

- sub-agent id
- tmux pane id
- `tmux attach ...` command (works from outside tmux)
- `tmux select-pane ...` or `tmux select-window ...` command for use inside the same tmux session
- child Pi session file path
- artifact directory (events.ndjson + output.md)
- the tmux window name (in background mode) so you can find it in your window list

Parameters:

- `task` — required initial task
- `name` — optional display name for the pane/session
- `persona` — optional system prompt appended to the child session
- `model` — optional model override
- `cwd` — optional working directory
- `includeContext` — include serialized parent conversation in the child prompt (default: `false`)
- `background` — spawn in a detached named window (invisible) instead of a visible horizontal split. Default `true` — your tmux layout is undisturbed and you can attach later with the returned `select-window` command. Pass `background: false` for a side-by-side split you can watch in real time.
- `notifyOnComplete` — `"inject"` (default) or `"notify"`; controls how the parent LLM is woken up on completion. See [Completion notifications: notify vs inject](#completion-notifications-notify-vs-inject) below.

The sub-agent's work is **always** written to the artifact dir as `events.ndjson` (lifecycle log) and `output.md` (clean prose the child writes). The pane is for live monitoring; the artifact is the source of truth. The artifact survives parent restarts, so sub-agents that finish while you're away are picked up on the next poll.

#### Sub-agent completion protocol

Every interactive sub-agent receives a built-in system prompt that tells it how to signal completion. The child **must** call one of these when it has nothing more to add before waiting for the next user input:

```bash
$ARTIFACT_DIR/cli.mjs done 0       # success — parent reads the literal output.md path baked into the child prompt
$ARTIFACT_DIR/cli.mjs error "msg"  # unrecoverable failure
# 'cancelled' is only set by the parent via cancel_interactive_subagent
```

The child's system prompt embeds the **literal absolute path** of the artifact dir at the top, e.g. `Your artifact directory is: /Users/.../artifacts/<id>`. Use that literal path in any `write` tool call (the `write` tool does not expand `$ARTIFACT_DIR`) — the bash examples above work because the launch script exports `ARTIFACT_DIR` to the shell. After `done`, the REPL stays open and the child can be re-prompted via `tmux send-keys` to the pane. The parent gets a pointer notification on `done` / `error` / `cancelled` and reads the result via `read_subagent_artifact`. Tool calls and progress are visible in the TUI widget below the editor; no separate progress event is needed.

#### Completion notifications: notify vs inject

Interactive sub-agents deliver their completion to the parent through one of two modes (selected via `notifyOnComplete`):

- `"inject"` (**default** for `subagent_interactive`) — the sub-agent's `output.md` is pushed into the parent LLM's conversation as a new user message. The parent LLM gets a turn and can summarize, chain into the next step, or call more tools. Use this when the sub-agent's output is part of a multi-step pipeline.
- `"notify"` — only a TUI hint is shown (status line + widget). The parent LLM is **not** woken up. The human has to prompt the parent manually to read the sub-agent's output. Use this for spawn-and-forget side-quests.

Both modes share a `MAX_INJECT` cap of 5 concurrent injects. If more sub-agents finish at the same time, the rest degrade silently to `notify` (UI hint only) to keep the parent conversation from flooding. The cap is concurrent, not lifetime — once some injects settle, more can fire.


#### `get_interactive_subagent_status`

Lists tracked interactive sub-agents, attach/select commands, and session paths. It intentionally does **not** capture pane output to avoid consuming model context.

#### `cancel_interactive_subagent`
Kills the tmux pane for an interactive sub-agent by id. Writes a `cancelled` event to the artifact before killing the pane so the artifact log is self-describing.

#### `list_subagent_artifacts`

Lists all known interactive sub-agents: id, name, status, and last-update timestamp. Use this to discover sub-agents that finished while the parent was away.

#### `read_subagent_artifact`

Reads a sub-agent's artifact by id. Returns the lifecycle event log (pass `since` to fetch only new events) and, by default, the sub-agent's `output.md` content. This is the canonical way to get the sub-agent's work product — the parent agent does not need to read the tmux pane or capture rendered TUI.


Parameters:
- `id` — required sub-agent id
- `since` — optional unix-ms timestamp; only return events with `ts >= since`
- `includeOutput` — include `output.md` (default `true`)

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

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
