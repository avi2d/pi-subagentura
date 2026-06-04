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
- `subagent_interactive` — spawn an attachable tmux-backed Pi session
- `get_interactive_subagent_status` — list attachable sessions with pane/session metadata
- `cancel_interactive_subagent` — kill an attachable sub-agent tmux pane
The default sub-agents run inside the current Pi process, stream live progress back to the UI, and inherit the active model by default. Async sub-agents run in the background — the main agent continues immediately while you poll for progress and collect results when ready. Interactive sub-agents run as separate `pi --session ...` processes in tmux panes so you can attach and continue follow-ups directly there.

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

Use these when observability and manual follow-up matter more than in-process execution. They require running Pi inside tmux.

#### `subagent_interactive`

Starts a separate interactive `pi` process in a new tmux pane and returns immediately with:

- sub-agent id
- tmux pane id
- `tmux attach ...` command
- `tmux select-pane ...` command for use inside the same tmux session
- child Pi session file path

Parameters:

- `task` — required initial task
- `name` — optional display name for the pane/session
- `persona` — optional system prompt appended to the child session
- `model` — optional model override
- `cwd` — optional working directory
- `includeContext` — include serialized parent conversation in the child prompt (default: `false`)

#### `get_interactive_subagent_status`

Lists tracked interactive sub-agents, attach/select commands, and session paths. It intentionally does **not** capture pane output to avoid consuming model context.

#### `cancel_interactive_subagent`

Kills the tmux pane for an interactive sub-agent by id.
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
