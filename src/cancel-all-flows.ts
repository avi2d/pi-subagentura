/**
 * Shared helper to cancel ALL active flows.
 *
 * Used by:
 * - ctrl+alt+x shortcut
 * - /cancel-all-flows command
 *
 * Preserves idle interactive panes (they consume no tokens).
 * Preserves done/error/cancelled jobs and workflows.
 */

import { jobRegistry, scheduleJobCleanup } from "./helpers";
import {
  cancelInteractiveSubagent,
  interactiveSubagentRegistry,
} from "./interactive-tmux";
import { workflowJobRegistry } from "./workflow-jobs";

export interface CancelAllResult {
  jobsAborted: number;
  workflowsAborted: number;
  interactiveKilled: number;
  interactivePreserved: number;
}

export async function cancelAllFlows(): Promise<CancelAllResult> {
  const result: CancelAllResult = {
    jobsAborted: 0,
    workflowsAborted: 0,
    interactiveKilled: 0,
    interactivePreserved: 0,
  };

  // 1. Abort all running in-process subagent jobs
  for (const job of jobRegistry.values()) {
    if (job.status === "running") {
      try {
        await job.session.abort();
      } catch {
        /* session may already be disposed */
      }
      job.status = "cancelled";
      scheduleJobCleanup(job.id, true);
      result.jobsAborted++;
    }
  }

  // 2. Abort all running workflows
  for (const workflow of workflowJobRegistry.values()) {
    if (workflow.status === "running") {
      workflow.abort.abort();
      workflow.status = "cancelled";
      result.workflowsAborted++;
    }
  }

  // 3. Kill running interactive agents; preserve idle ones
  for (const state of interactiveSubagentRegistry.values()) {
    if (state.status === "running") {
      try {
        const cancelled = cancelInteractiveSubagent(state.id);
        if (cancelled) {
          result.interactiveKilled++;
        }
      } catch {
        /* best effort */
      }
    } else if (state.status === "idle") {
      // Idle panes consume no tokens — preserve them
      result.interactivePreserved++;
    }
  }

  return result;
}
