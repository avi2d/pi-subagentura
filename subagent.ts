/**
 * Sub-Engine Extension - Spawn in-process sub-agents via the SDK
 *
 * Tools:
 *   - subagent_with_context: Inherits full conversation history + task + persona
 *   - subagent_isolated: Fresh context window, task + optional persona only
 *   - get_subagent_status: Poll async subagent job for live preview
 *   - get_subagent_result: Block until async job completes, return final output
 *   - cancel_subagent: Abort a running async job
 *   - prune_subagent_jobs: Remove all completed and failed jobs from the registry
 *   - subagent_interactive: Spawn a separate tmux-backed Pi session users can attach to
 *   - get_interactive_subagent_status / cancel_interactive_subagent: Inspect or stop tmux-backed sessions
 *   - list_available_models: List all known models with auth status for model validation
 *
 * Both spawn tools support optional `async` param for background execution.
 * When async: true, the job starts and the main agent continues immediately -
 * it does NOT block waiting for the sub-agent. Use get_subagent_status to poll
 * for progress and get_subagent_result when ready to collect output.
 *
 * Runs in the same process — no subprocess overhead.
 */

import {
  type ExtensionAPI,
  type Theme,
  convertToLlm,
  serializeConversation,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  ACTIVE_TOOL_DEBOUNCE_MS,
  buildLiveUpdate,
  formatUsage,
  SubagentLiveStatus,
  SubagentResult,
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  debugLog,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
import {
	cancelInteractiveSubagent,
	formatInteractiveState,
	interactiveSubagentRegistry,
	launchInteractiveSubagent,
	pruneDeadInteractiveSubagents,
	tmuxSetupHint,
	type InteractiveSubagentState,
	type NotifyOnUpdate,
} from "./interactive-tmux";
import { artifactPath, lastEvent, readEvents, readOutput, type SubagentArtifact, type SubagentEvent } from "./artifact";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Footer Status Key ───────────────────────────────────────────────
const FOOTER_KEY = "subagentura-running";

// ── Helpers ──────────────────────────────────────────────────────────
// Shared helpers are imported from ./helpers (SubagentResult, SubagentLiveStatus,
// formatUsage, buildLiveUpdate, ACTIVE_TOOL_DEBOUNCE_MS, jobRegistry, MAX_REGISTRY_SIZE,
// pruneOldestJob, pruneCompletedJobs, scheduleJobCleanup, startSubagentJob, JobState)

async function runSubagent(
  task: string,
  persona: string | undefined,
  modelOverride: string | undefined,
  cwd: string,
  contextText: string | null,
  signal: AbortSignal | undefined,
  // @ts-expect-error — AgentToolResult<T> requires type arg; unknown is a safe placeholder
  onUpdate: ((partial: AgentToolResult) => void) | undefined,
  // @ts-expect-error — Model<TApi> requires type arg; unknown is a safe placeholder
  defaultModel: Model | undefined,
  parentModelRegistry: ModelRegistry | undefined,
): Promise<SubagentResult> {
  try {
    const { jobPromise, modelWarning } = await startSubagentJob({
      task,
      persona,
      modelOverride,
      cwd,
      contextText,
      signal,
      onUpdate,
      defaultModel,
      parentModelRegistry,
    });
    const result = await jobPromise;
    // Surface model resolution info so the AI sees what model was used
    if (modelWarning && !result.isError) {
      result.output = `${modelWarning}\n---\n${result.output}`;
    }
    return result;
  } catch (err) {
    // Preserve original error formatting: if startSubagentJob throws
    // (e.g., createAgentSession auth failure), return clean SubagentResult
    // instead of letting raw error propagate to Pi's agent loop.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: `Sub-agent crashed: ${msg}`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      model: undefined,
      isError: true,
      errorMessage: msg,
    };
  }
}

// ── Rendering ────────────────────────────────────────────────────────

function renderSubagentCall(
  args: Record<string, unknown>,
  theme: Theme,
  label: string,
) {
  const task = String(args.task ?? "");
  const taskPreview = task.length > 60 ? `${task.slice(0, 57)}…` : task;
  let text = theme.fg("toolTitle", theme.bold(`${label} `));
  text += theme.fg("accent", taskPreview);
  if (args.model) {
    text += theme.fg("dim", ` @${args.model}`);
  }
  if (args.async) {
    text += theme.fg("accent", " [async]");
  }
  return new Text(text, 0, 0);
}

function renderSubagentResult(
  // @ts-expect-error — AgentToolResult<T> requires type arg
  result: AgentToolResult,
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: unknown,
) {
  // Async spawn result: show compact "started" display
  if ((result.details as Record<string, unknown>)?.status === "started") {
    return renderAsyncSpawn(result.details as Record<string, unknown>, theme);
  }

  if (isPartial) {
    const status = result.details?.subagentStatus as
      | SubagentLiveStatus
      | undefined;
    const model = result.details?.model as string | undefined;

    let text =
      theme.fg("accent", "● ") + theme.fg("toolTitle", "Sub-agent working");

    if (status) {
      text += theme.fg("dim", ` — turn ${status.turn}`);

      if (status.activeTool) {
        let argsStr = "{…}";
        try {
          argsStr = JSON.stringify(status.activeTool.args).slice(0, 80);
        } catch {
          /* circular or otherwise unserializable */
        }
        text += `
  ${theme.fg("muted", "→")} ${theme.fg(
    "toolTitle",
    status.activeTool.name,
  )} ${theme.fg("dim", argsStr)}`;
      }

      const usageStr = formatUsage(status.usage, model);
      if (usageStr) {
        text += `
  ${theme.fg("muted", usageStr)}`;
      }

      if (status.output) {
        const preview = status.output.slice(0, 200).replace(/\s+/g, " ");
        text += `
  ${theme.fg("dim", truncateToWidth(preview, 120))}`;
      }
    } else {
      text += theme.fg("dim", "…");
    }

    return new Text(text, 0, 0);
  }

  // Final result
  const text =
    result.content.find(
      (c): c is { type: "text"; text: string } => c.type === "text",
    )?.text ?? "";

  if (result.isError) {
    if (!expanded) {
      const preview = truncateToWidth(text.replace(/\s+/g, " "), 120);
      return new Text(theme.fg("error", preview), 0, 0);
    }
    return new Text(theme.fg("error", text), 0, 0);
  }

  const usageStr = result.details?.usageSummary as string | undefined;

  if (usageStr) {
    const header = theme.fg("success", "✓ ") + theme.fg("muted", usageStr);
    if (!expanded) {
      return new Text(header, 0, 0);
    }
    return new Text(`${header}\n${text}`, 0, 0);
  }

  if (!expanded) {
    const preview = truncateToWidth(text.replace(/\s+/g, " "), 120);
    return new Text(theme.fg("dim", preview), 0, 0);
  }
  return new Text(text, 0, 0);
}

