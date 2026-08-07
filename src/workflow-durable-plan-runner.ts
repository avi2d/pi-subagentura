import type { SubagentResult } from "./helpers";
import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import type { WorkflowProjection } from "./workflow-projection-repository";
import { recoverWorkflowRun } from "./workflow-recovery";
import { WorkflowRunStore } from "./workflow-run-store";
import type {
  WorkflowOwnerIdentity,
  WorkflowResumePolicy,
} from "./workflow-run-types";
import { createHash } from "node:crypto";

export interface DurableWorkflowPlanOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
  runId: string;
  plan: WorkflowPlan;
  resumePolicy?: WorkflowResumePolicy;
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

export interface DurableWorkflowControllerOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
}

/** Owner-scoped controller for durable status, result, and cancellation. */
export class DurableWorkflowController {
  public constructor(
    private readonly options: DurableWorkflowControllerOptions,
  ) {}

  public async getStatus(
    runId: string,
  ): Promise<WorkflowProjection | undefined> {
    try {
      return await recoverWorkflowRun(this.options, runId);
    } catch (error) {
      if (isMissingRun(error)) return undefined;
      throw error;
    }
  }

  public async getResult(
    runId: string,
  ): Promise<WorkflowProjection["terminal"]> {
    const projection = await this.getStatus(runId);
    if (!projection) return undefined;
    return projection.terminal;
  }

  public async cancel(runId: string): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || isTerminal(projection.status)) return projection;
    await this.options.store.append(runId, "run_cancelled", {});
    await appendDeliveryIntent(this.options.store, this.options.owner, runId);
    return recoverWorkflowRun(this.options, runId);
  }

  public async acknowledgeDelivery(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || projection.delivery?.deliveryId !== deliveryId)
      return projection;
    if (projection.delivery.status !== "delivered") {
      await this.options.store.append(runId, "delivery_receipt", {
        deliveryId,
      });
    }
    return this.getStatus(runId);
  }
}

export function workflowDeliveryId(runId: string): string {
  return createHash("sha256")
    .update(`workflow:${runId}:terminal`)
    .digest("hex");
}

export function workflowDeliveryMessage(
  projection: WorkflowProjection,
): string {
  return `Workflow ${projection.runId} ${projection.status}`;
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
  // Validate before recovery so malformed resume input cannot touch an
  // authoritative run or dispatch work.
  validateWorkflowPlan({ ...plan, schemaVersion: 1 });
  try {
    projection = await recoverWorkflowRun({ store, owner }, runId);
  } catch (error) {
    if (!isMissingRun(error)) throw error;
    // Do not leave an orphaned run directory for an invalid new plan.
    validateWorkflowPlan(plan);
    await store.createRun({
      runId,
      planRevision: plan.schemaVersion,
      resumePolicy: options.resumePolicy ?? "manual",
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
  // The stored revision owns mismatch reporting before resume validation.
  if (isTerminal(projection.status)) return publish(projection);
  if (options.signal?.aborted) {
    await store.append(runId, "run_cancelled", {});
    await appendDeliveryIntent(store, owner, runId);
    return publish(await recoverWorkflowRun({ store, owner }, runId));
  }
  if (projection.status === "created" || projection.status === "interrupted") {
    await store.append(runId, "run_started", {});
  }

  for (const phase of plan.phases) {
    const tasks = phase.tasks.filter((task) => {
      const current = projection.tasks[task.id];
      return current?.status !== "succeeded" && current?.status !== "skipped";
    });
    if (phase.mode === "parallel") {
      const completed = await runDurableParallelPhase(options, phase.id, tasks);
      if (!completed) {
        await appendDeliveryIntent(store, owner, runId);
        return publish(await recoverWorkflowRun({ store, owner }, runId));
      }
      continue;
    }
    for (const task of tasks) {
      projection = await recoverWorkflowRun({ store, owner }, runId);
      const existing = projection.tasks[task.id];
      if (existing?.status === "succeeded" || existing?.status === "skipped")
        continue;
      if (options.signal?.aborted) {
        await store.append(runId, "run_cancelled", {});
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
          await appendDeliveryIntent(store, owner, runId);
          return publish(await recoverWorkflowRun({ store, owner }, runId));
        }
        await store.append(runId, "task_succeeded", {
          taskId: task.id,
          attempt,
          result: result.output,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          await store.append(runId, "run_cancelled", {});
          await appendDeliveryIntent(store, owner, runId);
          return publish(await recoverWorkflowRun({ store, owner }, runId));
        }
        await store.append(runId, "run_interrupted", {});
        throw error;
      }
    }
  }

  await store.append(runId, "run_terminal", {
    result: { status: "done", result: "Workflow completed" },
  });
  await appendDeliveryIntent(store, owner, runId);
  projection = await recoverWorkflowRun({ store, owner }, runId);
  return publish(projection);
}

async function runDurableParallelPhase(
  options: DurableWorkflowPlanOptions,
  phaseId: string,
  tasks: WorkflowPlan["phases"][number]["tasks"],
): Promise<boolean> {
  const limit = Math.max(1, Math.min(4, tasks.length));
  let nextIndex = 0;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const task = tasks[nextIndex++];
      if (!task) return;
      const projection = await recoverWorkflowRun(
        { store: options.store, owner: options.owner },
        options.runId,
      );
      const attempt = (projection.tasks[task.id]?.attempt ?? 0) + 1;
      if (options.signal?.aborted) {
        firstError = options.signal.reason ?? new Error("Workflow cancelled");
        return;
      }
      await options.store.append(options.runId, "task_started", {
        taskId: task.id,
        attempt,
        phaseId,
      });
      try {
        const result = await options.runAgent({
          prompt: task.prompt,
          isolation: "in-process",
          label: task.label ?? task.id,
          signal: options.signal,
        });
        await options.store.append(options.runId, "usage_observed", {
          input: result.usage.input,
          output: result.usage.output,
          taskId: task.id,
          attempt,
        });
        if (result.isError)
          throw new Error(result.errorMessage ?? "Task failed");
        await options.store.append(options.runId, "task_succeeded", {
          taskId: task.id,
          attempt,
          result: result.output,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          firstError ??= error;
          return;
        }
        await options.store.append(options.runId, "task_failed", {
          taskId: task.id,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (firstError !== undefined) {
    if (options.signal?.aborted) {
      await options.store.append(options.runId, "run_cancelled", {});
      return false;
    }
    await options.store.append(options.runId, "run_terminal", {
      result: {
        status: "error",
        error: {
          code: "task_failed",
          message:
            firstError instanceof Error
              ? firstError.message
              : String(firstError),
        },
      },
    });
    await appendDeliveryIntent(options.store, options.owner, options.runId);
    // The coordinator has already committed the terminal result. Returning
    // the projection keeps the public result aligned with durable state.
    return false;
  }
  return true;
}

async function appendDeliveryIntent(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
): Promise<void> {
  const projection = await recoverWorkflowRun({ store, owner }, runId);
  if (projection.delivery) return;
  await store.append(runId, "delivery_intent", {
    deliveryId: workflowDeliveryId(runId),
    message: workflowDeliveryMessage(projection),
  });
}

function isTerminal(status: WorkflowProjection["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isMissingRun(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
