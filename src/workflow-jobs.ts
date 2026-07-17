import { randomBytes } from "node:crypto";
import { debugLog } from "./helpers";
import type { CancellationSnapshotReceipt } from "./cancellation-snapshots";
import { runWorkflow } from "./workflow-worker";
import {
  type RunWorkflowOptions,
  type WorkflowProgress,
  type WorkflowRunResult,
  type WorkflowUsage,
  zeroWorkflowUsage,
} from "./workflow-core";

// ── Background workflow-job registry ─────────────────────────────────

export type WorkflowJobStatus = "running" | "done" | "error" | "cancelled";

export interface WorkflowJobState {
  id: string;
  name: string;
  status: WorkflowJobStatus;
  startedAt: number;
  promise: Promise<WorkflowRunResult>;
  abort: AbortController;
  snapshot: {
    agentsSpawned: number;
    errorCount: number;
    /** @deprecated Output-token count; use usage.totalTokens. */
    tokensSpent: number;
    usage?: WorkflowUsage;
    phases: string[];
    lastMessage?: string;
    currentPhase?: string;
    runningCount?: number;
  };
  result?: WorkflowRunResult;
  error?: string;
  /** Completion notification callback bound to the current parent session. */
  completionNotification?: (job: WorkflowJobState) => boolean | void;
  /** Set only after the completion callback reports a successful delivery. */
  completionNotificationDelivered?: boolean;
  /** Set during parent shutdown so late settlement cannot notify a replacement session. */
  suppressCompletionNotification?: boolean;
  /** Receipts captured by nested agents during workflow cancellation. */
  cancellationSnapshots?: CancellationSnapshotReceipt[];
  /** Set when notification attempts are exhausted. Prevents re-logging. */
  _notificationExhausted?: boolean;
  /** Synchronous reentrant guard — set while the delivery callback is in flight. */
  _notificationInFlight?: boolean;
  /** Number of successful delivery attempts. Only increments on success. */
  notificationAttempt?: number;
}
const g = typeof global !== "undefined" ? global : globalThis;
declare global {
  // eslint-disable-next-line no-var
  var __piSubagenturaWorkflowJobs: Map<string, WorkflowJobState> | undefined;
}
if (!g.__piSubagenturaWorkflowJobs) {
  g.__piSubagenturaWorkflowJobs = new Map<string, WorkflowJobState>();
}
export const workflowJobRegistry = g.__piSubagenturaWorkflowJobs as Map<
  string,
  WorkflowJobState
>;

export const MAX_WORKFLOW_JOBS = 100;

/** Maximum notification delivery attempts before giving up. */
export const MAX_WORKFLOW_NOTIFICATION_ATTEMPTS = 5;

/** Start a workflow running in the background. Returns the job id immediately. */
export function startWorkflowJob(
  name: string,
  script: string,
  opts: Omit<
    RunWorkflowOptions,
    "signal" | "onProgress" | "onCancellationSnapshot"
  >,
  startedAt?: number,
  onComplete?: (job: WorkflowJobState) => boolean | void,
): WorkflowJobState {
  while (workflowJobRegistry.size >= MAX_WORKFLOW_JOBS) {
    // Evict the oldest terminal job; if none, throw — the caller must cancel one first.
    let evicted = false;
    for (const [id, st] of workflowJobRegistry) {
      if (st.status !== "running") {
        debugLog("info", "workflow_job_evicted", { evictedId: id });
        workflowJobRegistry.delete(id);
        evicted = true;
        break;
      }
    }
    if (!evicted) {
      throw new Error(
        `${MAX_WORKFLOW_JOBS} workflow jobs already running — cancel one with cancel_workflow before starting another.`,
      );
    }
  }

  const id = `wf_${randomBytes(5).toString("hex")}`;
  const abort = new AbortController();
  const state: WorkflowJobState = {
    id,
    name,
    status: "running",
    startedAt: startedAt ?? Date.now(),
    promise: undefined as unknown as Promise<WorkflowRunResult>,
    abort,
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      usage: zeroWorkflowUsage(),
      phases: [],
      runningCount: 0,
    },
    completionNotification: onComplete,
    completionNotificationDelivered: false,
    cancellationSnapshots: [],
  };
  state.promise = runWorkflow(script, {
    ...opts,
    signal: abort.signal,
    onProgress: (p) => {
      state.snapshot.agentsSpawned = p.agentsSpawned;
      state.snapshot.errorCount = p.errorCount;
      state.snapshot.tokensSpent = p.tokensSpent;
      state.snapshot.usage = p.usage ? { ...p.usage } : state.snapshot.usage;
      state.snapshot.runningCount = p.runningCount;
      if (p.kind === "phase" && p.phase) {
        state.snapshot.currentPhase = p.phase;
        state.snapshot.phases.push(p.phase);
        state.snapshot.lastMessage = `◆ phase: ${p.phase}`;
      } else if (p.kind === "log" && p.message) {
        state.snapshot.lastMessage = p.message;
      } else if (p.kind === "agent_start") {
        state.snapshot.lastMessage = `→ started${formatWorkflowAgentTag(p)}`;
      } else if (p.kind === "agent_done") {
        state.snapshot.lastMessage = `→ done${formatWorkflowAgentTag(p)}`;
      }
    },
    onCancellationSnapshot: (receipt) => {
      (state.cancellationSnapshots ??= []).push(receipt);
    },
  })
    .then((r) => {
      if (state.status === "running") state.status = "done";
      state.result = r;
      invokeCompletionHook(state);
      return r;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = abort.signal.aborted ? "cancelled" : "error";
      state.error = msg;
      invokeCompletionHook(state);
      throw err;
    });
  // Don't crash the process on an unobserved rejection before get_workflow_result is called.
  state.promise.catch(() => {});
  workflowJobRegistry.set(id, state);
  return state;
}

