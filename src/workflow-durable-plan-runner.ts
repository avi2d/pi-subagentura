import type { SubagentResult } from "./helpers";
import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import type { WorkflowProjection } from "./workflow-projection-repository";
import { recoverWorkflowRun } from "./workflow-recovery";
import { WorkflowRunStore } from "./workflow-run-store";
import type {
  WorkflowApprovalDecision,
  WorkflowApprovalRequest,
  WorkflowOwnerIdentity,
  WorkflowResumePolicy,
} from "./workflow-run-types";
import {
  validateWorkflowApprovalDecision,
  validateWorkflowApprovalRequest,
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
      const projection = await recoverWorkflowRun(this.options, runId);
      if (isTerminal(projection.status) && !projection.delivery) {
        // A crash may occur after the terminal event and before the outbox
        // intent. Repair the limbo window before exposing the projection.
        await appendDeliveryIntent(
          this.options.store,
          this.options.owner,
          runId,
        );
        return recoverWorkflowRun(this.options, runId);
      }
      return projection;
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
    await this.options.store.append(runId, "run_result", {
      result: { status: "cancelled" },
    });
    await this.options.store.append(runId, "run_cancelled", {});
    await appendDeliveryIntent(this.options.store, this.options.owner, runId);
    return recoverWorkflowRun(this.options, runId);
  }

  public async pauseForBudget(
    runId: string,
    reason?: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || isTerminal(projection.status)) return projection;
    if (projection.status === "awaiting_budget") return projection;
    await this.options.store.append(runId, "run_awaiting_budget", {
      ...(reason ? { reason } : {}),
    });
    return this.getStatus(runId);
  }

  public async resumeFromBudget(
    runId: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || projection.status !== "awaiting_budget")
      return projection;
    await this.options.store.append(runId, "run_budget_resumed", {});
    return this.getStatus(runId);
  }

  public async mutateTask(
    runId: string,
    mutation: {
      type: "block" | "unblock" | "skip" | "append";
      taskId: string;
      expectedRevision: number;
      phaseId?: string;
      prompt?: string;
      label?: string;
    },
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection) return undefined;
    if (projection.revision !== mutation.expectedRevision) {
      throw new Error(
        `Workflow plan revision is stale: expected ${mutation.expectedRevision}, current ${projection.revision}`,
      );
    }
    if (mutation.type === "append") {
      if (!mutation.phaseId || !mutation.prompt?.trim())
        throw new Error("Appending workflow work requires phaseId and prompt");
      if (projection.tasks[mutation.taskId]) {
        throw new Error(`Duplicate workflow task: ${mutation.taskId}`);
      }
      if (isTerminal(projection.status)) {
        throw new Error("Cannot append work to a terminal workflow");
      }
      await this.options.store.append(
        runId,
        "task_appended",
        withMutationHash(
          {
            taskId: mutation.taskId,
            phaseId: mutation.phaseId,
            prompt: mutation.prompt,
            ...(mutation.label ? { label: mutation.label } : {}),
          },
          projection.mutationHash,
        ),
      );
      return this.getStatus(runId);
    }
    const currentTask = projection.tasks[mutation.taskId];
    if (!currentTask)
      throw new Error(`Unknown workflow task: ${mutation.taskId}`);
    if (
      (mutation.type === "block" || mutation.type === "unblock") &&
      currentTask.status !== (mutation.type === "block" ? "pending" : "blocked")
    ) {
      throw new Error(`Task ${mutation.taskId} cannot be ${mutation.type}d`);
    }
    if (
      mutation.type === "skip" &&
      !["pending", "blocked"].includes(currentTask.status)
    ) {
      throw new Error(`Task ${mutation.taskId} is no longer mutable`);
    }
    const eventType =
      mutation.type === "block"
        ? "task_blocked"
        : mutation.type === "unblock"
          ? "task_unblocked"
          : "task_skipped";
    await this.options.store.append(
      runId,
      eventType,
      withMutationHash({ taskId: mutation.taskId }, projection.mutationHash),
    );
    return this.getStatus(runId);
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

  public async dispatchDelivery(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || projection.delivery?.deliveryId !== deliveryId)
      return projection;
    if (projection.delivery.status === "pending") {
      await this.options.store.append(runId, "delivery_dispatched", {
        deliveryId,
      });
    }
    return this.getStatus(runId);
  }

  public async requestApproval(
    runId: string,
    request: WorkflowApprovalRequest,
  ): Promise<WorkflowProjection | undefined> {
    validateWorkflowApprovalRequest(request);
    const projection = await this.getStatus(runId);
    if (!projection) return undefined;
    if (projection.approval?.status === "pending") return projection;
    await this.options.store.append(runId, "approval_requested", { request });
    return this.getStatus(runId);
  }

  public async decideApproval(
    runId: string,
    requestId: string,
    decision: WorkflowApprovalDecision,
  ): Promise<WorkflowProjection | undefined> {
    validateWorkflowApprovalDecision(decision);
    if (decision.requestId !== requestId)
      throw new Error("Workflow approval request mismatch");
    const projection = await this.getStatus(runId);
    if (
      !projection?.approval ||
      projection.approval.request.requestId !== requestId
    )
      throw new Error("Workflow approval request was not found");
    const request = projection.approval.request;
    if (
      (decision.policyHash !== undefined &&
        decision.policyHash !== request.policyHash) ||
      (decision.planRevision !== undefined &&
        decision.planRevision !== request.planRevision) ||
      (decision.ownerGeneration !== undefined &&
        decision.ownerGeneration !== request.ownerGeneration) ||
      (decision.leaseEpoch !== undefined &&
        decision.leaseEpoch !== request.leaseEpoch) ||
      (decision.version !== undefined && decision.version !== request.version)
    ) {
      return projection;
    }
    if (projection.approval.status !== "pending") return projection;
    await this.options.store.append(runId, "approval_decided", decision);
    return this.getStatus(runId);
  }
}

