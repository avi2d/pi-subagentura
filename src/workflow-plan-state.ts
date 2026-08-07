import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import type { WorkflowRunStatus } from "./workflow-run-types";
import type { WorkflowTaskStatus } from "./workflow-plan";

export interface WorkflowPlanState {
  plan: WorkflowPlan;
  status: WorkflowRunStatus;
  currentPhase?: string;
  tasks: Record<string, WorkflowTaskStatus>;
  revision: number;
}

export type WorkflowPlanAction =
  | { type: "start"; taskId: string; phaseId: string }
  | { type: "succeed"; taskId: string }
  | { type: "fail"; taskId: string }
  | { type: "cancel" };

export function createWorkflowPlanState(plan: WorkflowPlan): WorkflowPlanState {
  validateWorkflowPlan(plan);
  const tasks: Record<string, WorkflowTaskStatus> = {};
  for (const phase of plan.phases)
    for (const task of phase.tasks) tasks[task.id] = "pending";
  return { plan, status: "created", tasks, revision: 0 };
}

export function reduceWorkflowPlanState(
  state: WorkflowPlanState,
  action: WorkflowPlanAction,
): WorkflowPlanState {
  const next = {
    ...state,
    tasks: { ...state.tasks },
    revision: state.revision + 1,
  };
  if (action.type === "cancel") {
    if (state.status === "done" || state.status === "error") return state;
    next.status = "cancelled";
    return next;
  }
  const current = state.tasks[action.taskId];
  if (!current) throw new Error(`Unknown workflow task: ${action.taskId}`);
  if (action.type === "start") {
    if (
      current !== "pending" ||
      state.status === "done" ||
      state.status === "cancelled"
    ) {
      throw new Error(`Task ${action.taskId} cannot start from ${current}`);
    }
    next.tasks[action.taskId] = "running";
    next.status = "running";
    next.currentPhase = action.phaseId;
  } else if (action.type === "succeed" || action.type === "fail") {
    if (current !== "running")
      throw new Error(`Task ${action.taskId} is not running`);
    next.tasks[action.taskId] =
      action.type === "succeed" ? "succeeded" : "failed";
    next.status =
      action.type === "fail"
        ? "error"
        : allTasksTerminal(next)
          ? "done"
          : "running";
  }
  return next;
}

function allTasksTerminal(state: WorkflowPlanState): boolean {
  return Object.values(state.tasks).every(
    (status) => status === "succeeded" || status === "skipped",
  );
}
