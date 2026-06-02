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
} from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
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

// Tmux backend imports
import {
  spawnTmuxSubagent,
  getTmuxActivityStatus,
  getTmuxJob,
  listTmuxJobs,
  getTmuxAttachInstructions,
  killTmuxJob,
  checkTmux,
  TMUX_BASE_DIR,
} from "./tmux-spawner";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
  readSubagentActivityFile,
  type SubagentActivityState,
} from "./activity";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  DEFAULT_STATUS_LINE_LIMIT,
  formatStatusLine,
  formatTransitionLine,
  formatWidgetRightLabel,
  observeStatus,
  type StatusSnapshot,
  type SubagentStatusKind,
  type SubagentStatusState,
} from "./status";


import * as fs from "node:fs";
import * as path from "node:path";
import { isTmuxChildMode, activateTmuxChildMode } from "./tmux-child";
import { registerTmuxCommands } from "./tmux-commands";


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
  backend: Type.Optional(
    Type.Union(
      [
        Type.Literal("in-process", {
          description:
            "Run in the same process (default, faster but shares memory)",
        }),
        Type.Literal("tmux", {
          description:
            "Run in a tmux session (slower but allows attach and true isolation)",
        }),
      ],
      {
        description:
          "Execution backend: 'in-process' (default) or 'tmux' (attachable)",
      },
    ),
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

// ── Shutdown Guard ──────────────────────────────────────────────
const SHUTDOWN_KEY = Symbol.for("pi-subagentura/shutdown");

function isShuttingDown(): boolean {
  return (globalThis as any)[SHUTDOWN_KEY] === true;
}

function setShuttingDown(): void {
  (globalThis as any)[SHUTDOWN_KEY] = true;
}

// ── Notification Delivery ───────────────────────────────────────
/**
 * Deliver async subagent completion notification.
 * Reads pi from globalThis to survive module reloads.
 */
function deliverNotification(jobState: JobState, result: SubagentResult): void {
  // Don't deliver during shutdown
  if (isShuttingDown()) return;

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
          [
            {
              customType: "subagent-notify",
              content: `Inject cap exceeded for job ${jobState.id} — degraded to notify. ${summary}`,
              display: true,
              details: { jobId: jobState.id, result, mode: "notify" },
            },
          ] as any,
          { deliverAs: "followUp" } as any,
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
          [
            {
              customType: "subagent-notify",
              content: `⚡ Sub-agent **${jobState.id}** completed — result injected above. ${summary}`,
              display: true,
              details: { jobId: jobState.id, result, mode: "inject" },
            },
          ] as any,
          { deliverAs: "followUp" } as any,
        );
      } finally {
        decrementInjectCount();
      }
    } else {
      // notify mode
      pi.sendMessage!(
        [
          {
            customType: "subagent-notify",
            content: summary,
            display: true,
            details: { jobId: jobState.id, result, mode: "notify" },
          },
        ] as any,
        { deliverAs: "followUp" } as any,
      );
    }
  } catch {
    // pi may be stale after session replacement
  }

  jobState.notificationDelivered = true;
}

/**
 * Build a concise one-line summary for a completed async subagent.
 * Sanitizes output (strips API keys, tokens, secrets).
 */
