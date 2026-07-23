import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function thinkingLevelSchema(description: string) {
  return StringEnum(THINKING_LEVELS, { description });
}

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
  thinkingLevel: Type.Optional(
    thinkingLevelSchema(
      'Thinking/reasoning level. Default: from settings, else "medium". Higher levels use more tokens. Clamped to model capabilities automatically.',
    ),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory (default: current cwd)",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description:
        "Run subagent in background. DEFAULT: true — fan-out and long-running work must not block the parent turn. Returns a jobId immediately instead of blocking; the main agent continues and the result is injected when complete (poll with get_subagent_status or collect with get_subagent_result for manual follow-up). Pass async: false ONLY for a single short sub-agent whose answer you need inline before continuing. Async keeps the parent responsive but does NOT by itself prevent nested fan-out — depth is capped separately.",
    }),
  ),
  notifyOnComplete: Type.Optional(
    Type.Union(
      [
        Type.Literal("notify", {
          description:
            "Show a user notification and persist a pointer-only completion message without injecting output into the parent LLM. Does not trigger a turn by default.",
        }),
        Type.Literal("inject", {
          description:
            "Show a user notification and inject one attributed, bounded completion message with output into the parent LLM. Triggers a turn by default.",
        }),
      ],
      {
        description:
          'Controls the payload saved for parent LLM context, independently of triggerTurnOnComplete. Both modes show the same user-facing notification. The spawn result explains the selected behavior. Defaults to "inject" when async is true.',
      },
    ),
  ),
  triggerTurnOnComplete: Type.Optional(
    Type.Boolean({
      description:
        "Independently controls whether delivery starts a new parent LLM turn. Notify defaults false; inject defaults true. Triggering delivery uses Pi's native follow-up queue while the parent is busy; non-triggering delivery waits until idle.",
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
  wait: Type.Optional(
    Type.Boolean({
      description:
        "Explicitly wait for a running job. Set true ONLY when the user asks to wait. Otherwise running jobs return immediately and continue in the background.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 300_000,
      description:
        "Maximum explicit wait in milliseconds. Defaults to 30000. A timeout does not cancel the job.",
    }),
  ),
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
  thinkingLevel: Type.Optional(
    thinkingLevelSchema(
      'Thinking/reasoning level for the child Pi process. Default: from settings, else "medium". Clamped to model capabilities.',
    ),
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
        'Controls the payload saved for parent LLM context, independently of triggerTurnOnComplete. Both modes show the same user-facing notification, and the spawn result explains what will happen. "inject" (default) sends full output; "notify" persists only an artifact pointer.',
    }),
  ),
  triggerTurnOnComplete: Type.Optional(
    Type.Boolean({
      description:
        "Independently controls whether delivery starts a new parent LLM turn. Notify defaults false; inject defaults true. Triggering delivery uses Pi's native follow-up queue while the parent is busy; non-triggering delivery waits until idle.",
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