/**
 * Render the immediate result of an async subagent spawn.
 * Compact display: "⚡ Sub-agent started — job abc12345"
 */
function renderAsyncSpawn(
  details: Record<string, unknown>,
  theme: Theme,
): Text {
  const jobId = String(details.jobId ?? "unknown");
  const text =
    theme.fg("accent", "⚡ ") +
    theme.fg("toolTitle", `Sub-agent started — job ${jobId}`) +
    "\n" +
    theme.fg("dim", "  Use get_subagent_status to check progress.");
  return new Text(text, 0, 0);
}

// ── Schema ───────────────────────────────────────────────────────────

const BaseParams = Type.Object({
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
            "Send a brief summary notification when the sub-agent completes (no turn triggered)",
        }),
        Type.Literal("inject", {
          description:
            "Inject the full result as a user message when the sub-agent completes (triggers a new turn)",
        }),
      ],
      {
        description:
          "When set, automatically deliver completion notification to the main agent. Only valid with async: true.",
      },
    ),
  ),
  maxAge: Type.Optional(
    Type.Number({
      description:
        "Optional TTL in milliseconds for completed job retention. Jobs persist indefinitely if omitted.",
    }),
  ),
});

const StatusParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

const ResultParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

const CancelParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

const InteractiveParams = Type.Object({
  name: Type.Optional(
    Type.String({
      description: "Display name for the tmux pane/session. Defaults to a task preview.",
    }),
  ),
  task: Type.String({ description: "Task to start in the interactive sub-agent" }),
  persona: Type.Optional(
    Type.String({
      description: "Optional persona / system prompt appended to the child Pi session",
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
        "Spawn the sub-agent in a detached named window (hidden from your tmux layout) instead of a visible horizontal split. Default true. Pass background: false for a side-by-side split you can watch in real time.",
    }),
  ),
	notifyOnUpdate: Type.Optional(
		Type.Union(
			[
				Type.Literal("off", {
					description: "Never notify the parent; the sub-agent writes its artifact to disk silently.",
				}),
				Type.Literal("milestones", {
					description: "Notify on lifecycle events (started/done/error/cancelled). Default. Pointer-only — the main agent reads the artifact on demand.",
				}),
				Type.Literal("all", {
					description: "Notify on every artifact event, including wip and output_updated. Use for live progress.",
				}),
			],
			{
				description:
					"Notification cadence for the artifact-driven poller. The main agent always reads the artifact via read_subagent_artifact; this controls when the parent gets a pointer message.",
			},
		),
	),
});


// ── Extension ────────────────────────────────────────────────────────

// ── Inject cap tracking ─────────────────────────────────────────
/** Track concurrent inject-mode notifications to prevent conversation explosion */
export function getInjectCount(): number {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  return (g2.__piSubagenturaInjectCount ?? 0) as number;
}
function incrementInjectCount(): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaInjectCount =
    ((g2.__piSubagenturaInjectCount ?? 0) as number) + 1;
}
function decrementInjectCount(): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaInjectCount = Math.max(
    0,
    ((g2.__piSubagenturaInjectCount ?? 0) as number) - 1,
  );
}

/** Max concurrent inject-mode notifications before degrading to notify */
export const MAX_INJECT = 5;

// ── Notification Delivery ───────────────────────────────────────
/**
 * Deliver async subagent completion notification.
 * Reads pi from globalThis to survive module reloads.
 */
function deliverNotification(jobState: JobState, result: SubagentResult): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  const pi = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
  if (!pi) return; // extension not loaded yet

  try {
    const summary = buildNotifySummary(jobState.id, result);

    if (jobState.notifyOnComplete === "inject") {
      // Check inject cap
      if ((getInjectCount() as number) >= MAX_INJECT) {
        // Degrade to notify mode silently
        pi.sendMessage!(
          {
            customType: "subagent-notify",
            content: `Inject cap exceeded for job ${jobState.id} — degraded to notify. ${summary}`,
            display: true,
            details: { jobId: jobState.id, result, mode: "notify" },
          },
          { deliverAs: "followUp" },
        );
        return;
      }
      incrementInjectCount();
      try {
        // Inject full result as user message
        (pi as any).sendUserMessage?.(
          result.output || "(sub-agent produced no output)",
          {
            deliverAs: "followUp",
          },
        );
        // Also send a summary notification
        pi.sendMessage!(
          {
            customType: "subagent-notify",
            content: `⚡ Sub-agent **${jobState.id}** completed — result injected above. ${summary}`,
            display: true,
            details: { jobId: jobState.id, result, mode: "inject" },
          },
          { deliverAs: "followUp" },
        );
      } finally {
        decrementInjectCount();
      }
    } else {
      // notify mode
      pi.sendMessage!(
        {
          customType: "subagent-notify",
          content: summary,
          display: true,
          details: { jobId: jobState.id, result, mode: "notify" },
        },
        { deliverAs: "followUp" },
      );
    }
  } catch {
    // pi may be stale after session replacement
  }

  jobState.notificationDelivered = true;
}

