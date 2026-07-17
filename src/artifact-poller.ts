/**
 * Artifact polling, legacy session-log tailing, and durable completion enqueue.
 *
 * Extracted from src/subagent.ts to keep the extension entry point focused on tool
 * registration and lifecycle management. This module owns the poll interval's per-tick
 * work: walking the artifact directory of every running interactive sub-agent, tail-reading
 * the child's session JSONL, appending legacy tool_activity events, and enqueueing
 * protocol completions for trigger-aware delivery.
 *
 * See src/subagent.ts for the interval setup / teardown and the rehydrate logic.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  artifactPath,
  appendEvent,
  assertNever,
  isCompletionEvent,
  readEventBatch,
  removeInteractiveState,
  updateInteractiveState,
  type CompletionEvent,
  type CompletionOutcome,
  type SubagentArtifact,
  type SubagentEvent,
} from "./artifact";
import {
  deriveInteractiveSubagentStatusFromLifecycle,
  foldInteractiveLifecycle,
  interactiveSubagentRegistry,
  isPaneAliveAsync,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { shouldNotify } from "./notifications";
import { deliveryIdFor, enqueueDelivery, flushDeliveries } from "./delivery";
import { debugLog } from "./helpers";
import { formatActivityRow } from "./rendering";
import { formatWorkflowUsage } from "./workflow-core";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import ndjson from "ndjson";

import { getRunningWorkflowCount, workflowJobRegistry } from "./workflow-jobs";
// ── Footer / Widget Status Keys ────────────────────────────────────────

export const FOOTER_KEY = "subagentura-running";
const WIDGET_KEY = "subagentura-activity";
const WORKFLOW_FOOTER_KEY = "subagentura-workflows";
const WORKFLOW_WIDGET_KEY = "subagentura-workflow-activity";

/** Maximum widget rows before truncation with "… and N more". */
const MAX_WIDGET_ROWS = 10;
const MAX_WORKFLOW_WIDGET_ROWS = 5;

/** Derive delivery status from an already narrowed completion event. */
function deliveryStatusFromEvent(ev: CompletionEvent): CompletionOutcome {
  switch (ev.type) {
    case "done":
      return "done";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    case "completion":
      return ev.outcome;
    default:
      return assertNever(ev);
  }
}
let pollInFlight: Promise<void> | undefined;
// ── Poller ─────────────────────────────────────────────────────────────

/**
 * Poll the artifact directory of every running interactive sub-agent and fire a
 * pointer-only notification for any new events that match the spawner's cadence.
 *
 * Backwards-compatible with sub-agents that finished during parent downtime:
 * we walk the artifact log in physical byte order and advance eventByteCursor.
 */
export function pollArtifactChanges(pi: ExtensionAPI): Promise<void> {
  if (pollInFlight) return pollInFlight;
  const poll = runPollArtifactChanges(pi);
  pollInFlight = poll;
  return poll.finally(() => {
    if (pollInFlight === poll) pollInFlight = undefined;
  });
}

