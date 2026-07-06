# Workflow Tool — Design Doc (Phase 2)

## Overview

The workflow tool orchestrates sub-agents at scale via a JavaScript script that runs
in a Worker thread. It ports Claude Code's "Dynamic Workflows" model into pi-subagentura.

**Phase 2 scope:** Async-by-default, `/workflows` user command, process isolation as default.

## Key Decisions

| Decision                | Choice                                  | Rationale                                                                                   |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sync vs Async           | Async by default; sync explicit opt-in  | Workflows are long-running; blocking the agent makes no sense. Claude Code is always async. |
| Default agent isolation | Process (tmux/zellij)                   | Attachable, debuggable, same UX as Claude Code. In-process fallback when no mux.            |
| Visibility (Phase 1)    | `/workflows` command → sendMessage text | Minimal TUI work; full drill-down deferred to Phase 3.                                      |
| Backward compat         | Deferred                                | We preserve sync+async tool contract but flip the default.                                  |

## Architecture

```mermaid
graph TD
    A[Agent calls workflow()] --> B{async param?}
    B -- default true --> C[startWorkflowJob]
    B -- explicit false --> D[runWorkflow sync]
    C --> E[WorkflowJobState in registry]
    E --> F[/workflows command reads registry]
    E --> G[agent() inside workflow]
    G --> H{isolation param?}
    H -- default "process" --> I[launchInteractiveSubagent]
    I -- tmux/zellij ok --> J[awaitInteractiveResult]
    I -- NoMultiplexerAvailable --> K[in-process startSubagentJob]
    H -- "in-process" --> K
    K --> L[SubagentResult via jobPromise]
    J --> L
```

## Changes from v2

1. **`async` default flips from `false` to `true`**

   - `workflow({ script })` now spawns background; returns `workflowId`
   - `workflow({ script, async: false })` still blocks (sync)
   - Only ~1 line change in `execute()`: `params.async !== false`

2. **`agent()` isolation defaults to `"process"`**

   - In `makeRunAgent`: if no `isolation` param, try process isolation
   - Fallback chain: tmux → zellij → in-process (already exists for explicit `isolation:"process"`)
   - Previously defaulted to in-process; now process is the default

3. **`/workflows` command via `registerCommand`**
   - Iterates `workflowJobRegistry`
   - Formats as markdown: id, name, status, agents, errors, tokens, phase, elapsed
   - Injects via `pi.sendMessage()` — no TUI widget needed yet
   - Coexists with existing `get_workflow_status`/`get_workflow_result` tools

## File Changes

| File                   | Change                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `src/workflow-tool.ts` | Flip async default; add `/workflows` command handler; change agent() default isolation |
| `src/subagent.ts`      | No changes (already calls `registerWorkflowTool`)                                      |
| `src/rendering.ts`     | No changes in Phase 2                                                                  |
| `src/multiplexer.ts`   | No changes — already correct                                                           |

## Open Questions (Phase 3)

- Drillable TUI (per-agent prompt/tool calls/result)
- Persistent widget showing running workflows
- Pause/resume individual agents
- Restart failed agents
