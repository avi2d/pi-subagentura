import type { SubagentResult } from "./helpers";
import type { WorkflowPlan } from "./workflow-plan";
import type { WorkflowProjection } from "./workflow-projection-repository";
import { recoverWorkflowRun } from "./workflow-recovery";
import { WorkflowRunStore } from "./workflow-run-store";
import type { WorkflowOwnerIdentity } from "./workflow-run-types";

export interface DurableWorkflowPlanOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
  runId: string;
  plan: WorkflowPlan;
  runAgent: (input: {
    prompt: string;
    isolation: "in-process";
    label: string;
    signal?: AbortSignal;
  }) => Promise<SubagentResult>;
  signal?: AbortSignal;
  resume?: boolean;
  onProjection?: (projection: WorkflowProjection) => void;
}

export async function runDurableWorkflowPlan(
  options: DurableWorkflowPlanOptions,
): Promise<WorkflowProjection> {
  const { store, owner, runId, plan } = options;
  const publish = (next: WorkflowProjection): WorkflowProjection => {
    options.onProjection?.(next);
    return next;
  };
  let projection: WorkflowProjection;
  try {
    projection = await recoverWorkflowRun({ store, owner }, runId);
  } catch (error) {
    if (!isMissingRun(error)) throw error;
    await store.createRun({
      runId,
      planRevision: plan.schemaVersion,
      resumePolicy: "manual",
      owner,
    });
    await store.append(runId, "run_created", {});
    projection = await recoverWorkflowRun({ store, owner }, runId);
  }

  if (projection.status === "interrupted" && !options.resume) {
    return publish(projection);
  }
  if (projection.planRevision !== plan.schemaVersion) {
    throw new Error(
      `Workflow plan revision mismatch: stored ${projection.planRevision}, ` +
        `requested ${plan.schemaVersion}`,
    );
  }
  if (isTerminal(projection.status)) return publish(projection);
  if (projection.status === "created" || projection.status === "interrupted") {
    await store.append(runId, "run_started", {});
  }

  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      projection = await recoverWorkflowRun({ store, owner }, runId);
      const existing = projection.tasks[task.id];
      if (existing?.status === "succeeded" || existing?.status === "skipped") {
        continue;
      }
      if (options.signal?.aborted) {
        await store.append(runId, "run_interrupted", {});
        return publish(await recoverWorkflowRun({ store, owner }, runId));
      }
      const attempt = (existing?.attempt ?? 0) + 1;
      await store.append(runId, "task_started", {
        taskId: task.id,
        attempt,
        phaseId: phase.id,
      });
      try {
        const result = await options.runAgent({
          prompt: task.prompt,
          isolation: "in-process",
          label: task.label ?? task.id,
          signal: options.signal,
        });
        await store.append(runId, "usage_observed", {
          input: result.usage.input,
          output: result.usage.output,
          taskId: task.id,
          attempt,
        });
        if (result.isError) {
          await store.append(runId, "task_failed", {
            taskId: task.id,
            attempt,
            error: result.errorMessage ?? "Task failed",
          });
          await store.append(runId, "run_terminal", {
            result: {
              status: "error",
              error: {
                code: "task_failed",
                message: result.errorMessage ?? "Task failed",
              },
            },
          });
          return publish(await recoverWorkflowRun({ store, owner }, runId));
        }
        await store.append(runId, "task_succeeded", {
          taskId: task.id,
          attempt,
          result: result.output,
        });
      } catch (error) {
        await store.append(runId, "run_interrupted", {});
        throw error;
      }
    }
  }

  await store.append(runId, "run_terminal", {
    result: { status: "done", result: "Workflow completed" },
  });
  projection = await recoverWorkflowRun({ store, owner }, runId);
  return publish(projection);
}

function isTerminal(status: WorkflowProjection["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isMissingRun(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