/** Sanitize a string by redacting common sensitive patterns */
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
  // If running as a tmux subagent (PI_SUBAGENT=1), activate child mode
  if (isTmuxChildMode()) {
    console.log("[subagent] Running in tmux child mode");
    activateTmuxChildMode(pi);
    return;
  }

  // ============================================================================
  // Signal Handlers - Graceful cleanup of orphan tmux sessions
  // ============================================================================

  let cleanupDone = false;

  function cleanupAllSessions(): void {
    const sessions = jobRegistry.values();
    let killed = 0;
    for (const job of sessions) {
      if (job.status === "running" && job.backend === "tmux") {
        try {
          killTmuxJob(job.id);
          killed++;
        } catch {
          // Ignore - session may already be dead
        }
      }
    }
    if (killed > 0) {
      console.log(`[subagent] Cleaned up ${killed} orphan tmux session(s)`);
    }
  }

  function doCleanup(signal: string): void {
    if (cleanupDone) return;
    cleanupDone = true;
    isShuttingDown = true;
    console.log(`[subagent] Received ${signal}, cleaning up...`);
    cleanupAllSessions();
  }

  // Register signal handlers
  process.on("SIGINT", () => {
    doCleanup("SIGINT");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    doCleanup("SIGTERM");
    process.exit(0);
  });

  process.on("exit", () => {
    cleanupAllSessions();
  });

  // Guard flag to prevent operations during shutdown
  let isShuttingDown = false;

  // Persist pi ref for async notification delivery (survives module reload)
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaPiRef = pi;
  g2.__piSubagenturaInjectCount = 0;

  // Ensure base directory exists for tmux backend
  fs.mkdirSync(TMUX_BASE_DIR, { recursive: true });

  // Register tmux commands
  registerTmuxCommands(pi);

  // ── TUI Widget ──────────────────────────────────────────────────────
  let latestCtx: any = null;
  let widgetTimer: ReturnType<typeof setTimeout> | null = null;

  function formatElapsed(startTime: Date): string {
    const seconds = Math.floor((Date.now() - startTime.getTime()) / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // ── Widget line builders ──────────────────────────────────────────
  // Based on pi-interactive-subagents' approach (HazAT). The old version did a
  // manual `padding` calculation that was off by one, which made the closing `│`
  // border disappear and sliced `running` to `runni` when content overflowed.
  // Build lines that are *exactly* `width` visible chars using `visibleWidth` and
  // `truncateToWidth` so borders and content always align regardless of width.

  /**
   * Build a single bordered content line: `│<left padded to fill><right>│`.
   * Output is guaranteed to be exactly `width` visible characters.
   */
  function borderLine(left: string, right: string, width: number): string {
    if (width <= 0) return "";
    if (width === 1) return "\u2502";
    const contentWidth = Math.max(0, width - 2);
    const rightVis = visibleWidth(right);
    if (rightVis >= contentWidth) {
      // Right side alone is too wide: preserve it (truncated) and fill the rest
      // with the right chunk only — avoid overflowing the terminal.
      const truncRight = truncateToWidth(right, contentWidth);
      const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
      return "\u2502" + truncRight + " ".repeat(rightPad) + "\u2502";
    }
    const maxLeft = Math.max(0, contentWidth - rightVis);
    const truncLeft = truncateToWidth(left, maxLeft);
    const leftVis = visibleWidth(truncLeft);
    const pad = Math.max(0, contentWidth - leftVis - rightVis);
    return "\u2502" + truncLeft + " ".repeat(pad) + right + "\u2502";
  }

  /**
   * Build the bordered top line: `┌─ Title ──── info ─┐`.
   * All characters are accounted for within `width`.
   */
  function borderTop(title: string, info: string, width: number): string {
    if (width <= 0) return "";
    if (width === 1) return "\u250c";
    const inner = Math.max(0, width - 2);
    const titlePart = `\u2500 ${title} `;
    const infoPart = ` ${info} \u2500`;
    const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
    const fill = "\u2500".repeat(fillLen);
    const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "\u2500");
    return "\u250c" + content + "\u2510";
  }

  /** Build the bordered bottom line: `└──────────────────┘`. */
  function borderBottom(width: number): string {
    if (width <= 0) return "";
    if (width === 1) return "\u2514";
    const inner = Math.max(0, width - 2);
    return "\u2514" + "\u2500".repeat(inner) + "\u2518";
  }


  // ── Rich status state per job ────────────────────────────────────────
  // Mirrors pi-interactive-subagents: each running job has a
  // SubagentStatusState (starting | active | waiting | stalled | running)
  // derived either from a tmux activity file or synthesized from the
  // in-process liveStatus (turn, activeTool). The widget reads this state
  // to show " active · read 2m " / " waiting 2m " / " stalled 4m " labels.

  interface WidgetJob {
    id: string;
    name: string;
    task: string;
    startedAtMs: number;
    isTmux: boolean;
    /** For tmux jobs: path to the child's activity file. */
    activityFile?: string;
    /**
     * For in-process jobs: a virtual SubagentActivityState synthesized from
     * liveStatus. Tmux jobs read this from disk on every poll.
     */
    virtualActivity?: SubagentActivityState;
    statusState: SubagentStatusState;
    /** Latest cached snapshot — populated by `tickAllJobs` and used by the widget. */
    snapshot: StatusSnapshot;
    /**
     * When true, `stalled` and `recovered` transitions do NOT fire a steer
     * message back to the parent agent. Matches the reference's `interactive`
     * behavior: long-running user-driven agents (planner, iterate) stay quiet.
     * Autonomous agents (scout, worker) ping the parent on stall.
     */
    interactive: boolean;
  }

  const widgetJobs = new Map<string, WidgetJob>();

  // Status refresh interval — fires stalled/recovered transitions on a
  // steady cadence (1s, matching the reference repo), decoupled from the
  // widget render loop so transitions fire even when the widget isn't
  // being painted (e.g. before session_start sets hasUI=true).
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  // ── Per-job activity observation ─────────────────────────────────────

  function observeWidgetJob(job: WidgetJob, now: number): void {
    // For tmux jobs, consult the spawner's authoritative state FIRST. Once the
    // child finishes, the activity recorder is disabled (see activity.ts markDone)
    // and the file goes stale — without this check, the snapshot would flip to
    // "stalled" 60s after completion even though the job is legitimately done.
    if (job.isTmux) {
      const tmuxJob = getTmuxJob(job.id);
      if (tmuxJob?.state === "completed" || tmuxJob?.state === "killed") {
        // Synthesize a "done" observation with a fresh updatedAt so it survives
        // observeStatus's olderThanLastActivity replay guard. We use a high
        // sequence number so any leftover observation from before the
        // completion is treated as older and ignored.
        job.statusState = observeStatus(
          job.statusState,
          {
            snapshot: "present",
            updatedAt: now,
            sequence: Number.MAX_SAFE_INTEGER,
            phase: "done",
            latestEvent: "subagent_done",
            activityLabel: tmuxJob.state === "killed" ? "killed" : "done",
          },
          now,
        );
        return;
      }
    }

    let activity: SubagentActivityState | null = null;


    if (job.activityFile) {
      const read = readSubagentActivityFile(job.activityFile, job.id);
      if (read.ok) {
        activity = read.activity;
      } else {
        // missing / invalid / wrong-id — record as a problem observation so
        // the watchdog can mark it stalled after SNAPSHOT_STALLED_AFTER_MS
        const problemRead = read as { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };
        job.statusState = observeStatus(
          job.statusState,
          { snapshot: problemRead.reason, snapshotError: problemRead.error },
          now,
        );
        return;
      }
    } else if (job.virtualActivity) {
      activity = job.virtualActivity;
    }

    if (!activity) return;

    const scopeToLabel = (scope?: string): string | undefined => {
      if (!scope) return undefined;
      if (scope === "tool") return activity?.toolName;
      return scope;
    };

    job.statusState = observeStatus(
      job.statusState,
      {
        snapshot: "present",
        updatedAt: activity.updatedAt,
        sequence: activity.sequence,
        // Pass phase through unchanged. The activity file's "done" phase is
        // distinct from "waiting" in classifyStatus (status.ts:316-318) which
        // sets statusLabel="done" for the "done" phase. Earlier code translated
        // "done" → "waiting" here, which caused finished jobs to render as
        // "(waiting)" with no done indicator.
        phase: activity.phase,
        active: activity.phase === "active",
        activeScope: activity.activeScope,
        activeSince: activity.activeSince,
        waitingSince: activity.waitingSince,
        latestEvent: activity.latestEvent,
        activityLabel: scopeToLabel(activity.activeScope),
      },
      now,
    );
  }

  function advanceWidgetJob(job: WidgetJob, now: number): void {
    const { nextState, snapshot, transition } = advanceStatusState(job.statusState, now);
    job.statusState = nextState;
    job.snapshot = snapshot;

    // Fire a steer message on stalled/recovered transitions, but only for
    // autonomous (non-interactive) jobs. Interactive jobs (user-driven) stay
    // quiet on purpose — the user is working in the child's pane and a steer
    // would just burn an orchestrator turn on a no-op ping.
    if (transition && !job.interactive) {
      try {
        pi.sendMessage!(
          [
            {
              customType: "subagent-notify",
              content: formatTransitionLine(job.name, snapshot, transition),
              display: true,
              details: { jobId: job.id, snapshot, transition },
            },
          ] as any,
          { deliverAs: "followUp" } as any,
        );
      } catch {
        // pi ref may be stale after session replacement
      }
    }
  }

  /**
   * Single pass: read activity for every tracked job and tick the state
   * machine forward. Called by `statusInterval` (separate from widget refresh
   * so transitions fire on a steady cadence even when the widget isn't visible).
   */
  function tickAllJobs(now: number): void {
    for (const job of widgetJobs.values()) {
      observeWidgetJob(job, now);
      advanceWidgetJob(job, now);
    }
  }

  // ── Widget render ────────────────────────────────────────────────────

  function updateWidget(): void {
    if (!latestCtx?.hasUI || isShuttingDown) return;

    // Sync widgetJobs to the union of currently-running jobs.
    //
    // Tmux jobs are tracked in two places: `jobRegistry` (for the unified
    // widget view, with `backend: "tmux"`) and `tmuxJobRegistry` inside
    // tmux-spawner (for the spawner's lifecycle). Prefer the jobRegistry
    // entry so the widget has the `task` + `liveStatus` available; fall
    // back to the tmux registry for jobs that were started outside the
    // normal spawn path.
    const inProcessJobs = [...jobRegistry.values()].filter(
      (j) => j.status === "running" && j.backend !== "tmux",
    );
    const tmuxFromRegistry = [...jobRegistry.values()].filter(
      (j) => j.status === "running" && j.backend === "tmux",
    );
    const tmuxOnly = listTmuxJobs()
      .filter((j) => j.state === "running")
      .filter((j) => !tmuxFromRegistry.some((r) => r.id === j.id));
    const live = new Map<string, { kind: "in-process" | "tmux"; job: any }>();
    for (const j of inProcessJobs) live.set(j.id, { kind: "in-process", job: j });
    for (const j of tmuxFromRegistry) live.set(j.id, { kind: "tmux", job: j });
    for (const j of tmuxOnly) live.set(j.id, { kind: "tmux", job: j });

    // Drop stale entries (job finished)
    for (const id of [...widgetJobs.keys()]) {
      if (!live.has(id)) widgetJobs.delete(id);
    }

    // Add new entries or update existing ones
    for (const [id, entry] of live) {
      let wj = widgetJobs.get(id);
      const isTmux = entry.kind === "tmux";
      const startedAtMs = entry.job.startedAt ?? entry.job.createdAt?.getTime?.() ?? Date.now();
      const task = entry.job.task ?? "";
      const name = isTmux ? `tmux ${id.slice(0, 8)}` : id.slice(0, 8);

      if (!wj) {
        wj = {
          id,
          name,
          task,
          startedAtMs,
          isTmux,
          statusState: createStatusState({ source: "pi", startTimeMs: startedAtMs }),
          snapshot: classifyStatus(
            createStatusState({ source: "pi", startTimeMs: startedAtMs }),
            Date.now(),
          ),
          interactive: false,
        };
        widgetJobs.set(id, wj);
      }

      wj.task = task;
      wj.startedAtMs = startedAtMs;
      if (isTmux) {
        // Guard against undefined sessionDir: TmuxJobState.sessionDir is optional,
        // and any future code path that registers a tmux job without one would
        // produce a literal "undefined/subagent-activity/<id>.json" path.
        if (entry.job.sessionDir) {
          wj.activityFile = path.join(entry.job.sessionDir, "subagent-activity", `${id}.json`);
        } else {
          wj.activityFile = undefined;
        }
        delete wj.virtualActivity;
      } else {
        // In-process: synthesize an activity state from liveStatus.
        const liveStatus = entry.job.liveStatus;
        const now = Date.now();
        const turns = liveStatus?.usage?.turns ?? 0;
        const activeTool = liveStatus?.activeTool;
        const isActive = !!activeTool;
        wj.virtualActivity = {
          version: 1,
          runningChildId: id,
          createdAt: startedAtMs,
          updatedAt: now,
          sequence: turns,
          latestEvent: isActive ? "tool_execution_start" : "turn_end",
          phase: isActive ? "active" : turns > 0 ? "waiting" : "starting",
          agentActive: turns > 0,
          turnActive: false,
          providerActive: false,
          toolActive: isActive,
          activeScope: isActive ? "tool" : undefined,
          activeSince: isActive ? now : undefined,
          waitingSince: !isActive && turns > 0 ? now : undefined,
          turnIndex: liveStatus?.turn,
          toolName: activeTool?.name,
        };
        delete wj.activityFile;
      }
    }

    if (widgetJobs.size === 0) {
      latestCtx.ui.setWidget("subagent-status", undefined);
      if (widgetTimer) {
        clearTimeout(widgetTimer);
        widgetTimer = null;
      }
      return;
    }

    // Build widget lines. The first DEFAULT_STATUS_LINE_LIMIT (4) jobs get
    // a line each; the rest collapse into a single "+N more running" line.
    const allWidgetJobs = [...widgetJobs.values()];
    const { visibleLines, overflow } = capStatusLines(
      allWidgetJobs.map((j) => formatStatusLine(j.name, j.snapshot)),
      DEFAULT_STATUS_LINE_LIMIT,
    );

    latestCtx.ui.setWidget(
      "subagent-status",
      (_tui: any, _theme: any) => {
        return {
          invalidate() {},
          render(width: number) {
            const w = Math.max(20, width);
            const lines: string[] = [];

            // Top line with title. Show "X of Y running (+N more)" when capped.
            const count = widgetJobs.size;
            const info =
              overflow > 0
                ? `${visibleLines.length} of ${count} running (+${overflow} more)`
                : `${count} running`;
            lines.push(borderTop("Subagents", info, w));

            // Per-job lines: right label is the rich status snapshot, left is task+elapsed
            for (const j of allWidgetJobs.slice(0, visibleLines.length)) {
              const elapsed = formatElapsed(new Date(j.startedAtMs));
              const backend = j.isTmux ? "tmux" : "proc";
              const left = ` ${elapsed}  ${j.task} `;
              const right = ` ${backend} · ${formatWidgetRightLabel(j.snapshot).trim()} `;
              lines.push(borderLine(left, right, w));
            }

            // Overflow line
            if (overflow > 0) {
              const left = ` +${overflow} more running `;
              const right = "";
              lines.push(borderLine(left, right, w));
            }

            lines.push(borderBottom(w));
            return lines;
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  function stopWidgetRefresh(): void {
    if (widgetTimer) {
      clearTimeout(widgetTimer);
      widgetTimer = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
    // Drop the captured ctx so any in-flight scheduled callback that already
    // passed the hasUI guard cannot reach a stale ctx after session replacement.
    latestCtx = null;
  }

  function scheduleWidgetUpdate(): void {
    if (isShuttingDown) return;
    try {
      if (!latestCtx?.hasUI) return;
      updateWidget();
    } catch (err) {
      // Captured ctx may have been invalidated by a session replacement/reload
      // that happened after this callback was scheduled. Stop refreshing so we
      // don't crash pi with an uncaughtException on the next tick.
      stopWidgetRefresh();
      return;
    }
    if (isShuttingDown) return;
    widgetTimer = setTimeout(scheduleWidgetUpdate, 1000);
  }

  function startWidgetRefresh(): void {
    if (widgetTimer) return;
    scheduleWidgetUpdate();
    if (!statusInterval) {
      // Steady cadence for stalled/recovered transitions, decoupled from
      // widget rendering. 1s matches the reference repo.
      statusInterval = setInterval(() => {
        if (isShuttingDown || !latestCtx?.hasUI) return;
        try {
          tickAllJobs(Date.now());
        } catch {
          // Captured ctx may be stale; let the next tick recover
        }
      }, 1000);
      statusInterval.unref?.();
    }
  }

  // Capture UI context for widget updates
  pi.on("session_start", (_event: any, ctx: any) => {
    latestCtx = ctx;
    startWidgetRefresh();
  });

  // Register notification renderer before any tools
  (pi as any).registerMessageRenderer?.(
    "subagent-notify",
    (message: any, options: any, theme: Theme) => {
      return renderSubagentNotify(message, options, theme);
    },
  );

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

      // ── Tmux backend path ──
      if (params.backend === "tmux") {
        const tmuxAvailable = await checkTmux();
        if (!tmuxAvailable) {
          return {
            content: [
              {
                type: "text",
                text: "Error: tmux is required for tmux backend. Install with: brew install tmux",
              },
            ],
            isError: true,
            details: {},
          };
        }

        const targetCwd = params.cwd ?? ctx.cwd;
        const contextMode: "isolated" | "with_context" = "with_context";

        const jobId = await spawnTmuxSubagent(
          params.task,
          contextMode,
          targetCwd,
          (exitData) => {
            // Handle completion callback
            const job = getTmuxJob(jobId);
            if (!job) return;

            const result: SubagentResult = {
              output: exitData.output || "(no output)",
              usage: exitData.usage || {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                turns: 0,
              },
              model: exitData.model,
              isError:
                exitData.type === "error" || exitData.type === "cancelled",
              errorMessage: exitData.errorMessage,
            };

            // Deliver notification if requested
            const jobState = jobRegistry.get(jobId);
            if (jobState?.notifyOnComplete && !jobState.notificationDelivered) {
              deliverNotification(jobState, result);
            }

            // Update widget to remove completed job
            updateWidget();
          },
        );

        // Add to in-process registry for tracking
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus: {
            turn: 0,
            output: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
            },
          },
          session: null as any,
          startedAt: Date.now(),
          promise: new Promise(() => {}),
          // Default to "notify" for tmux backend: the child runs in a separate
          // tmux pane invisible to the parent TUI, so a brief completion
          // notification is the user's only signal. "inject" is preserved
          // when explicitly requested; unspecified → "notify" (was: undefined).
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : "notify",
          notificationDelivered: false,
          maxAge: params.maxAge,
          backend: "tmux",
        };
        jobRegistry.set(jobId, jobState);

        // Update widget
        updateWidget();

        const attachInstructions = getTmuxAttachInstructions(jobId);
        return {
          content: [
            {
              type: "text",
              text:
                `Tmux subagent spawned: ${jobId}` +
                (attachInstructions ? `\n\n${attachInstructions}` : ""),
            },
          ],
          details: { jobId, backend: "tmux", status: "started" },
        };
      }

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

        const {
          jobId,
          jobPromise,
          session,
          liveStatus,
          modelLabel,
          modelWarning,
        } = await startSubagentJob({
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

            // Update widget to reflect completion
            updateWidget();

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
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.` +
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
        backend: params.backend ?? null,
      });

      // ── Tmux backend path ──
      if (params.backend === "tmux") {
        const tmuxAvailable = await checkTmux();
        if (!tmuxAvailable) {
          return {
            content: [
              {
                type: "text",
                text: "Error: tmux is required for tmux backend. Install with: brew install tmux",
              },
            ],
            isError: true,
            details: {},
          };
        }

        const targetCwd = params.cwd ?? ctx.cwd;
        const contextMode: "isolated" | "with_context" = "isolated";

        const jobId = await spawnTmuxSubagent(
          params.task,
          contextMode,
          targetCwd,
          (exitData) => {
            const job = getTmuxJob(jobId);
            if (!job) return;

            const result: SubagentResult = {
              output: exitData.output || "(no output)",
              usage: exitData.usage || {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                turns: 0,
              },
              model: exitData.model,
              isError:
                exitData.type === "error" || exitData.type === "cancelled",
              errorMessage: exitData.errorMessage,
            };

            const jobState = jobRegistry.get(jobId);
            if (jobState?.notifyOnComplete && !jobState.notificationDelivered) {
              deliverNotification(jobState, result);
            }

            // Update widget to remove completed job
            updateWidget();
          },
        );

        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus: {
            turn: 0,
            output: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
            },
          },
          session: null as any,
          startedAt: Date.now(),
          promise: new Promise(() => {}),
          // Default to "notify" for tmux backend: the child runs in a separate
          // tmux pane invisible to the parent TUI, so a brief completion
          // notification is the user's only signal. "inject" is preserved
          // when explicitly requested; unspecified → "notify" (was: undefined).
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : "notify",
          notificationDelivered: false,
          maxAge: params.maxAge,
          backend: "tmux",
        };
        jobRegistry.set(jobId, jobState);

        updateWidget();

        const attachInstructions = getTmuxAttachInstructions(jobId);
        return {
          content: [
            {
              type: "text",
              text:
                `Tmux subagent spawned: ${jobId}` +
                (attachInstructions ? `\n\n${attachInstructions}` : ""),
            },
          ],
          details: { jobId, backend: "tmux", status: "started" },
        };
      }

      // ── Async path ──
      if (params.async === true) {
        const targetCwd = params.cwd ?? ctx.cwd;

        const {
          jobId,
          jobPromise,
          session,
          liveStatus,
          modelLabel,
          modelWarning,
        } = await startSubagentJob({
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

            // Update widget to reflect completion
            updateWidget();

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
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.` +
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
    description:
      "Poll an async subagent job by jobId. Returns live preview of the subagent's current turn, active tool, and output.",
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

      // Handle tmux jobs
      if (job.backend === "tmux") {
        const tmuxJob = getTmuxJob(params.jobId);
        if (!tmuxJob) {
          return {
            content: [
              {
                type: "text",
                text: `Job ${params.jobId} not found. Tmux session may have ended.`,
              },
            ],
            details: { jobId: params.jobId, status: "not_found" },
            isError: true,
          };
        }

        if (tmuxJob.state === "completed" || tmuxJob.state === "killed") {
          const exitData = tmuxJob.exitData;
          const result = {
            output: exitData?.output || "(no output)",
            usage: exitData?.usage || {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
            },
            model: exitData?.model,
            isError: tmuxJob.state === "killed",
            errorMessage: exitData?.errorMessage,
          };
          const usageStr = formatUsage(result.usage, result.model);
          return {
            content: [{ type: "text", text: result.output }],
            details: {
              status: tmuxJob.state,
              usage: result.usage,
              model: result.model,
              usageSummary: usageStr,
              backend: "tmux",
            },
            isError: result.isError,
          };
        }

        if (tmuxJob.state === "attached") {
          return {
            content: [
              {
                type: "text",
                text: `Job ${params.jobId} is attached to tmux. You can interact with it via tmux attach -t ${params.jobId}`,
              },
            ],
            details: {
              jobId: params.jobId,
              status: "attached",
              backend: "tmux",
            },
          };
        }

        // Running - get activity status
        const activity = getTmuxActivityStatus(params.jobId);
        if (activity) {
          const output = `Phase: ${activity.phase}, Scope: ${activity.scope}, Event: ${activity.event}`;
          return {
            content: [{ type: "text", text: output }],
            details: {
              status: "running",
              phase: activity.phase,
              scope: activity.scope,
              event: activity.event,
              backend: "tmux",
            },
          };
        }

        return {
          content: [
            { type: "text", text: `Job ${params.jobId} is running (tmux)` },
          ],
          details: { jobId: params.jobId, status: "running", backend: "tmux" },
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
      "USE ONLY IF USER ASKED TO;Block until an async subagent job completes, then return the final output and usage summary. For tmux backend, returns immediately with current status if the job hasn't completed yet.",
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

      // Handle tmux jobs
      if (job.backend === "tmux") {
        const tmuxJob = getTmuxJob(params.jobId);
        if (!tmuxJob) {
          return {
            content: [
              {
                type: "text",
                text: `Job ${params.jobId} not found. Tmux session may have ended.`,
              },
            ],
            details: { jobId: params.jobId, status: "not_found" },
            isError: true,
          };
        }

        if (tmuxJob.state === "completed") {
          const exitData = tmuxJob.exitData;
          const result: SubagentResult = {
            output: exitData?.output || "(no output)",
            usage: exitData?.usage || {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0,
            },
            model: exitData?.model,
            isError: false,
            errorMessage: exitData?.errorMessage,
          };
          const usageStr = formatUsage(result.usage, result.model);
          return {
            content: [{ type: "text", text: result.output }],
            details: {
              usage: result.usage,
              model: result.model,
              usageSummary: usageStr,
              backend: "tmux",
            },
            isError: result.isError,
          };
        }

        if (tmuxJob.state === "killed") {
          return {
            content: [
              {
                type: "text",
                text: `Job ${params.jobId} was cancelled.`,
              },
            ],
            details: {
              jobId: params.jobId,
              status: "cancelled",
              backend: "tmux",
            },
            isError: true,
          };
        }

        // Still running - for tmux we can't block, so return current status
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} is still running. Use get_subagent_status to check progress, or attach via: tmux attach -t ${params.jobId}`,
            },
          ],
          details: { jobId: params.jobId, status: "running", backend: "tmux" },
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

      // Handle tmux jobs
      if (job.backend === "tmux") {
        const success = killTmuxJob(params.jobId);
        if (success) {
          job.status = "cancelled";
          scheduleJobCleanup(params.jobId, true);
          updateWidget();
          return {
            content: [
              { type: "text", text: `Job ${params.jobId} cancelled (tmux).` },
            ],
            details: { jobId: params.jobId, status: "cancelled" },
          };
        } else {
          return {
            content: [
              { type: "text", text: `Failed to cancel job ${params.jobId}.` },
            ],
            details: { jobId: params.jobId, status: job.status },
            isError: true,
          };
        }
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
    isShuttingDown = true;
    // Stop the recurring widget refresh and drop the captured ctx BEFORE
    // the runtime invalidates the ctx, so the next scheduled tick of
    // scheduleWidgetUpdate cannot reach a stale ctx and crash pi.
    stopWidgetRefresh();
    const g2 = typeof global !== "undefined" ? global : globalThis;

    // Abort all running subagent sessions before clearing
    for (const job of jobRegistry.values()) {
      if (job.status === "running") {
        try {
          if (job.backend === "tmux") {
            killTmuxJob(job.id);
          } else {
            job.session.abort().catch(() => {});
          }
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