// ── Interactive (tmux-backed) artifact poller ───────────────────

/** True when the event should trigger a notification under the given cadence. */
function shouldNotify(event: SubagentEvent, mode: NotifyOnUpdate): boolean {
	if (mode === "off") return false;
	if (mode === "all") return true;
	// "milestones": only lifecycle events, not wip/output_updated.
	return (
		event.type === "started" ||
		event.type === "done" ||
		event.type === "error" ||
		event.type === "cancelled"
	);
}

/**
 * Poll the artifact directory of every running interactive sub-agent and fire a
 * pointer-only notification for any new events that match the spawner's cadence.
 *
 * Backwards-compatible with sub-agents that finished during parent downtime:
 * we walk the artifact log, deliver events newer than `lastDeliveredEventTs`,
 * then advance the cursor. This naturally handles restart / backlog cases.
 */
export function pollArtifactChanges(pi: ExtensionAPI): void {
	const g2 = typeof global !== "undefined" ? global : globalThis;
	const interactivePi = (g2.__piSubagenturaPiRef as ExtensionAPI | undefined) ?? pi;
	if (!interactivePi) return;

	for (const state of interactiveSubagentRegistry.values()) {
		if (state.status === "cancelled" || state.status === "exited" || state.status === "unknown") continue;
		const mode = state.notifyOnUpdate ?? "off";

		const art = artifactPath(dirname(state.artifactDir), basename(state.artifactDir));
		const last = lastEvent(art);

		// Always update status based on the artifact, regardless of notification mode.
		// (Even in 'off' mode, the registry should reflect that the sub-agent is done.)
		if (last && (last.type === "done" || last.type === "error" || last.type === "cancelled")) {
			if (last.type === "cancelled") {
				state.status = "cancelled";
			} else {
				state.status = "exited";
			}
			if (last.exitCode !== undefined) state.exitCode = last.exitCode;
		}

		if (mode === "off") continue;

		// Read events newer than the last delivered. `lastDeliveredEventTs` starts at 0,
		// so on the first poll we deliver the whole log. Subsequent polls advance the cursor.
		const cursor = state.lastDeliveredEventTs ?? 0;
		const events = readEvents(art, cursor + 1);
		if (events.length === 0) continue;

		let maxTs = cursor;
		for (const ev of events) {
			if (ev.ts > maxTs) maxTs = ev.ts;
			if (!shouldNotify(ev, mode)) continue;
			deliverArtifactNotification(interactivePi, state, ev);
		}
		state.lastDeliveredEventTs = maxTs;
	}
}

/** Send a single pointer-only notification for one artifact event. */
function deliverArtifactNotification(pi: ExtensionAPI, state: InteractiveSubagentState, event: SubagentEvent): void {
	const header = `${iconFor(event)} ${state.name} (${state.id}) — ${labelFor(event)}`;
	const body = event.message ? `\n${event.message}` : "";
	const pointer = `\nArtifact: ${state.artifactDir}\nRead with: read_subagent_artifact({"id":"${state.id}"})`;
	try {
		pi.sendMessage!(
			{
				customType: "subagent-notify",
				content: `${header}${body}${pointer}`,
				display: true,
				details: { subagentId: state.id, event, mode: state.notifyOnUpdate ?? "milestones" },
			},
			{ deliverAs: "followUp" },
		);
	} catch {
		// pi may be stale after session replacement
	}
}

function iconFor(event: SubagentEvent): string {
	switch (event.type) {
		case "started":
		case "wip":
		case "output_updated":
			return "▶";
		case "done":
			return event.exitCode === 0 ? "✅" : "❌";
		case "error":
			return "❌";
		case "cancelled":
			return "🚫";
	}
}

function labelFor(event: SubagentEvent): string {
	switch (event.type) {
		case "started":
			return "started";
		case "wip":
			return "wip";
		case "output_updated":
			return "output updated";
		case "done":
			return `done (exit ${event.exitCode ?? "?"})`;
		case "error":
			return "error";
		case "cancelled":
			return "cancelled";
	}
}
/**
 * Find an artifact dir for an id that isn't in the current registry. We can't use the
 * registry (it's lost across process restarts) so we ask the file system. We scan the
 * default artifacts root (PI_CODING_AGENT_SESSION_DIR or ~/.pi/agent/sessions/subagentura).
 * For v1 this is a best-effort lookup; a future iteration can track all artifact roots.
 */
