import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type {
  JobState,
  NotifyOnComplete,
  SubagentResult,
  Usage,
} from "./helpers";
import { formatUsage, jobRegistry } from "./helpers";
import { isCompletionEvent, type SubagentEvent } from "./artifact";
import type { InteractiveSubagentState } from "./interactive-tmux";

/**
 * @deprecated Delivery is queue-bounded rather than concurrency-capped.
 * Retained as a runtime export for compatibility with existing consumers.
 */
export const MAX_INJECT = 5;

/** @deprecated Always reports zero; the inject concurrency cap was removed. */
export function getInjectCount(): number {
  return 0;
}

export const MAX_IN_PROCESS_DELIVERY_RECORDS = 32;
export const MAX_IN_PROCESS_DELIVERY_BYTES = 256 * 1024;
const MAX_IN_PROCESS_OUTPUT_BYTES = 32 * 1024;
const MAX_IN_PROCESS_FLUSH_BYTES = 64 * 1024;

interface PendingJobCompletion {
  kind: "completion";
  deliveryId: string;
  ownerPi: ExtensionAPI;
  ownerSessionId?: string;
  jobState: JobState;
  result: SubagentResult;
}

interface PendingJobOverflow {
  kind: "overflow";
  deliveryId: string;
  ownerPi: ExtensionAPI;
  ownerSessionId?: string;
  overflowPath: string;
  mode: NotifyOnComplete;
  triggerTurn: boolean;
  status: "done" | "error";
}

type PendingJobDelivery = PendingJobCompletion | PendingJobOverflow;

function pendingJobDeliveries(): PendingJobDelivery[] {
  const g = globalThis as any;
  return (g.__piSubagenturaPendingJobDeliveries ??= []);
}

function pendingDeliveryBytes(queue: PendingJobDelivery[]): number {
  return queue.reduce((total, pending) => {
    if (pending.kind === "overflow") {
      return total + Buffer.byteLength(pending.overflowPath, "utf8") + 128;
    }
    return (
      total +
      Buffer.byteLength(pending.deliveryId, "utf8") +
      Buffer.byteLength(pending.jobState.id, "utf8") +
      Buffer.byteLength(pending.result.output, "utf8") +
      Buffer.byteLength(
        pending.result.isError ? pending.result.errorMessage : "",
        "utf8",
      ) +
      256
    );
  }, 0);
}

function appendOverflowIdentity(
  path: string,
  pending: PendingJobCompletion,
): void {
  appendFileSync(
    path,
    `${JSON.stringify({
      deliveryId: pending.deliveryId,
      jobId: pending.jobState.id,
      mode: pending.jobState.notifyOnComplete ?? "inject",
      triggerTurn:
        (pending.jobState.notifyOnComplete ?? "inject") === "inject"
          ? pending.jobState.triggerTurnOnComplete !== false
          : pending.jobState.triggerTurnOnComplete === true,
      status: pending.result.isError ? "error" : "done",
    })}\n`,
    { mode: 0o600 },
  );
}

function mergeJobOverflowSemantics(
  summary: PendingJobOverflow,
  collapsed: PendingJobCompletion,
): void {
  const mode = collapsed.jobState.notifyOnComplete ?? "inject";
  const trigger = completionTriggersTurn(
    mode,
    collapsed.jobState.triggerTurnOnComplete,
  );
  if (mode === "inject") summary.mode = "inject";
  if (trigger) summary.triggerTurn = true;
  if (collapsed.result.isError) summary.status = "error";
}

function collapseOldestJobDelivery(queue: PendingJobDelivery[]): void {
  const summary = queue.find(
    (pending): pending is PendingJobOverflow => pending.kind === "overflow",
  );
  const oldestIndex = queue.findIndex(
    (pending) => pending.kind === "completion",
  );
  if (oldestIndex < 0) return;
  const [oldest] = queue.splice(oldestIndex, 1) as [PendingJobCompletion];
  const overflowPath =
    summary?.overflowPath ??
    join(
      tmpdir(),
      `pi-subagentura-delivery-overflow-${process.pid}-${randomUUID()}.ndjson`,
    );
  appendOverflowIdentity(overflowPath, oldest);
  if (summary) {
    mergeJobOverflowSemantics(summary, oldest);
    return;
  }
  let second: PendingJobCompletion | undefined;
  const secondIndex = queue.findIndex(
    (pending) => pending.kind === "completion",
  );
  if (secondIndex >= 0) {
    [second] = queue.splice(secondIndex, 1) as [PendingJobCompletion];
    appendOverflowIdentity(overflowPath, second);
  }
  const overflow: PendingJobOverflow = {
    kind: "overflow",
    deliveryId: createHash("sha256")
      .update(`in-process-overflow\0${oldest.deliveryId}`)
      .digest("hex")
      .slice(0, 32),
    ownerPi: oldest.ownerPi,
    ownerSessionId: oldest.ownerSessionId,
    overflowPath,
    mode: "notify",
    triggerTurn: false,
    status: "done",
  };
  mergeJobOverflowSemantics(overflow, oldest);
  if (second) mergeJobOverflowSemantics(overflow, second);
  queue.unshift(overflow);
}