async function runPollArtifactChanges(pi: ExtensionAPI): Promise<void> {
  // Top-level defensive try/catch: the poller runs from a setInterval, so any uncaught throw here
  // would crash the parent pi process. Better to swallow and let the next tick (with a refreshed
  // pi ctx) try again. A stale extension context after session replacement is the most likely cause.
  try {
    const g2 = typeof global !== "undefined" ? global : globalThis;
    const initialPiRef = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
    const interactivePi =
      (g2.__piSubagenturaPiRef as ExtensionAPI | undefined) ?? pi;
    if (!interactivePi) return;

    const states = [...interactiveSubagentRegistry.values()];
    const liveness = await Promise.all(
      states.map(async (state) => {
        try {
          return [state, await isPaneAliveAsync(state)] as const;
        } catch (err) {
          debugLog("error", "poller_liveness_error", {
            stateId: state.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return [state, false] as const;
        }
      }),
    );
    const currentPiRef = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
    if (
      (initialPiRef !== undefined && currentPiRef === undefined) ||
      (currentPiRef !== undefined && currentPiRef !== interactivePi)
    ) {
      return;
    }
    let runningCount = 0;
    const widgetRows: string[] = [];
    const ui = g2.__piSubagenturaUi as ExtensionUIContext | undefined;
    for (const [state, paneAlive] of liveness) {
      if (interactiveSubagentRegistry.get(state.id) !== state) continue;
      // Cancelled is terminal. Unknown means pane liveness is unavailable, so keep polling
      // the artifact log: a later done/error event must still reach the parent.
      // 'exited' is intentionally not skipped: a follow-up user entry can revive it to "running".
      const art = artifactPath(
        dirname(state.artifactDir),
        basename(state.artifactDir),
      );
      // Tail-read the child's session log and synthesize tool_activity events.
      // TUI-widget only — the LLM never sees them.
      tailReadSessionLog(state, art);

      const cursor = state.eventByteCursor ?? 0;
      const batch = readEventBatch(art, cursor);
      const records = batch.records;
      const lifecycle = (state.lifecycle ??= {});
      let nextCursor = cursor;
      for (const record of records) {
        const ev = record.event;
        nextCursor = record.endOffset;
        foldInteractiveLifecycle(lifecycle, ev);
        if ("version" in ev && ev.version === 2 && ev.type === "turn_started") {
          state.activeTurnId = ev.turnId;
        }
        if (!shouldNotify(ev) || !isCompletionEvent(ev)) continue;
        const v2 = ev.type === "completion" ? ev : undefined;
        const mode = state.notifyOnComplete ?? "inject";
        const triggerTurn =
          mode === "inject"
            ? state.triggerTurnOnComplete !== false
            : state.triggerTurnOnComplete === true;
        const turnId = v2?.turnId ?? `legacy-${record.startOffset}`;
        const eventId =
          v2?.eventId ??
          (ev as unknown as { eventId?: string }).eventId ??
          `legacy-${record.startOffset}`;
        const status = deliveryStatusFromEvent(ev);
        enqueueDelivery(state, {
          deliveryId: deliveryIdFor({
            parentSessionId: state.parentSessionId ?? "pi",
            subagentId: state.id,
            turnId,
            mode,
          }),
          subagentId: state.id,
          turnId,
          eventId,
          mode,
          triggerTurn,
          status,
          artifactDir: state.artifactDir,
          output: v2?.output,
          message:
            v2?.errorMessage ??
            v2?.message ??
            (v2?.outputError?.code === "output_too_large"
              ? `Output omitted: ${v2.outputError.bytes} bytes exceeds the ${v2.outputError.maxBytes}-byte snapshot limit.`
              : v2?.outputError?.message) ??
            ("message" in ev ? ev.message : undefined),
          state: "queued",
        });
      }
      nextCursor = batch.endOffset;
      state.eventByteCursor = nextCursor;
      const next = deriveInteractiveSubagentStatusFromLifecycle(
        lifecycle,
        paneAlive,
      );
      if (next !== state.status) state.status = next;
      if (next === "exited") {
        if (lifecycle.processExitCode !== undefined) {
          state.exitCode = lifecycle.processExitCode;
        } else if (lifecycle.completionExitCode !== undefined) {
          state.exitCode = lifecycle.completionExitCode;
        }
      }
      if (state.parentSessionId) {
        updateInteractiveState(state.cwd, state.id, (entry) => {
          entry.eventByteCursor = nextCursor;
          entry.sessionByteCursor = state.lastDeliveredSessionByte ?? 0;
          entry.activeTurnId = state.activeTurnId;
          entry.pendingDeliveries = state.pendingDeliveries ?? [];
          entry.deliveryReceipts = state.deliveryReceipts ?? [];
          entry.lifecycle = state.lifecycle;
        });
      }

      // Only count sub-agents that are actively processing a turn as "running".

      // "exited" is terminal (pane dead) — the sub-agent is done; hide it from the

      // running count and widget even though the for-loop keeps tail-reading its

      // session log (for the user-role revival case in processSessionLogEntry).

      // "idle" is between turns (REPL open, pane alive) — still a live sub-agent

      // awaiting follow-up, so it stays in the count.

      if (state.status === "running" || state.status === "idle") {
        runningCount++;

        widgetRows.push(formatActivityRow(state));
      }
    }
    flushDeliveries(interactivePi, ui);
    for (const state of interactiveSubagentRegistry.values()) {
      const terminal =
        state.status === "cancelled" ||
        state.status === "exited" ||
        state.status === "unknown";
      if (
        terminal &&
        state.parentSessionId &&
        (state.pendingDeliveries?.length ?? 0) === 0
      ) {
        try {
          removeInteractiveState(state.cwd, state.id);
        } catch {
          /* retry cleanup on the next poll */
        }
      }
    }

    // Cap widget rows to prevent TUI overflow.
    if (widgetRows.length > MAX_WIDGET_ROWS) {
      const extra = widgetRows.length - MAX_WIDGET_ROWS;
      widgetRows.length = MAX_WIDGET_ROWS;
      widgetRows.push(`… and ${extra} more`);
    }

    // Paint footer + widget. Both are TUI-only — never reach the LLM.
    if (ui) {
      try {
        ui.setStatus(
          FOOTER_KEY,
          runningCount > 0
            ? `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`
            : undefined,
        );
      } catch {
        /* ui stale */
      }
      try {
        ui.setWidget(
          WIDGET_KEY,
          widgetRows.length > 0 ? widgetRows : undefined,
          {
            placement: "belowEditor",
          },
        );
      } catch {
        /* ui stale */
      }
      // Workflow TUI footer + widget: show running async workflows.
      try {
        const wfCount = getRunningWorkflowCount();
        const workflowRows = formatWorkflowWidgetRows(Date.now());
        ui.setStatus(
          WORKFLOW_FOOTER_KEY,
          wfCount > 0
            ? `⚡ ${wfCount} workflow${wfCount > 1 ? "s" : ""} running`
            : undefined,
        );
        ui.setWidget(
          WORKFLOW_WIDGET_KEY,
          workflowRows.length > 0 ? workflowRows : undefined,
          { placement: "belowEditor" },
        );
      } catch {
        /* ui stale */
      }
    }
  } catch (err) {
    debugLog("error", "poller_error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      registryIds: [...interactiveSubagentRegistry.keys()],
    });
    /* defensive: never let one bad poll tick crash the parent process */
  }
}

function formatWorkflowWidgetRows(now: number): string[] {
  const rows: string[] = [];
  for (const st of workflowJobRegistry.values()) {
    if (st.status !== "running") continue;
    const s = st.snapshot;
    const parts = [
      `${s.agentsSpawned} agent${s.agentsSpawned === 1 ? "" : "s"}`,
      `${s.runningCount ?? 0} running`,
      `${s.tokensSpent} output tokens`,
      ...(s.usage ? [formatWorkflowUsage(s.usage)] : []),
      formatWorkflowElapsed(now - st.startedAt),
    ];
    if (s.currentPhase) parts.push(`phase: ${s.currentPhase}`);
    const last = s.lastMessage ? ` — ${s.lastMessage}` : "";
    rows.push(`◇ ${st.name} (${st.id}): ${parts.join(" · ")}${last}`);
  }
  if (rows.length > MAX_WORKFLOW_WIDGET_ROWS) {
    const extra = rows.length - MAX_WORKFLOW_WIDGET_ROWS;
    rows.length = MAX_WORKFLOW_WIDGET_ROWS;
    rows.push(`… and ${extra} more workflow${extra === 1 ? "" : "s"}`);
  }
  return rows;
}

function formatWorkflowElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Session-log parsing state ─────────────────────────────────────────

/**
 * Per-state ndjson parser instance used to tail-read the child's session JSONL.
 *
 * The parser buffers partial trailing lines internally (via split2 underneath), so we can
 * safely write raw bytes from the file on every poll and let the parser emit complete JSON
 * objects as 'data' events. This replaces a hand-rolled partial-line + cursor scheme that had
 * three latent bugs:
 *   - A 1 MiB per-tick read cap combined with cursor-pinning on a missing newline caused a
 *     permanent re-read loop on any single JSONL line larger than 1 MiB (e.g. a multi-MB tool
 *     call result that the child pi runtime writes as a single line).
 *   - File truncation left the cursor pointing past EOF, silently dropping any post-truncation
 *     content.
 *   - A `require("node:fs").closeSync(fd)` call in the finally block leaked file descriptors on
 *     Node < 22.12 in some bundling paths.
 *
 * Keyed by sub-agent id; one parser per state lives for the lifetime of the process. The parser
 * is destroyed and recreated on file truncation so the buffered partial state is cleared.
 */
const sessionParsers = new Map<string, ReturnType<typeof ndjson.parse>>();

/** Defensive upper bound on the per-tick Buffer.alloc. With ndjson, a partial line is buffered
 * internally across polls, so the cap is no longer required for correctness — it is kept purely
 * to bound worst-case memory if the file explodes in a single tick. 1 MiB is plenty. */
const MAX_SESSION_READ_BYTES = 1 * 1024 * 1024;

/** Get-or-create the per-state session parser and wire its 'data' event to the entry handler. */
function getOrCreateSessionParser(
  state: InteractiveSubagentState,
): ReturnType<typeof ndjson.parse> {
  const existing = sessionParsers.get(state.id);
  if (existing) return existing;
  // strict: false → malformed lines are silently dropped instead of triggering an 'error' event
  // that would force us to recreate the parser mid-stream. Same best-effort delivery semantics as
  // the old hand-rolled try/catch around JSON.parse.
  const parser = ndjson.parse({ strict: false });
  parser.on("data", (entry: unknown) => {
    const art = artifactPath(
      dirname(state.artifactDir),
      basename(state.artifactDir),
    );
    processSessionLogEntry(state, art, entry as any);
  });
  // In non-strict mode the parser does not emit 'error' for bad JSON, but we still attach a no-op
  // handler so an unhandled error event can never crash the process.
  parser.on("error", () => {
    // Drop the broken parser so the next tick creates a fresh one. The cursor is reset in the
    // truncation handler, so this only fires for pathological non-truncation errors.
    sessionParsers.delete(state.id);
  });
  sessionParsers.set(state.id, parser);
  return parser;
}

/** Destroy a state's parser (used on truncation and on state removal). */
function destroySessionParser(state: InteractiveSubagentState): void {
  const parser = sessionParsers.get(state.id);
  if (!parser) return;
  try {
    parser.end();
  } catch {
    // ignore — we're tearing down
  }
  sessionParsers.delete(state.id);
}

// ── Session-log tail-reading ──────────────────────────────────────────

/** Tail-read the child's session JSONL and append `tool_activity` events to events.ndjson.
 *  Updates `state.lastDeliveredSessionByte` so subsequent ticks re-read only new lines. */
function tailReadSessionLog(
  state: InteractiveSubagentState,
  _art: SubagentArtifact,
): void {
  const sessionFile = state.sessionFile;
  if (!sessionFile) return;

  let size: number;
  try {
    size = statSync(sessionFile).size;
  } catch {
    return; // file not yet created by the child
  }

  const initialCursor = state.lastDeliveredSessionByte ?? 0;
  if (size < initialCursor) {
    // File shrunk under us (truncation, rotation, manual edit). Reset cursor and parser and fall
    // through to the read below so any content already written after the truncation is processed in
    // the same tick (e.g. test does truncateSync → writeFileSync → poll). The parser is recreated so the
    // buffered partial state is cleared. Any duplicate tool_activity events are acceptable — the
    // artifact log is best-effort and the LLM never sees these (TUI-widget only).
    state.lastDeliveredSessionByte = 0;
    destroySessionParser(state);
  }
  const cursor = state.lastDeliveredSessionByte ?? 0;
  if (size <= cursor) return;

  // Defensive cap on per-tick allocation. ndjson handles partial lines correctly across writes,
  // so a single multi-MB line split across ticks works fine — no cursor pin.
  const requested = size - cursor;
  const toRead = Math.min(requested, MAX_SESSION_READ_BYTES);
  if (toRead <= 0) return;

  let fd: number;
  try {
    fd = openSync(sessionFile, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const n = readSync(
        fd,
        buf,
        bytesRead,
        toRead - bytesRead,
        cursor + bytesRead,
      );
      if (n <= 0) break;
      bytesRead += n;
    }
    if (bytesRead === 0) return;
    const parser = getOrCreateSessionParser(state);
    parser.write(buf.subarray(0, bytesRead));
    // Always advance the cursor by the bytes we fed the parser. The parser buffers any partial
    // trailing line internally and will emit the completed object on a later write. We do NOT
    // rewind to the last newline the way the old code did — doing so would re-feed the same bytes
    // to the parser and double-emit on the next tick.
    state.lastDeliveredSessionByte = cursor + bytesRead;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed or never opened — ignore */
    }
  }
}

