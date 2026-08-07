import type { SubagentResult } from "./helpers";
import type { WorkflowAgentRunner, WorkflowRunResult } from "./workflow-core";
import {
  createWorkflowPlanState,
  reduceWorkflowPlanState,
  type WorkflowPlanState,
} from "./workflow-plan-state";
import type { WorkflowPlan } from "./workflow-plan";

export interface WorkflowPlanRunOptions {
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  onState?: (state: WorkflowPlanState) => void;
}

export interface WorkflowPlanTaskResult {
  taskId: string;
  output: string;
  result: SubagentResult;
}

export interface WorkflowPlanRunResult extends WorkflowRunResult {
  plan: WorkflowPlan;
  taskResults: WorkflowPlanTaskResult[];
}

/** Execute the preview plan coordinator. The coordinator owns task settlement. */
export async function runWorkflowPlan(
  plan: WorkflowPlan,
  options: WorkflowPlanRunOptions,
): Promise<WorkflowPlanRunResult> {
  let state = createWorkflowPlanState(plan);
  const taskResults: WorkflowPlanTaskResult[] = [];
  const phases: string[] = [];
  let agentsSpawned = 0;
  let errorCount = 0;

  const publish = (next: WorkflowPlanState) => {
    state = next;
    options.onState?.(state);
  };
  const abortIfRequested = () => {
    if (options.signal?.aborted) {
      publish(reduceWorkflowPlanState(state, { type: "cancel" }));
      throw options.signal.reason ?? new Error("Workflow plan cancelled");
    }
  };

  for (const phase of plan.phases) {
    phases.push(phase.id);
    for (const task of phase.tasks) {
      abortIfRequested();
      publish(
        reduceWorkflowPlanState(state, {
          type: "start",
          taskId: task.id,
          phaseId: phase.id,
        }),
      );
      agentsSpawned++;
      try {
        const result = await options.runAgent({
          prompt: task.prompt,
          isolation: task.isolation ?? "in-process",
          label: task.label ?? task.id,
          signal: options.signal,
        });
        if (result.isError) {
          errorCount++;
          publish(
            reduceWorkflowPlanState(state, { type: "fail", taskId: task.id }),
          );
          throw new Error(result.errorMessage);
        }
        taskResults.push({ taskId: task.id, output: result.output, result });
        publish(
          reduceWorkflowPlanState(state, { type: "succeed", taskId: task.id }),
        );
      } catch (error) {
        if (state.status !== "error") errorCount++;
        if (state.status === "running") {
          publish(
            reduceWorkflowPlanState(state, { type: "fail", taskId: task.id }),
          );
        }
        throw error;
      }
    }
  }

  return {
    meta: {
      name: plan.name,
      description: `Declarative workflow plan ${plan.name}`,
    },
    result: taskResults.map(({ taskId, output }) => ({ taskId, output })),
    agentsSpawned,
    errorCount,
    tokensSpent: taskResults.reduce(
      (sum, item) => sum + item.result.usage.output,
      0,
    ),
    phases,
    plan,
    taskResults,
  };
}
