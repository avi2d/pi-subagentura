import {
  addWorkflowUsage,
  WorkflowExecutionError,
  zeroWorkflowUsage,
  type WorkflowAgentRunner,
  type WorkflowRunResultWithUsage,
} from "./workflow-core";
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
type WorkflowPlanAgentResult = WorkflowAgentRunner extends (
  ...args: infer _Args
) => Promise<infer Result>
  ? Result
  : never;

export interface WorkflowPlanTaskResult {
  taskId: string;
  output: string;
  result: WorkflowPlanAgentResult;
}

export type WorkflowPlanRunResult = WorkflowRunResultWithUsage & {
  plan: WorkflowPlan;
  taskResults: WorkflowPlanTaskResult[];
};

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
  let usage = zeroWorkflowUsage();

  const publish = (next: WorkflowPlanState) => {
    state = next;
    options.onState?.(state);
  };
  options.onState?.(state);

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
        usage = addWorkflowUsage(usage, result.usage);
        abortIfRequested();
        if (result.isError) {
          errorCount++;
          publish(
            reduceWorkflowPlanState(state, { type: "fail", taskId: task.id }),
          );
          const cause = new Error(result.errorMessage);
          throw new WorkflowExecutionError(cause.message, usage, cause);
        }
        taskResults.push({ taskId: task.id, output: result.output, result });
        publish(
          reduceWorkflowPlanState(state, { type: "succeed", taskId: task.id }),
        );
      } catch (error) {
        if (options.signal?.aborted) {
          if (state.status !== "cancelled") {
            publish(reduceWorkflowPlanState(state, { type: "cancel" }));
          }
          throw options.signal.reason ?? new Error("Workflow plan cancelled");
        }
        if (state.status !== "error") {
          errorCount++;
          if (state.status === "running") {
            publish(
              reduceWorkflowPlanState(state, { type: "fail", taskId: task.id }),
            );
          }
        }
        if (error instanceof WorkflowExecutionError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new WorkflowExecutionError(message, usage, error);
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
    tokensSpent: usage.output,
    usage,
    phases,
    plan,
    taskResults,
  };
}