/** Process a single parsed JSONL entry from the session log; append tool_activity events. */
function processSessionLogEntry(
  state: InteractiveSubagentState,
  art: SubagentArtifact,
  entry: Record<string, unknown>,
): void {
  const e = entry as { type?: string; message?: Record<string, unknown> };
  if (e.type !== "message") return;
  const msg = e.message;
  if (!msg) return;

  // New user-role message = a new turn. Clear legacy per-turn session metadata.
  if (msg.role === "user") {
    state.autoDoneForTurnAt = undefined;
    state.lastStopReason = undefined;
    state.lastStopReasonAt = undefined;
    state.lastStopText = undefined;
    if (state.lifecycle && !state.lifecycle.parentCancelled) {
      state.lifecycle.currentTurnId = undefined;
      state.lifecycle.completionTurnId = undefined;
      state.lifecycle.completionOutcome = undefined;
      state.lifecycle.completionSource = undefined;
      state.lifecycle.completionExitCode = undefined;
      state.lifecycle.legacyTerminal = undefined;
    }
    // A user-role entry starts a new turn regardless of how the previous turn ended.
    if (state.status === "exited" || state.status === "idle")
      state.status = "running";
    return;
  }

  // Assistant message: extract tool calls and retain legacy stop metadata.
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    const ts = (msg.timestamp as number) ?? Date.now();
    const stopReason = (msg as { stopReason?: string }).stopReason;
    if (
      stopReason === "stop" ||
      stopReason === "length" ||
      stopReason === "error" ||
      stopReason === "aborted"
    ) {
      state.lastStopReason = stopReason;
      state.lastStopReasonAt = ts;
      if (stopReason === "stop") {
        const text = extractAssistantText(msg.content);
        if (text) state.lastStopText = text;
      }
    }
    for (const rawBlock of msg.content) {
      const block = rawBlock as
        { type?: string; name?: string; arguments?: unknown } | undefined;
      if (!block || block.type !== "toolCall") continue;
      const summary = summarizeToolCall(block.name ?? "", block.arguments);
      if (!summary) continue;
      const ev: SubagentEvent = {
        ts,
        type: "tool_activity",
        status: "running",
        tool: block.name ?? "",
        summary,
      };
      appendEvent(art, ev);
      state.lastToolName = block.name ?? "";
      state.lastToolSummary = summary;
      state.lastActivityAt = ev.ts;
    }
  }
}

/** Concatenate text blocks from an assistant message's content array. Empty string if none. */
function extractAssistantText(content: unknown[]): string {
  let out = "";
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") {
      if (out) out += "\n";
      out += b.text;
    }
  }
  return out;
}

// ── Misc helpers ──────────────────────────────────────────────────────

/** Short, human-readable summary of a tool call. Returns null for uninteresting tools. */
function summarizeToolCall(name: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  switch (name) {
    case "bash": {
      const cmd = typeof a.command === "string" ? a.command : null;
      if (!cmd) return null;
      return cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
    }
    case "write":
    case "edit":
    case "read": {
      const p = typeof a.path === "string" ? a.path : null;
      if (!p) return null;
      return p;
    }
    default:
      return null; // skip grep/find/ls etc. — too noisy for the widget
  }
}