// ── Notification Delivery ───────────────────────────────────────

export type CompletionDeliveryStatus = "done" | "error" | "cancelled";

interface CompletionNotificationUi {
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface CompletionDeliveryNotice {
  label: string;
  mode: NotifyOnComplete;
  triggerTurn: boolean;
  status: CompletionDeliveryStatus;
}

export function completionTriggersTurn(
  mode: NotifyOnComplete,
  override?: boolean,
): boolean {
  return mode === "inject" ? override !== false : override === true;
}

export function formatCompletionDeliveryBehavior(
  mode: NotifyOnComplete,
  triggerTurn: boolean,
  phase: "planned" | "delivered",
): string {
  const injected =
    mode === "inject"
      ? phase === "planned"
        ? "Completion output will be injected into the parent LLM."
        : "Completion output was injected into the parent LLM."
      : phase === "planned"
        ? "Completion output will not be injected into the parent LLM; only an artifact pointer will be added to parent context."
        : "Completion output was not injected into the parent LLM; only an artifact pointer was added to parent context.";
  const timing =
    phase !== "planned"
      ? ""
      : triggerTurn
        ? " Delivery uses Pi's native follow-up queue if the parent is busy."
        : " Delivery will wait until the parent is idle.";
  if (!triggerTurn) {
    const visibility =
      mode === "inject"
        ? " The injected output will be visible to the LLM on its next turn."
        : " The artifact pointer will be visible to the LLM on its next turn.";
    return `${injected}${timing} No new parent turn will start automatically.${visibility}`;
  }
  const delivery = mode === "inject" ? "the injection" : "the pointer delivery";
  return `${injected}${timing} A new parent turn will start automatically after ${delivery}.`;
}

export function notifyCompletionDelivery(
  ui: CompletionNotificationUi | undefined,
  notices: CompletionDeliveryNotice[],
): void {
  if (!ui || typeof ui.notify !== "function" || notices.length === 0) return;
  const lines = notices.map((notice) => {
    const behavior = formatCompletionDeliveryBehavior(
      notice.mode,
      notice.triggerTurn,
      "delivered",
    );
    return `${notice.label} (${notice.status}). ${behavior}`;
  });
  const message =
    lines.length === 1
      ? lines[0]
      : `${lines.length} sub-agent completions delivered:\n${lines
          .map((line) => `- ${line}`)
          .join("\n")}`;
  const level = notices.some(({ status }) => status === "error")
    ? "error"
    : notices.some(({ status }) => status === "cancelled")
      ? "warning"
      : "info";
  try {
    ui.notify(message, level);
  } catch {
    /* stale UI context must not make durable completion delivery retry */
  }
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

function completionMessageOptions(triggerTurnOnComplete?: boolean): {
  deliverAs: "followUp";
  triggerTurn?: true;
} {
  if (triggerTurnOnComplete) {
    return { deliverAs: "followUp", triggerTurn: true };
  }
  return { deliverAs: "followUp" };
}

/**
 * Deliver async subagent completion notification.
 * Reads pi from globalThis to survive module reloads.
 */
export function deliverNotification(
  jobState: JobState,
  result: SubagentResult,
): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  const pi = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
  if (!pi) return; // extension not loaded yet

  const mode = jobState.notifyOnComplete ?? "inject";
  const ownerSessionId = g2.__piSubagenturaSessionManager?.getSessionId?.();
  const deliveryId = createHash("sha256")
    .update(`${jobState.id}\0${mode}`)
    .digest("hex")
    .slice(0, 32);
  const queue = pendingJobDeliveries();
  if (!queue.some((item) => item.deliveryId === deliveryId)) {
    const output = Buffer.from(result.output, "utf8")
      .subarray(0, MAX_IN_PROCESS_OUTPUT_BYTES)
      .toString("utf8");
    const boundedResult: SubagentResult = result.isError
      ? {
          ...result,
          output,
          errorMessage: result.errorMessage.slice(0, 500),
        }
      : { ...result, output };
    queue.push({
      kind: "completion",
      deliveryId,
      ownerPi: pi,
      ownerSessionId,
      jobState,
      result: boundedResult,
    });
    while (
      queue.length > MAX_IN_PROCESS_DELIVERY_RECORDS ||
      pendingDeliveryBytes(queue) > MAX_IN_PROCESS_DELIVERY_BYTES
    ) {
      collapseOldestJobDelivery(queue);
    }
  }
  requestInProcessDeliveryFlush();
}

function requestInProcessDeliveryFlush(): void {
  const g = globalThis as any;
  if (!g.__piSubagenturaParentStreaming) {
    flushInProcessDeliveries();
    return;
  }
  if (g.__piSubagenturaInProcessFlushScheduled) return;
  g.__piSubagenturaInProcessFlushScheduled = true;
  queueMicrotask(() => {
    g.__piSubagenturaInProcessFlushScheduled = false;
    flushInProcessDeliveries();
  });
}

export function flushInProcessDeliveries(): void {
  const g = globalThis as any;
  const pi = g.__piSubagenturaPiRef as ExtensionAPI | undefined;
  if (!pi) return;
  const currentSessionId = g.__piSubagenturaSessionManager?.getSessionId?.();
  const queue = pendingJobDeliveries();
  const llm: Array<{
    pending: PendingJobDelivery;
    content: string;
    mode: NotifyOnComplete;
    trigger: boolean;
    status: "done" | "error";
  }> = [];
  let bytes = 0;
  for (let index = 0; index < queue.length;) {
    const pending = queue[index];
    const crossedSession =
      pending.ownerSessionId !== undefined &&
      currentSessionId !== undefined &&
      pending.ownerSessionId !== currentSessionId;
    if (crossedSession) {
      queue.splice(index, 1);
      continue;
    }
    if (pending.kind === "overflow") {
      const content =
        "⚠️ In-process completion delivery overflowed its bounded queue." +
        `\nCompletion identity ledger: ${pending.overflowPath}`;
      const itemBytes = Buffer.byteLength(content, "utf8");
      if (llm.length > 0 && bytes + itemBytes > MAX_IN_PROCESS_FLUSH_BYTES)
        break;
      llm.push({
        pending,
        content,
        mode: pending.mode,
        trigger: pending.triggerTurn,
        status: pending.status,
      });
      bytes += itemBytes;
      index++;
      continue;
    }
    const { jobState, result, deliveryId } = pending;
    const mode = jobState.notifyOnComplete ?? "inject";
    const trigger = completionTriggersTurn(
      mode,
      jobState.triggerTurnOnComplete,
    );
    const summary = buildNotifySummary(jobState.id, result);
    const content =
      mode === "inject"
        ? `${summary}\n[Untrusted sub-agent output]\n${
            sanitizeOutput(result.output) || "(sub-agent produced no output)"
          }`
        : `${summary}\nResult retained in job ${jobState.id}; use get_subagent_result for details.`;
    const itemBytes = Buffer.byteLength(content, "utf8");
    if (llm.length > 0 && bytes + itemBytes > MAX_IN_PROCESS_FLUSH_BYTES) break;
    llm.push({
      pending,
      content,
      mode,
      trigger,
      status: result.isError ? "error" : "done",
    });
    bytes += itemBytes;
    index++;
  }
  if (llm.length === 0) return;
  const triggersTurn = llm.some(({ trigger }) => trigger);
  if (g.__piSubagenturaParentStreaming && !triggersTurn) return;
  const deliveryIds = llm.map(({ pending }) => pending.deliveryId);
  try {
    pi.sendMessage(
      {
        customType: "subagent-notify",
        content: llm.map(({ content }) => content).join("\n\n---\n\n"),
        display: true,
        details: {
          deliveryIds,
          ...(llm.length === 1 && llm[0].pending.kind === "completion"
            ? { jobId: llm[0].pending.jobState.id }
            : {}),
          mode: llm.some(({ mode }) => mode === "inject") ? "inject" : "notify",
          statuses: llm.map(({ status }) => status),
          status: llm.some(({ status }) => status === "error")
            ? "error"
            : "done",
          error: llm.some(({ status }) => status === "error"),
        },
      },
      {
        deliverAs: "followUp",
        triggerTurn: triggersTurn,
      },
    );
  } catch {
    return;
  }
  notifyCompletionDelivery(
    g.__piSubagenturaUi as CompletionNotificationUi | undefined,
    llm.map(({ pending, mode, trigger, status }) => ({
      label:
        pending.kind === "completion"
          ? `Job ${pending.jobState.id}`
          : "In-process completion overflow",
      mode,
      triggerTurn: trigger,
      status,
    })),
  );
  for (const { pending } of llm) {
    if (pending.kind === "overflow") markOverflowDelivered(pending);
    else pending.jobState.notificationDelivered = true;
  }
  const delivered = new Set(deliveryIds);
  const remaining = queue.filter(
    (pending) => !delivered.has(pending.deliveryId),
  );
  queue.splice(0, queue.length, ...remaining);
}

function markOverflowDelivered(pending: PendingJobOverflow): void {
  try {
    const lines = readFileSync(pending.overflowPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as { jobId?: string };
        if (record.jobId) {
          const state = jobRegistry.get(record.jobId);
          if (state) state.notificationDelivered = true;
        }
      } catch {
        /* malformed overflow rows remain represented by the pointer notification */
      }
    }
    unlinkSync(pending.overflowPath);
  } catch {
    /* the pointer was delivered; missing ledger data cannot be recovered in-process */
  }
}