function withMutationHash(
  payload: Record<string, unknown>,
  previousMutationHash: string | undefined,
): Record<string, unknown> {
  const previous = previousMutationHash ?? "";
  const mutationHash = createHash("sha256")
    .update(JSON.stringify({ previousMutationHash: previous, payload }))
    .digest("hex");
  return { ...payload, previousMutationHash: previous, mutationHash };
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
        await store.append(runId, "run_result", {
          result: { status: "cancelled" },
        });
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
          await store.append(runId, "run_result", {
            result: {
              status: "error",
              error: {
                code: "task_failed",
                message: result.errorMessage ?? "Task failed",
              },
            },
          });
          await store.append(runId, "run_terminal", {});
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
          await store.append(runId, "run_result", {
            result: { status: "cancelled" },
          });
          await store.append(runId, "run_cancelled", {});
          await appendDeliveryIntent(store, owner, runId);
          return publish(await recoverWorkflowRun({ store, owner }, runId));
        }
        await store.append(runId, "run_interrupted", {});
        throw error;
      }
    }
  }

  await store.append(runId, "run_result", {
    result: { status: "done", result: "Workflow completed" },
  });
  await store.append(runId, "run_terminal", {});
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
  let interrupted = false;
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
        if (result.isError) {
          const message = result.errorMessage ?? "Task failed";
          await options.store.append(options.runId, "task_failed", {
            taskId: task.id,
            attempt,
            error: message,
          });
          if (firstError === undefined) {
            firstError = new Error(message);
          }
          return;
        }
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
        // A thrown runner error means the coordinator/attempt was interrupted.
        // Logical task failures are represented by result.isError and are the
        // only failures that should close the run as terminal.
        if (firstError === undefined) {
          interrupted = true;
          firstError = error;
          await options.store.append(options.runId, "run_interrupted", {});
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (firstError !== undefined) {
    if (interrupted) throw firstError;
    if (options.signal?.aborted) {
      await options.store.append(options.runId, "run_result", {
        result: { status: "cancelled" },
      });
      await options.store.append(options.runId, "run_cancelled", {});
      return false;
    }
    await options.store.append(options.runId, "run_result", {
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
    await options.store.append(options.runId, "run_terminal", {});
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
