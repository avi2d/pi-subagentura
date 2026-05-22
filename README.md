# pi-subagentura

[![npm](https://img.shields.io/npm/v/pi-subagentura?label=npm)](https://npmjs.com/package/pi-subagentura) [![GitHub](https://img.shields.io/github/v/tag/lmn451/pi-subagentura?label=github)](https://github.com/lmn451/pi-subagentura)

> **Note:** The `docs/` folder is managed by the [`pi-docs`](https://github.com/lmn451/pi-docs) package.

A public [Pi](https://pi.dev) package that adds in-process sub-agent tools:

- `subagent_with_context` — spawn a sub-agent that inherits the full conversation history
- `subagent_isolated` — spawn a sub-agent with a fresh, empty context window
- `get_subagent_status` — poll an async subagent job for live progress
- `get_subagent_result` — block until an async job completes and return the final output
- `cancel_subagent` — abort a running async job
- `prune_subagent_jobs` — remove all completed and failed jobs from the registry
- `tmux_spawn` — spawn an agent in a dedicated tmux window with socket-based IPC
- `wezterm_spawn` — spawn an agent in a new Wezterm pane with session persistence

The sub-agents run inside the current Pi process, stream live progress back to the UI, and inherit the active model by default. Async sub-agents run in the background — the main agent continues immediately while you poll for progress and collect results when ready.

## Why use it?

- Delegate focused side-tasks without leaving the current session
- Compare context-aware vs isolated reasoning
- Keep tool feedback lightweight with live status updates
- Run sub-agents in the background while continuing the main conversation
- Poll, collect, or cancel background jobs on demand
- Get live previews of running sub-agents (current turn, active tool, usage)
- Spawn agents in visible tmux windows for full transparency into execution

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

### `tmux_spawn`

Spawns an interactive pi session in a dedicated tmux window with session persistence. The user can continue chatting with the subagent after the initial task completes.

**Parameters:**

- `task` — required task for the tmux agent
- `name` — optional tmux window name hint
- `cwd` — optional working directory
- `timeout` — timeout in ms (default 60000)

**How it works:**

1. Creates a session directory for persistence
2. Spawns `pi --session-dir <dir> --continue "<task>"`
3. User sees the pi TUI processing the task in real-time
4. After task completes, session is saved
5. User can continue the session with another pi command

**Best for:**

- when you need to see exactly what the agent is doing in real-time
- long-running tasks where you want visibility
- debugging agent behavior
- transparent execution in a dedicated window
- spawning a subagent you want to continue chatting with later

**Continuing the session:**

After the initial task completes, the tmux window shows instructions for continuing:

```bash
pi --session-dir /tmp/pi-<uid>/agent-<uuid>.sock_sessions --continue "next task"
```

The session persists, so you can continue from any terminal.

![Tmux demo](tmux-demo.png)

### `wezterm_spawn`

Spawns an interactive pi session in a new Wezterm pane with session persistence. Similar to `tmux_spawn` but uses Wezterm's native CLI instead of tmux.

**Parameters:**

- `task` — required task for the wezterm agent
- `name` — optional pane label hint
- `cwd` — optional working directory
- `timeout` — timeout in ms (default 60000)

**How it works:**

1. Creates a session directory
2. Opens a new pane in Wezterm running `pi --session-dir <dir> --continue "<task>"`
3. User sees the pi TUI in the new pane
4. After task completes, session is saved
5. User can continue the session from any terminal

**Best for:**

- Wezterm users who want native terminal integration
- visible execution with session persistence
- spawning a subagent you want to continue chatting with later

**Continuing the session:**

```bash
pi --session-dir <session-dir> --continue "next task"
```

## Async Workflow Tools

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

Remove all completed and failed jobs from the registry. Running and cancelled jobs are preserved.

### `list_available_models`

List all available AI models with auth status. Use this to validate model identifiers before passing them to subagent tools — prevents silent fallback to the parent session model.

Parameters:

- `filter` — optional substring filter for provider or model name
- `authOnly` — if true (default), only return models with configured auth

## Debug Logging

Enable structured debug logging by setting the `SUBAGENT_DEBUG_LOG_DIR` environment variable:

```bash
SUBAGENT_DEBUG_LOG_DIR=/tmp/subagent-logs pi "run some task"
```

Logs are written to `debug-YYYY-MM-DD.jsonl` files in the specified directory. Each entry contains:

- `timestamp` — ISO timestamp
- `level` — info/warn/error
- `event` — event type (e.g., `tool_call`, `session_created`, `prompt_start`)
- Additional event-specific fields (jobId, model, cwd, etc.)

Events logged:

| Event | Description |
|-------|-------------|
| `tool_call` | A subagent tool was called |
| `session_creating` | About to create an agent session |
| `session_created` | Session created successfully |
| `prompt_start` | Prompt execution started |
| `prompt_complete` | Prompt execution completed |
| `turn_start` | New turn started |
| `turn_end` | Turn ended |
| `tool_start` | Tool execution started |
| `tool_end` | Tool execution completed |
| `job_complete` | Job finished (success or error) |
| `job_abort` | Job was aborted |

## Example prompts

- "Use a sub-agent to review this change and list risks."
- "Use an isolated sub-agent to propose a README outline for this repo."
- "Spawn a context-aware sub-agent to continue debugging while we keep planning here."
- "Run a sub-agent in the background to run the test suite, then notify me when done."
- "Spawn two isolated async sub-agents to review this code from different angles, then collect both results."
- "Use tmux_spawn to refactor this module — I want to watch what it does."

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
