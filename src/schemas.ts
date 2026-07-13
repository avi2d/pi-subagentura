import { Type } from "typebox";

export const BaseParams = Type.Object({
  task: Type.String({ description: "Task to delegate to the sub-agent" }),
  persona: Type.Optional(
    Type.String({
      description:
        "Optional persona / system prompt (e.g. 'You are a senior TypeScript reviewer')",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override model (e.g. 'anthropic/claude-sonnet-4-5'). Default: inherit from current session.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory (default: current cwd)",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description:
        "Run subagent in background. Returns a jobId immediately instead of blocking. Use get_subagent_status to poll progress and get_subagent_result to retrieve output when ready. The main agent continues execution immediately — it does NOT wait for async sub-agents to complete. Use only if users asks to",
    }),
  ),
  notifyOnComplete: Type.Optional(
    Type.Union(
      [
        Type.Literal("notify", {
          description:
            "Persist a pointer-only completion message in parent context without triggering by default.",
        }),
        Type.Literal("inject", {
          description:
            "Queue one attributed, bounded custom completion message. Triggers a turn by default; false explicitly disables triggering.",
        }),
      ],
      {
        description:
          'How to deliver async completion. Defaults to "inject" when async is true.',
      },
    ),
  ),
  triggerTurnOnComplete: Type.Optional(
    Type.Boolean({
      description:
        "Override parent-turn triggering. Notify defaults false; inject defaults true. Delivery waits until the parent is idle.",
    }),
  ),
  maxAge: Type.Optional(
    Type.Number({
      description:
        "Optional TTL in milliseconds for completed job retention. Jobs persist indefinitely if omitted.",
    }),
  ),
});

export const StatusParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

export const ResultParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

export const CancelParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

export const InteractiveParams = Type.Object({
  name: Type.Optional(
    Type.String({
      description:
        "Display name for the sub-agent session. Defaults to a task preview.",
    }),
  ),
  task: Type.String({
    description: "Task to start in the interactive sub-agent",
  }),
  persona: Type.Optional(
    Type.String({
      description:
        "Optional persona / system prompt appended to the child Pi session",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional model override for the child Pi process",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the child Pi process" }),
  ),
  includeContext: Type.Optional(
    Type.Boolean({
      description:
        "Include serialized parent conversation in the initial child prompt. Default false to keep the child session small.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Spawn the sub-agent in a detached named window (hidden from your mux layout) instead of a visible horizontal split. Default true. Pass background: false for a side-by-side split you can watch in real time.",
    }),
  ),
  notifyOnComplete: Type.Optional(
    Type.Union([Type.Literal("notify"), Type.Literal("inject")], {
      description:
        'How to surface completion. "inject" (default) persists full output and triggers by default. "notify" persists a pointer-only message without triggering. Streaming parents flush a bounded FIFO after agent_settled.',
    }),
  ),
  triggerTurnOnComplete: Type.Optional(
    Type.Boolean({
      description:
        "Override parent-turn triggering. Notify defaults false; inject defaults true. Delivery waits until the parent is idle.",
    }),
  ),
  mux: Type.Optional(
    Type.Union(
      [Type.Literal("auto"), Type.Literal("tmux"), Type.Literal("zellij")],
      {
        description:
          'Which multiplexer backend to use. "auto" (default) picks based on environment: zellij if ZELLIJ_SESSION_NAME is set, tmux if TMUX is set, then whichever backend binary is available. "tmux" forces tmux. "zellij" forces zellij.',
      },
    ),
  ),
});