function invokeCompletionHook(job: WorkflowJobState): void {
  const callback = job.completionNotification;
  if (
    !callback ||
    job.completionNotificationDelivered ||
    job.suppressCompletionNotification
  ) {
    return;
  }
  // Already exhausted — no-op, no increment, no log.
  if (job._notificationExhausted) return;
  // Synchronous reentrant guard: prevents recursive retry from
  // calling the same callback while it is still on the call stack.
  if (job._notificationInFlight) return;
  job._notificationInFlight = true;
  try {
    // Increment on every invocation (including throws) for truthful total count.
    job.notificationAttempt = (job.notificationAttempt ?? 0) + 1;
    const result = callback(job);
    // Only mark delivered on success; throw goes to catch.
    if (result !== false) {
      job.completionNotificationDelivered = true;
    }
    // Mark exhausted only if the callback explicitly returned false.
    if (
      result === false &&
      job.notificationAttempt >= MAX_WORKFLOW_NOTIFICATION_ATTEMPTS
    ) {
      job._notificationExhausted = true;
      debugLog("warn", "workflow_notification_exhausted", {
        workflowId: job.id,
        attempts: job.notificationAttempt,
      });
    }
  } catch (err) {
    debugLog("warn", "workflow_completion_hook_failed", {
      workflowId: job.id,
      attempt: job.notificationAttempt,
      error: err instanceof Error ? err.message : String(err),
    });
    // Mark exhausted after the MAXth failed invocation.
    if ((job.notificationAttempt ?? 0) >= MAX_WORKFLOW_NOTIFICATION_ATTEMPTS) {
      job._notificationExhausted = true;
      debugLog("warn", "workflow_notification_exhausted", {
        workflowId: job.id,
        attempts: job.notificationAttempt,
      });
    }
  } finally {
    job._notificationInFlight = false;
  }
}

/** Retry terminal workflow notifications that failed in this parent session. */
export function retryPendingWorkflowNotifications(): void {
  for (const job of workflowJobRegistry.values()) {
    if (job.status === "running") continue;
    invokeCompletionHook(job);
  }
}

/** Count running workflow jobs (status === "running"). */
export function getRunningWorkflowCount(): number {
  let count = 0;
  for (const st of workflowJobRegistry.values()) {
    if (st.status === "running") count++;
  }
  return count;
}

function formatWorkflowAgentTag(p: WorkflowProgress): string {
  const label = p.label ? ` ${p.label}` : " agent";
  const model = p.model ? ` @${p.model}` : "";
  return `${label}${model}`;
}

export interface WorkflowCompletionPresentation {
  label: string;
  icon: string;
}

/** Preserve raw `done` while exposing a warning presentation for resolved errors. */
export function getWorkflowCompletionPresentation(
  status: WorkflowJobStatus,
  errorCount: number,
): WorkflowCompletionPresentation {
  if (status === "done" && errorCount > 0) {
    return { label: "completed with errors", icon: "⚠" };
  }
  return { label: status, icon: "" };
}