function findArtifactById(id: string): SubagentArtifact | null {
	const root = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");
	let topLevel: string[];
	try {
		topLevel = readdirSync(root);
	} catch {
		return null;
	}
	for (const entry of topLevel) {
		const candidate = join(root, entry, "artifacts", id);
		try {
			if (statSync(candidate).isDirectory()) {
				return artifactPath(join(root, entry, "artifacts"), id);
			}
		} catch {
			/* not here */
		}
	}
	return null;
}
/** Sanitize a string by redacting common sensitive patterns (API keys, tokens, JWTs). */
function sanitizeOutput(text: string): string {
	return text.replace(
		/(sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|-----BEGIN[\s\w]+KEY-----|AKIA[\w]{16}|ghp_[\w]{36}|gho_[\w]{36}|ghu_[\w]{36}|xox[abp]-[\w-]+|AIza[\w-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
		"[REDACTED]",
	);
}

function buildNotifySummary(jobId: string, result: SubagentResult): string {
  const status = result.isError ? "❌" : "✅";
  const msg = result.isError
    ? result.errorMessage || result.output.slice(0, 200).replace(/\s+/g, " ")
    : "done";

  const sanitized = sanitizeOutput(msg);

  const usageStr = formatUsage(result.usage);
  const summary = `${status} Job ${jobId} ${sanitized.slice(0, 300)}`;
  if (usageStr) {
    return `${summary} (${usageStr})`;
  }
  return summary;
}
// ── Notification TUI Renderer ──────────────────────────────────
function renderSubagentNotify(
	message: any,
	options: { expanded?: boolean },
	theme: Theme,
): Text {
	const details = message.details as Record<string, unknown> | undefined;
	const isInject = details?.mode === "inject";
	const isError = details?.result && (details.result as SubagentResult).isError;
	const text = message.content ?? "";

	let line: string;
	if (!options.expanded) {
		line = isError ? theme.fg("error", text) : theme.fg("accent", text);
	} else {
		const output = sanitizeOutput(
			((details?.result as SubagentResult)?.output ?? "")
				.slice(0, 500)
				.replace(/\s+/g, " "),
		);
		const header = isInject
			? theme.fg("accent", "⚡ Injected Sub-agent Result")
			: isError
				? theme.fg("error", "❌ Sub-agent Failed")
				: theme.fg("success", "✅ Sub-agent Completed");
		const body = theme.fg("dim", text);
		line = `${header}\n${body}\n${output}`;
	}
	return new Text(line, 0, 0);
}

export default function (pi: ExtensionAPI) {
  // Persist pi ref for async notification delivery (survives module reload)
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaPiRef = pi;
  g2.__piSubagenturaInjectCount = 0;

  // Register notification renderer before any tools
  (pi as any).registerMessageRenderer?.(
    "subagent-notify",
    (message: any, options: any, theme: Theme) => {
      return renderSubagentNotify(message, options, theme);
    },
  );

	// ── Interactive sub-agent artifact poller ────────────────────────
	// One global interval for the whole session. Each tick walks the artifact dir of
	// every running interactive sub-agent and fires pointer notifications for new events.
	// The poller survives parent restarts (artifacts on disk + per-state lastDeliveredEventTs).
	if (!g2.__piSubagenturaInteractivePollerHandle) {
		g2.__piSubagenturaInteractivePollerHandle = setInterval(
			() => pollArtifactChanges(pi),
			5000,
		);
	}
  // ── Tool 1: inherits conversation history ────────────────────────
  pi.registerTool({
    name: "subagent_with_context",
    label: "Sub-Agent (with context)",
    description: [
      "Spawn an in-process sub-agent that inherits the full conversation history.",
      "WARNING: Each call serializes the entire conversation into memory. Spawning many",
      "subagents with context in parallel can cause heap exhaustion (OOM).",
      "",
      "MEMORY-SAVING ALTERNATIVES:",
      "1. Use subagent_isolated for tasks that don't need full history",
      "2. Run few parallel subagents (1-3 at a time) instead of batching many",
      "3. Consider summarizing the context before passing to subagent",
      "",
      "The sub-agent sees everything discussed so far plus the new task.",
      "Model is inherited by default. Use the model param to override (e.g. 'minimax/MiniMax-M2.7').",
      "Use list_available_models to see which models have configured auth before setting model.",
      "Streams output in real-time when sync.",
      "",
      "Examples:",
      '  - task: "Review this PR for security issues", persona: "You are a senior security auditor"',
      '  - task: "Continue debugging while we plan next steps", async: true, notifyOnComplete: "notify"',
      '  - task: "Summarize the key decisions made in this conversation", model: "anthropic/claude-sonnet-4-5"',
      "",
      "For async (background) execution, the main agent continues immediately.",
      "Use async only if user asked to do so or is willing to continue the conversation.",
      "Use get_subagent_status to poll progress and get_subagent_result to collect output.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_with_context",
        toolCallId: _toolCallId,
        async: params.async ?? false,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: params.notifyOnComplete ?? null,
        maxAge: params.maxAge ?? null,
      });


      // Gather conversation history
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter(
          (e): e is typeof e & { type: "message" } => e.type === "message",
        )
        .map((e) => e.message);

      // ── Async path ──
      if (params.async === true) {
        if (messages.length === 0) {
          return {
            content: [
              { type: "text", text: "No conversation history to inherit." },
            ],
            details: {},
          };
        }

        const llmMessages = convertToLlm(messages);
        const conversationText = serializeConversation(llmMessages);
        const targetCwd = params.cwd ?? ctx.cwd;

        const { jobId, jobPromise, session, liveStatus, modelLabel, modelWarning } =
          await startSubagentJob({
            task: params.task,
            persona: params.persona,
            modelOverride: params.model,
            cwd: targetCwd,
            contextText: conversationText,
            signal: undefined, // async: don't inherit parent signal (would abort subagent when tool returns)
            onUpdate: undefined,
            defaultModel: ctx.model,
            maxAge: params.maxAge,
            parentModelRegistry: ctx.modelRegistry,
          });
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus,
          session,
          startedAt: Date.now(),
          promise: jobPromise,
          modelLabel,
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : params.notifyOnComplete === "notify"
                ? "notify"
                : undefined,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        jobRegistry.set(jobId, jobState);

        // Update footer
        const runningCount = [...jobRegistry.values()].filter(
          (j) => j.status === "running",
        ).length;
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }

        jobPromise.then(
          (result) => {
            if (jobState.status === "cancelled") return;
            jobState.status = result.isError ? "error" : "done";
            jobState.result = result;
            scheduleJobCleanup(jobId, false, jobState.maxAge);

            // Deliver notification if requested
            if (
              jobState.notifyOnComplete &&
              !jobState.notificationDelivered &&
              !jobState.resultRetrieved
            ) {
              deliverNotification(jobState, result);
            }

            const remaining = [...jobRegistry.values()].filter(
              (j) => j.status === "running",
            ).length;
            if (remaining > 0) {
              try {
                ctx.ui.setStatus(
                  FOOTER_KEY,
                  `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
                );
              } catch {
                /* ctx stale */
              }
            } else {
              try {
                ctx.ui.setStatus(FOOTER_KEY, undefined);
              } catch {
                /* ctx stale */
              }
            }
          },
          (error) => {
            // Promise rejection handler — deliver failure notification
            if (jobState.notifyOnComplete && !jobState.notificationDelivered) {
              deliverNotification(jobState, {
                output: `Sub-agent crashed: ${error instanceof Error ? error.message : String(error)}`,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  turns: 0,
                },
                model: undefined,
                isError: true,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
            }
          },
        );

        return {
          content: [
            {
              type: "text",
              text: `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.` +
                (modelWarning ? `\n\n${modelWarning}` : ""),
            },
          ],
          details: {
            jobId,
            status: "started",
            contextMessages: messages.length,
          },
        };
      }

      // ── Sync path ──
      if (messages.length === 0) {
        return {
          content: [
            { type: "text", text: "No conversation history to inherit." },
          ],
          details: {},
        };
      }

      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);

      const targetCwd = params.cwd ?? ctx.cwd;
      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        conversationText,
        signal,
        onUpdate,
        ctx.model,
        ctx.modelRegistry,
      );

      const usageStr = formatUsage(result.usage, result.model);
      const details: Record<string, unknown> = {
        contextMessages: messages.length,
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
      };

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      return renderSubagentCall(args, theme, "subagent_with_context");
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 2: isolated, no conversation history ────────────────────
  pi.registerTool({
    name: "subagent_isolated",
    label: "Sub-Agent (isolated)",
    description: [
      "Spawn an in-process sub-agent with a fresh, empty context window.",
      "Only receives the task and optional persona. No conversation history.",
      "Model is inherited by default. Use the model param to override (e.g. 'minimax/MiniMax-M2.7').",
      "Use list_available_models to see which models have configured auth before setting model.",
      "Streams output in real-time when sync.",
      "",
      "Examples:",
      '  - task: "Propose a README outline for this repo", persona: "You are a technical writer"',
      '  - task: "Give me a second opinion on this approach", model: "anthropic/claude-sonnet-4-5"',
      '  - task: "Analyze this code without context contamination", async: true, notifyOnComplete: "inject"',
      "",
      "For async (background) execution, the main agent continues immediately.",
      "Use get_subagent_status to poll progress and get_subagent_result to collect output.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_isolated",
        toolCallId: _toolCallId,
        async: params.async ?? false,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: params.notifyOnComplete ?? null,
        maxAge: params.maxAge ?? null,
      });


      // ── Async path ──
      if (params.async === true) {
        const targetCwd = params.cwd ?? ctx.cwd;

        const { jobId, jobPromise, session, liveStatus, modelLabel, modelWarning } =
          await startSubagentJob({
            task: params.task,
            persona: params.persona,
            modelOverride: params.model,
            cwd: targetCwd,
            contextText: null, // isolated — no context
            signal: undefined, // async: don't inherit parent signal (would abort subagent when tool returns)
            onUpdate: undefined,
            defaultModel: ctx.model,
            maxAge: params.maxAge,
            parentModelRegistry: ctx.modelRegistry,
          });
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus,
          session,
          startedAt: Date.now(),
          promise: jobPromise,
          modelLabel,
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : params.notifyOnComplete === "notify"
                ? "notify"
                : undefined,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        // Register job FIRST, then wire completion handler with cancellation guard.
        // Note: jobPromise never rejects (internal catch handles all errors).
        jobRegistry.set(jobId, jobState);

        // Update footer to show running subagents
        const runningCount = [...jobRegistry.values()].filter(
          (j) => j.status === "running",
        ).length;
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }

        jobPromise.then(
          (result) => {
            if (jobState.status === "cancelled") return;
            jobState.status = result.isError ? "error" : "done";
            jobState.result = result;
            scheduleJobCleanup(jobId, false, jobState.maxAge);

            // Deliver notification if requested
            if (
              jobState.notifyOnComplete &&
              !jobState.notificationDelivered &&
              !jobState.resultRetrieved
            ) {
              deliverNotification(jobState, result);
            }

            // Update or clear footer status
            const remaining = [...jobRegistry.values()].filter(
              (j) => j.status === "running",
            ).length;
            if (remaining > 0) {
              try {
                ctx.ui.setStatus(
                  FOOTER_KEY,
                  `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
                );
              } catch {
                /* ctx stale */
              }
            } else {
              try {
                ctx.ui.setStatus(FOOTER_KEY, undefined);
              } catch {
                /* ctx stale */
              }
            }
          },
          (error) => {
            // Promise rejection handler — deliver failure notification
            if (jobState.notifyOnComplete && !jobState.notificationDelivered) {
              deliverNotification(jobState, {
                output: `Sub-agent crashed: ${error instanceof Error ? error.message : String(error)}`,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  turns: 0,
                },
                model: undefined,
                isError: true,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
            }
          },
        );

        return {
          content: [
            {
              type: "text",
              text: `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.` +
                (modelWarning ? `\n\n${modelWarning}` : ""),
            },
          ],
          details: { jobId, status: "started" },
        };
      }

      // ── Sync path ──
      const targetCwd = params.cwd ?? ctx.cwd;

      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        null, // no context
        signal,
        onUpdate,
        ctx.model,
        ctx.modelRegistry,
      );

      const usageStr = formatUsage(result.usage, result.model);
      const details: Record<string, unknown> = {
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
      };

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      return renderSubagentCall(args, theme, "subagent_isolated");
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 3: poll async job status ────────────────────────────────
  pi.registerTool({
    name: "get_subagent_status",
    label: "Get Subagent Status",
    description: "Poll an async subagent job by jobId. Returns live preview of the subagent's current turn, active tool, and output.",
    parameters: StatusParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      debugLog("info", "tool_call", {
        toolName: "get_subagent_status",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });


      const job = jobRegistry.get(params.jobId);

      if (!job) {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} not found. It may have been cancelled.`,
            },
          ],
           details: { jobId: params.jobId, status: "not_found" },
          isError: true,
        };
      }

      if (job.status === "done" || job.status === "error") {
        const result = job.result!;
        const usageStr = formatUsage(result.usage, result.model);
        return {
          content: [{ type: "text", text: result.output }],
          details: {
            status: job.status,
            usage: result.usage,
            model: result.model,
            usageSummary: usageStr,
          },
          isError: result.isError,
        };
      }

      if (job.status === "cancelled") {
        return {
          content: [
            { type: "text", text: `Job ${params.jobId} was cancelled.` },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }

      // Job is running — return live preview
      return buildLiveUpdate(job.liveStatus, job.modelLabel);
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("get_subagent_status ")) +
        theme.fg("accent", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, context) {
      const details = result.details as Record<string, unknown> | undefined;
      if (details?.status === "running") {
        // Force isPartial to get the live preview rendering
        return renderSubagentResult(
          result,
          { ...options, isPartial: true },
          theme,
          context,
        );
      }
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 4: block until async job completes ──────────────────────
  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description:
      "Block until an async subagent job completes, then return the final output and usage summary.",
    parameters: ResultParams,

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const job = jobRegistry.get(params.jobId);
      debugLog("info", "tool_call", {
        toolName: "get_subagent_result",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });



      if (!job) {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} not found. It may have been cancelled.`,
            },
          ],
          details: { jobId: params.jobId },
          isError: true,
        };
      }

      if (job.status === "cancelled") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was cancelled before completion.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }

      // Await the job promise. If already settled, resolves immediately.
      // If still running, blocks until completion.
      // Set resultRetrieved BEFORE await to suppress redundant notification
      // (microtask ordering ensures .then() checks this before delivering)
      job.resultRetrieved = true;
      const result = await job.promise;

      // Re-check status: if cancelled during await, return cancelled message
      // rather than the AbortError from the promise chain.
      // TypeScript narrows job.status after the earlier check, but cancellation
      // can happen during the await, so we cast back to the full union.
      if ((job.status as JobStatus) === "cancelled") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was cancelled before completion.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }

      const usageStr = formatUsage(result.usage, result.model);
      const details: Record<string, unknown> = {
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
      };

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("get_subagent_result ")) +
        theme.fg("accent", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 5: cancel a running async job ───────────────────────────
  pi.registerTool({
    name: "cancel_subagent",
    label: "Cancel Subagent",
    description: "Abort a running async subagent job by jobId.",
    parameters: CancelParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = jobRegistry.get(params.jobId);
      debugLog("info", "tool_call", {
        toolName: "cancel_subagent",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });



      if (!job) {
        return {
          content: [{ type: "text", text: `Job ${params.jobId} not found.` }],
          details: { jobId: params.jobId },
          isError: true,
        };
      }

      if (job.status === "cancelled") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was already cancelled.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
        };
      }

      if (job.status === "done" || job.status === "error") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} already completed — cannot cancel.`,
            },
          ],
          details: { jobId: params.jobId, status: job.status },
          isError: true,
        };
      }

      // Abort the session
      try {
        await job.session.abort();
      } catch {
        // Session may already be disposed; abort is best-effort
      }

      // Mark cancelled and remove immediately
      job.status = "cancelled";
      scheduleJobCleanup(params.jobId, true); // immediate removal

      // Update footer status
      const remaining = [...jobRegistry.values()].filter(
        (j) => j.status === "running",
      ).length;
      if (remaining > 0) {
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }
      } else {
        try {
          ctx.ui.setStatus(FOOTER_KEY, undefined);
        } catch {
          /* ctx stale */
        }
      }

      return {
        content: [{ type: "text", text: `Job ${params.jobId} cancelled.` }],
        details: { jobId: params.jobId, status: "cancelled" },
      };
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("cancel_subagent ")) +
        theme.fg("error", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as Record<string, unknown> | undefined;
      const jobId = String(details?.jobId ?? "unknown");
      const cancelled = details?.status === "cancelled";
      const firstContent = result.content?.[0];
      const message =
        firstContent?.type === "text"
          ? firstContent.text
          : `Job ${jobId} not found`;
      const text = cancelled
        ? theme.fg("error", `✕ Job ${jobId} cancelled`)
        : theme.fg("error", message);
      return new Text(text, 0, 0);
    },
  });

  // ── Tool 6: spawn an attachable tmux-backed Pi session ──────────────
  pi.registerTool({
    name: "subagent_interactive",
    label: "Interactive Subagent",
    description: [
      "Spawn a separate Pi process in a tmux pane and return immediately.",
      "Use this when the user wants to attach to the sub-agent session and continue follow-ups there.",
      "Requires running pi inside tmux. The tool returns tmux attach/select commands and the child session file.",
      "This is intentionally separate from SDK subagents: it favors observability and attachability over in-process execution.",
    ].join("\n"),
    parameters: InteractiveParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_interactive",
        toolCallId: _toolCallId,
        taskLength: params.task?.length ?? 0,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        includeContext: params.includeContext ?? false,
      });

      let contextText: string | null = null;
      if (params.includeContext === true) {
        const branch = ctx.sessionManager.getBranch();
        const messages = branch
          .filter(
            (e): e is typeof e & { type: "message" } => e.type === "message",
          )
          .map((e) => e.message);
        contextText = serializeConversation(convertToLlm(messages));
      }

      const taskPreview = params.task.replace(/\s+/g, " ").slice(0, 48);
      const name = params.name ?? `Subagent: ${taskPreview || "interactive"}`;
      const targetCwd = params.cwd ?? ctx.cwd;

		try {
			const state = launchInteractiveSubagent({
				name,
				task: params.task,
				persona: params.persona,
				model: params.model,
				cwd: targetCwd,
				contextText,
				background: params.background, // defaults to true (hidden) inside the helper
				notifyOnUpdate: params.notifyOnUpdate,
			});

			const displayMode = state.windowName ? "background (new window)" : "visible split";
			return {
				content: [
					{
						type: "text",
						text:
							`Interactive sub-agent ${state.id} started (${displayMode}) in tmux pane ${state.paneId}.\n\n` +
							`Artifact: ${state.artifactDir}\n` +
							`Attach: ${state.attachCommand}\n` +
							`From inside tmux: ${state.selectPaneCommand}\n` +
							`Session: ${state.sessionFile}` +
							(state.notifyOnUpdate && state.notifyOnUpdate !== "off"
								? `\n\nWill notify on ${state.notifyOnUpdate} events.`
								: ""),
					},
				],
				details: { ...state, status: "started" },
			};
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to start interactive sub-agent: ${msg}\n${tmuxSetupHint()}`,
            },
          ],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const task = String(args.task ?? "");
      const preview = task.length > 60 ? `${task.slice(0, 57)}…` : task;
      return new Text(
        theme.fg("toolTitle", theme.bold("subagent_interactive ")) +
          theme.fg("accent", String(args.name ?? preview)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as Partial<InteractiveSubagentState> | undefined;
      if ((result as any).isError) {
        const first = result.content?.[0];
        const text = first?.type === "text" ? first.text : "Failed to start interactive sub-agent";
        return new Text(theme.fg("error", text), 0, 0);
      }
      const id = details?.id ?? "unknown";
      const paneId = details?.paneId ?? "unknown";
      return new Text(
        theme.fg("accent", "⚡ ") +
          theme.fg("toolTitle", `Interactive sub-agent ${id}`) +
          theme.fg("dim", ` — pane ${paneId}`),
        0,
        0,
      );
    },
  });

  // ── Tool 7: inspect attachable tmux-backed sessions ────────────────
  pi.registerTool({
    name: "get_interactive_subagent_status",
    label: "Get Interactive Subagent Status",
    description:
      "Inspect tmux-backed interactive subagents. Omit jobId to list all tracked sessions. Returns attach/select commands and session paths without capturing pane output.",
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({ description: "Interactive sub-agent ID returned by subagent_interactive" }),
      ),
    }),

    async execute(_toolCallId, params): Promise<any> {
      pruneDeadInteractiveSubagents();
      const states = params.jobId
        ? [interactiveSubagentRegistry.get(params.jobId)].filter(
            (s): s is InteractiveSubagentState => Boolean(s),
          )
        : [...interactiveSubagentRegistry.values()];

      if (states.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: params.jobId
                ? `Interactive sub-agent ${params.jobId} not found.`
                : "No interactive sub-agents are tracked.",
            },
          ],
          details: { status: "not_found", jobId: params.jobId },
          isError: Boolean(params.jobId),
        };
      }

      const sections = states.map((state) => {
        return formatInteractiveState(state);
      });

      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: {
          count: states.length,
          subagents: states.map((state) => ({ ...state })),
        },
      };
    },
  });

  // ── Tool 8: cancel an attachable tmux-backed session ───────────────
  pi.registerTool({
    name: "cancel_interactive_subagent",
    label: "Cancel Interactive Subagent",
    description: "Kill the tmux pane for an interactive sub-agent by ID.",
    parameters: Type.Object({
      jobId: Type.String({ description: "Interactive sub-agent ID returned by subagent_interactive" }),
    }),

    async execute(_toolCallId, params): Promise<any> {
      const state = cancelInteractiveSubagent(params.jobId);
      if (!state) {
        return {
          content: [{ type: "text", text: `Interactive sub-agent ${params.jobId} not found.` }],
          details: { jobId: params.jobId, status: "not_found" },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Interactive sub-agent ${params.jobId} cancelled.` }],
        details: { ...state },
      };
    },
  });

  // ── Tool: read an interactive sub-agent's artifact ───────────────
  // The artifact (events.ndjson + output.md) is the source of truth for what the
  // sub-agent did. The main agent calls this when it wants to know more than the pointer.
  pi.registerTool({
    name: "read_subagent_artifact",
    label: "Read Subagent Artifact",
    description: [
      "Read an interactive sub-agent's artifact on disk. Returns the lifecycle/WIP events and,",
      "if present, the sub-agent's output.md. Use `since` (unix ms) to fetch only events newer than",
      "your last read.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({ description: "Interactive sub-agent ID returned by subagent_interactive" }),
      since: Type.Optional(Type.Number({ description: "Only return events with ts >= this unix-ms timestamp" })),
      includeOutput: Type.Optional(Type.Boolean({ description: "Include the sub-agent's output.md content (default true)" })),
    }),

    async execute(_toolCallId, params): Promise<any> {
      const state = interactiveSubagentRegistry.get(params.id);
      const art = state
        ? artifactPath(dirname(state.artifactDir), basename(state.artifactDir))
        : findArtifactById(params.id);
      if (!art) {
        return {
          content: [{ type: "text", text: `No artifact found for sub-agent ${params.id}.` }],
          details: { id: params.id, status: "not_found" },
          isError: true,
        };
      }
      const events = readEvents(art, params.since);
      const output = params.includeOutput === false ? null : readOutput(art);
      const lastEvent = events.length > 0 ? events[events.length - 1] : null;
      return {
        content: [
          {
            type: "text",
            text:
              `Artifact for ${params.id} (${events.length} event${events.length === 1 ? "" : "s"}${params.since ? ` since ${params.since}` : ""}).\n` +
              `Last event: ${lastEvent ? `${lastEvent.type} @ ${lastEvent.ts}` : "(none)"}\n` +
              `Output: ${output === null ? "(not written yet)" : `${output.length} chars`}`,
          },
        ],
        details: { id: params.id, artifactDir: art.dir, events, output, lastEvent },
      };
    },
  });

  // ── Tool: list known interactive sub-agent artifacts ─────────────
  pi.registerTool({
    name: "list_subagent_artifacts",
    label: "List Subagent Artifacts",
    description: [
      "List all known interactive sub-agents (in this session and from past sessions whose",
      "artifacts are still on disk). Returns id, name, status, and last-update time. Use",
      "read_subagent_artifact to fetch a specific one.",
    ].join("\n"),
    parameters: Type.Object({}),

    async execute(): Promise<any> {
      pruneDeadInteractiveSubagents();
      const states = [...interactiveSubagentRegistry.values()];
      const summary = states.map((s) => {
        const art = artifactPath(dirname(s.artifactDir), basename(s.artifactDir));
        const last = lastEvent(art);
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          lastEvent: last,
          lastUpdate: last?.ts,
          artifactDir: s.artifactDir,
        };
      });
      if (summary.length === 0) {
        return {
          content: [{ type: "text", text: "No interactive sub-agents are tracked." }],
          details: { count: 0, subagents: [] },
        };
      }
      const lines = summary.map((s) => {
        const ev = s.lastEvent;
        const evStr = ev ? `last: ${ev.type}${ev.message ? ` (${ev.message.slice(0, 60)})` : ""}` : "no events yet";
        return `${s.id}  ${s.name}  ${s.status}  ${evStr}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: summary.length, subagents: summary },
      };
    },
  });

  // ── Tool 6: list available models ────────────────────────────────
  pi.registerTool({
    name: "list_available_models",
    label: "List Available Models",
    description: [
      "List all available AI models that can be used with subagent_with_context or subagent_isolated.",
      "Returns provider/model IDs and auth status. Use this to validate model identifiers before passing",
      "them to subagent tools — prevents silent fallback to the parent session model.",
    ].join("\n"),
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({
          description:
            "Optional substring filter for provider or model name (case-insensitive)",
        }),
      ),
      authOnly: Type.Optional(
        Type.Boolean({
          description:
            "If true, only return models with configured auth (default: true). Set false to see all known models.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const modelRegistry = ctx.modelRegistry;
      debugLog("info", "tool_call", {
        toolName: "list_available_models",
        toolCallId: _toolCallId,
        authOnly: params.authOnly ?? true,
        filter: params.filter ?? null,
      });


      const models =
        params.authOnly !== false
          ? modelRegistry.getAvailable()
          : modelRegistry.getAll();

      let filtered = models;
      if (params.filter) {
        const f = params.filter.toLowerCase();
        filtered = models.filter(
          (m) =>
            m.provider.toLowerCase().includes(f) ||
            m.id.toLowerCase().includes(f) ||
            m.name?.toLowerCase().includes(f),
        );
      }

      const lines = filtered.map(
        (m) =>
          `${m.provider}/${m.id}` +
          (m.name && m.name !== m.id ? `  (${m.name})` : ""),
      );

      const summary =
        params.authOnly !== false
          ? `${filtered.length} model${filtered.length === 1 ? "" : "s"} with auth configured`
          : `${filtered.length} model${filtered.length === 1 ? "" : "s"} total`;

      return {
        content: [
          {
            type: "text",
            text:
              `${summary}\n\n` +
              lines.map((l) => `  ${l}`).join("\n") +
              (filtered.length === 0 ? "\n(no models match)" : ""),
          },
        ],
        details: {
          count: filtered.length,
          models: filtered.map((m) => ({
            provider: m.provider,
            id: m.id,
            name: m.name,
          })),
        },
      };
    },
  });

  // ── Tool 7: prune completed jobs ─────────────────────────────────
  // ── Tool 6: prune completed jobs ─────────────────────────────────
  pi.registerTool({
    name: "prune_subagent_jobs",
    label: "Prune Subagent Jobs",
    description: [
      "Remove all completed and failed subagent jobs from the registry.",
      "Running and cancelled jobs are preserved.",
      "Returns the number of jobs removed.",
    ].join("\n"),
    parameters: Type.Object({}),

    async execute() {
      const before = jobRegistry.size;
      debugLog("info", "tool_call", {
        toolName: "prune_subagent_jobs",
      });


      const removed = pruneCompletedJobs();
      const after = jobRegistry.size;

      return {
        content: [
          {
            type: "text",
            text: `Removed ${removed} completed job${removed === 1 ? "" : "s"}. Registry: ${before} → ${after} jobs.`,
          },
        ],
        details: { removed, before, after },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("prune_subagent_jobs")),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as Record<string, unknown> | undefined;
      const removed = Number(details?.removed ?? 0);
      const text =
        removed > 0
          ? theme.fg(
              "success",
              `✓ Pruned ${removed} job${removed === 1 ? "" : "s"}`,
            )
          : theme.fg("dim", "No completed jobs to prune");
      return new Text(text, 0, 0);
    },
  });

  // ── Session shutdown: abort all jobs and clear registry ──────────
  (pi as any).on?.("session_shutdown", () => {
    const g2 = typeof global !== "undefined" ? global : globalThis;

    // Abort all running subagent sessions before clearing
    for (const job of jobRegistry.values()) {
      if (job.status === "running") {
        try {
          job.session.abort().catch(() => {});
        } catch {
          /* session may already be disposed */
        }
      }
    }

    jobRegistry.clear();
    g2.__piSubagenturaPiRef = undefined;
    g2.__piSubagenturaInjectCount = 0;
  });
}

// ── Re-exports ───────────────────────────────────────────────────────
// Re-export helpers so external consumers (e.g. tests importing from subagent.ts)
// don't need to know about the internal helpers.ts split.
export {
  formatUsage,
  SubagentResult,
  SubagentLiveStatus,
  ACTIVE_TOOL_DEBOUNCE_MS,
  // ── Async exports ──
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
export { interactiveSubagentRegistry } from "./interactive-tmux";
