import type {
  WorkflowPlanPhase,
  WorkflowPlanTask,
  WorkflowTaskStatus,
} from "./workflow-plan";
import type { WorkflowPlanState } from "./workflow-plan-state";

/** The plan schema's maximums, repeated here to bound rendering independently. */
export const MAX_WORKFLOW_TREE_PLAN_PHASE_ROWS = 64;
export const MAX_WORKFLOW_TREE_PLAN_TASK_ROWS = 1000;

export interface WorkflowPlanTreeRow {
  depth: 1 | 2;
  text: string;
}

/**
 * Project a declarative plan into stable tree rows without consulting job state.
 *
 * The state machine owns task status; this formatter deliberately derives no
 * status from ordering or timestamps. A malformed or partially projected state
 * therefore still renders a deterministic marker and explicit status.
 */
export function formatWorkflowPlanRows(
  state: WorkflowPlanState,
): WorkflowPlanTreeRow[] {
  const rows: WorkflowPlanTreeRow[] = [];
  let renderedTasks = 0;

  for (const [phaseIndex, phase] of state.plan.phases.entries()) {
    if (phaseIndex >= MAX_WORKFLOW_TREE_PLAN_PHASE_ROWS) break;

    rows.push({
      depth: 1,
      text: formatPhaseRow(phase, state.currentPhase),
    });

    if (renderedTasks >= MAX_WORKFLOW_TREE_PLAN_TASK_ROWS) continue;
    for (const task of phase.tasks) {
      if (renderedTasks >= MAX_WORKFLOW_TREE_PLAN_TASK_ROWS) break;
      rows.push({
        depth: 2,
        text: formatTaskRow(task, state.tasks[task.id]),
      });
      renderedTasks++;
    }
  }

  return rows;
}

function formatPhaseRow(
  phase: WorkflowPlanPhase,
  currentPhase: string | undefined,
): string {
  const current = phase.id === currentPhase ? " (current)" : "";
  return `◆ phase: ${phase.id}${current}`;
}

function formatTaskRow(
  task: WorkflowPlanTask,
  status: WorkflowTaskStatus | undefined,
): string {
  const resolvedStatus = status ?? "pending";
  const marker = markerForTaskStatus(resolvedStatus);
  const label = task.label ? `${task.label} (${task.id})` : task.id;
  return `${marker} ${resolvedStatus} ${label}`;
}

function markerForTaskStatus(status: WorkflowTaskStatus): string {
  switch (status) {
    case "pending":
      return "·";
    case "running":
      return "→";
    case "succeeded":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
      return "⊘";
    case "cancelled":
      return "⊘";
  }
}