// ── Interactive artifact notification helpers ───────────────────

/** True when the event should trigger a wakeup notification to the parent. */
export function shouldNotify(event: SubagentEvent): boolean {
  return isCompletionEvent(event);
}

export function sanitizeOutput(text: string): string {
  return text.replace(
    /(sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|-----BEGIN[\s\w]+KEY-----|AKIA[\w]{16}|ghp_[\w]{36}|gho_[\w]{36}|ghu_[\w]{36}|xox[abp]-[\w-]+|AIza[\w-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    "[REDACTED]",
  );
}

/** Assert that a value is never (exhaustiveness checker). */
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

function iconFor(event: SubagentEvent): string {
  switch (event.type) {
    case "started":
    case "tool_activity":
      return "▶";
    case "done":
      return event.exitCode === 0 ? "✅" : "❌";
    case "error":
      return "❌";
    case "cancelled":
      return "🚫";
    case "turn_started":
      return "▶";
    case "completion":
      return event.outcome === "done"
        ? "✅"
        : event.outcome === "cancelled"
          ? "🚫"
          : "❌";
    case "process_exited":
      return event.exitCode === 0 ? "✅" : "❌";
    default:
      return assertNever(event);
  }
}

function labelFor(event: SubagentEvent): string {
  switch (event.type) {
    case "tool_activity":
      return "activity";
    case "done":
      return `done (exit ${event.exitCode ?? "?"})`;
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    // "started" is intentionally dropped — it would only fire on the very first poll
    // and the widget row is a better signal than a one-shot message.
    case "started":
      return "started";
    case "turn_started":
      return "started";
    case "completion":
      return `${event.outcome}${event.exitCode === undefined ? "" : ` (exit ${event.exitCode})`}`;
    case "process_exited":
      return `process exited (${event.exitCode})`;
    default:
      return assertNever(event);
  }
}

/** Build the LLM-facing notification content. Pointer paths always; error body inlined. */
function buildArtifactMessage(
  state: InteractiveSubagentState,
  event: SubagentEvent,
): string {
  const header = `${iconFor(event)} ${state.name} (${state.id}) — ${labelFor(event)}`;
  const outputPath = join(state.artifactDir, "output.md");
  const logPath = join(state.artifactDir, "events.ndjson");
  const pointer = `\nOutput: ${outputPath}\nActivity log: ${logPath}`;
  let body = "";
  if (event.type === "error") {
    body = `\n${sanitizeOutput((event.message ?? "unknown error").slice(0, 500))}`;
  }

  return `${header}${body}${pointer}`;
}

/** Send a single pointer-only notification for one artifact event.
 * Returns true if the notification was sent, false on failure (stale pi context). */
export function deliverArtifactNotification(
  pi: ExtensionAPI,
  state: InteractiveSubagentState,
  event: SubagentEvent,
): boolean {
  try {
    pi.sendMessage!(
      {
        customType: "subagent-notify",
        content: buildArtifactMessage(state, event),
        display: true,
        details: { subagentId: state.id, event },
      },
      completionMessageOptions(
        state.triggerTurnOnComplete === true &&
          !(state.notifyOnComplete === "inject" && event.type === "done"),
      ),
    );
    return true;
  } catch {
    // pi may be stale after session replacement
    return false;
  }
}
