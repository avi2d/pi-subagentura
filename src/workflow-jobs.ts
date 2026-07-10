import { randomBytes } from "node:crypto";
import { debugLog } from "./helpers";
import { runWorkflow } from "./workflow-worker";
import {
  type RunWorkflowOptions,
  type WorkflowProgress,
  type WorkflowRunResult,
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
    tokensSpent: number;
    phases: string[];
    lastMessage?: string;
    currentPhase?: string;
    runningCount?: number;
  };
  result?: WorkflowRunResult;
  error?: string;
  /** Set during parent shutdown so late settlement cannot notify a replacement session. */
  suppressCompletionNotification?: boolean;
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

/** Start a workflow running in the background. Returns the job id immediately. */
export function startWorkflowJob(
  name: string,
  script: string,
  opts: Omit<RunWorkflowOptions, "signal" | "onProgress">,
  startedAt?: number,
  onComplete?: (job: WorkflowJobState) => void,
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
      phases: [],
      runningCount: 0,
    },
  };
  state.promise = runWorkflow(script, {
    ...opts,
    signal: abort.signal,
    onProgress: (p) => {
      state.snapshot.agentsSpawned = p.agentsSpawned;
      state.snapshot.errorCount = p.errorCount;
      state.snapshot.tokensSpent = p.tokensSpent;
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
  })
    .then((r) => {
      if (state.status === "running") state.status = "done";
      state.result = r;
      invokeCompletionHook(onComplete, state);
      return r;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = abort.signal.aborted ? "cancelled" : "error";
      state.error = msg;
      invokeCompletionHook(onComplete, state);
      throw err;
    });
  // Don't crash the process on an unobserved rejection before get_workflow_result is called.
  state.promise.catch(() => {});
  workflowJobRegistry.set(id, state);
  return state;
}

function invokeCompletionHook(
  onComplete: ((job: WorkflowJobState) => void) | undefined,
  job: WorkflowJobState,
): void {
  if (!onComplete || job.suppressCompletionNotification) return;
  try {
    onComplete(job);
  } catch (err) {
    debugLog("warn", "workflow_completion_hook_failed", {
      workflowId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
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
