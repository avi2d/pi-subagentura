import type { SubagentResult } from "./helpers";
import {
  canonicalWorkflowPlanDigest,
  canonicalizeWorkflowValue,
  normalizeWorkflowPlan,
  type WorkflowPlan,
} from "./workflow-plan";
import { recoverWorkflowRun } from "./workflow-recovery";
import type { WorkflowProjection } from "./workflow-projection-repository";
import {
  WorkflowRunStore,
  type WorkflowConditionalAppendResult,
} from "./workflow-run-store";
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

export interface DurableWorkflowDispatcherSlot {
  closeAdmission?: () => void;
  drain?: () => Promise<void>;
}

export interface DurableSessionShutdownAbortReason {
  readonly source: "session_shutdown";
  readonly reason: "session_shutdown";
}

export interface ActiveDurableWorkflowExecution {
  readonly runId: string;
  readonly owner: WorkflowOwnerIdentity;
  readonly store?: WorkflowRunStore;
  readonly abortController: AbortController;
  readonly promise: Promise<WorkflowProjection>;
  readonly dispatcherSlot?: DurableWorkflowDispatcherSlot;
}

/**
 * In-memory liveness is intentionally only an execution overlay. Durable
 * journal state remains authoritative, while this owner-scoped registry lets
 * trusted cancellation close admission and drain the active executor.
 */
export class DurableActiveExecutionRegistry {
  private readonly entries = new Map<string, ActiveDurableWorkflowExecution>();

  public get(
    owner: WorkflowOwnerIdentity,
    runId: string,
  ): ActiveDurableWorkflowExecution | undefined {
    return this.entries.get(activeExecutionKey(owner, runId));
  }

  public list(
    owner: WorkflowOwnerIdentity,
  ): readonly ActiveDurableWorkflowExecution[] {
    const key = activeOwnerKey(owner);
    return [...this.entries.values()].filter(
      (execution) => activeOwnerKey(execution.owner) === key,
    );
  }

  public register(
    execution: ActiveDurableWorkflowExecution,
  ): ActiveDurableWorkflowExecution | undefined {
    const key = activeExecutionKey(execution.owner, execution.runId);
    const current = this.entries.get(key);
    if (current) return current;
    this.entries.set(key, execution);
    return undefined;
  }

  public unregister(execution: ActiveDurableWorkflowExecution): void {
    const key = activeExecutionKey(execution.owner, execution.runId);
    if (this.entries.get(key) === execution) this.entries.delete(key);
  }
}

export const activeDurableExecutionRegistry =
  new DurableActiveExecutionRegistry();

export async function drainActiveDurableExecutions(
  owner: WorkflowOwnerIdentity,
  reason: "session_shutdown" = "session_shutdown",
): Promise<WorkflowProjection[]> {
  const executions = activeDurableExecutionRegistry.list(owner);
  const shutdownReason: DurableSessionShutdownAbortReason = {
    source: "session_shutdown",
    reason,
  };
  const projections = await Promise.all(
    executions.map(async (execution) => {
      execution.dispatcherSlot?.closeAdmission?.();
      if (!execution.abortController.signal.aborted) {
        execution.abortController.abort(shutdownReason);
      }
      try {
        await execution.dispatcherSlot?.drain?.();
      } catch {
        // Shutdown remains best-effort when a provider slot has already gone
        // away; the durable execution is still awaited below.
      }
      try {
        await execution.promise;
      } catch {
        // The durable recovery projection below is authoritative.
      }
      if (!execution.store) return undefined;
      const current = await recoverWorkflowRun(
        { store: execution.store, owner: execution.owner },
        execution.runId,
      );
      if (current.terminal || current.cancellationRequested) return current;
      return commitInterruptedRun(
        execution.store,
        execution.owner,
        execution.runId,
        undefined,
        reason,
      );
    }),
  );
  return projections.filter(
    (projection): projection is WorkflowProjection => projection !== undefined,
  );
}

function activeOwnerKey(owner: WorkflowOwnerIdentity): string {
  return JSON.stringify([
    owner.projectKey,
    owner.cwd,
    owner.piSessionId,
    owner.ownerId,
    owner.ownerGeneration,
    owner.leaseToken,
  ]);
}

function isSessionShutdownAbort(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null || !("source" in reason))
    return false;
  return reason.source === "session_shutdown";
}

function sessionShutdownPayload(
  reason: "session_shutdown" = "session_shutdown",
): { reason: "session_shutdown" } {
  return { reason };
}

function activeExecutionKey(
  owner: WorkflowOwnerIdentity,
  runId: string,
): string {
  return JSON.stringify([
    owner.projectKey,
    owner.cwd,
    owner.piSessionId,
    owner.ownerId,
    owner.ownerGeneration,
    owner.leaseToken,
    runId,
  ]);
}

export interface DurableWorkflowControllerOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
  onApprovalDecision?: (runId: string, status: "approved" | "rejected") => void;
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
      if (projection.status === "error" && !projection.terminal) {
        const failed = Object.values(projection.tasks).find(
          (task) => task.status === "failed",
        );
        if (failed) {
          await this.append(runId, "run_result", {
            result: {
              status: "error",
              error: {
                code: "task_failed",
                message: failed.error ?? "Task failed",
              },
            },
          });
          await this.append(runId, "run_terminal", {});
        }
      }
      const repaired = await recoverWorkflowRun(this.options, runId);
      if (isTerminal(repaired.status) && !repaired.delivery) {
        await appendDeliveryIntent(
          this.options.store,
          this.options.owner,
          runId,
        );
        return recoverWorkflowRun(this.options, runId);
      }
      return repaired;
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

    // Admission is closed durably before any active provider is signalled.
    if (!projection.cancellationRequested) {
      await this.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "run_cancel_requested",
        {},
      );
    }

    const active = activeDurableExecutionRegistry.get(
      this.options.owner,
      runId,
    );
    if (active) {
      active.dispatcherSlot?.closeAdmission?.();
      if (!active.abortController.signal.aborted) {
        active.abortController.abort(
          new Error("Workflow cancellation requested"),
        );
      }
      await active.dispatcherSlot?.drain?.();
      try {
        await active.promise;
      } catch {
        // A provider/runner failure still leaves the durable journal as the
        // source of truth; cancellation terminalization below is idempotent.
      }
    }

    const drained = await this.getStatus(runId);
    if (!drained || isTerminal(drained.status)) return drained;
    return commitCancelledRun(this.options.store, this.options.owner, runId);
  }

  public async pauseForBudget(
    runId: string,
    reason?: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || isTerminal(projection.status)) return projection;
    if (projection.status === "awaiting_budget") return projection;
    await this.append(runId, "run_awaiting_budget", {
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
    await this.append(runId, "run_budget_resumed", {});
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
      const appendResult = await this.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
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
      if (appendResult.status === "conflict")
        throw staleWorkflowRevision(
          mutation.expectedRevision,
          appendResult.actualLastEventOrdinal + 1,
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
    const appendResult = await this.appendIfCurrent(
      runId,
      projection.lastEventOrdinal,
      eventType,
      withMutationHash({ taskId: mutation.taskId }, projection.mutationHash),
    );
    if (appendResult.status === "conflict")
      throw staleWorkflowRevision(
        mutation.expectedRevision,
        appendResult.actualLastEventOrdinal + 1,
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
      await this.append(runId, "delivery_receipt", { deliveryId });
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
      await this.append(runId, "delivery_dispatched", { deliveryId });
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
    await this.append(runId, "approval_requested", { request });
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
    await this.append(runId, "approval_decided", decision);
    if (decision.status === "rejected") {
      await this.append(runId, "run_blocked", {
        reason: decision.reason ?? "Workflow approval rejected",
      });
    }
    this.options.onApprovalDecision?.(runId, decision.status);
    return this.getStatus(runId);
  }

  private async append(
    runId: string,
    type: string,
    payload: unknown,
  ): Promise<unknown> {
    return appendCurrentEvent(this.options.store, runId, type, payload);
  }

  private async appendIfCurrent(
    runId: string,
    expectedLastEventOrdinal: number,
    type: string,
    payload: unknown,
  ): Promise<WorkflowConditionalAppendResult> {
    return appendCurrentConditionalEvent(
      this.options.store,
      runId,
      expectedLastEventOrdinal,
      type,
      payload,
    );
  }
}
async function currentRunEpoch(
  store: WorkflowRunStore,
  runId: string,
): Promise<number> {
  const candidate = (
    store as WorkflowRunStore & {
      getRunEpoch?: (id: string) => Promise<number>;
    }
  ).getRunEpoch;
  if (candidate) return candidate.call(store, runId);
  const events = (await store.readRun(runId)).events;
  return events.reduce(
    (epoch, event) =>
      Number.isSafeInteger(event.runEpoch) && event.runEpoch > epoch
        ? event.runEpoch
        : epoch,
    0,
  );
}

async function currentLeaseEpoch(store: WorkflowRunStore): Promise<number> {
  const candidate = (
    store as WorkflowRunStore & {
      getLeaseEpoch?: () => Promise<number>;
    }
  ).getLeaseEpoch;
  return candidate ? candidate.call(store) : 0;
}

async function appendCurrentEvent(
  store: WorkflowRunStore,
  runId: string,
  type: string,
  payload: unknown,
  runEpoch?: number,
): Promise<unknown> {
  const effectiveRunEpoch =
    runEpoch === undefined ? await currentRunEpoch(store, runId) : runEpoch;
  const leaseEpoch = await currentLeaseEpoch(store);
  return store.append(
    runId,
    type,
    payload,
    effectiveRunEpoch,
    undefined,
    leaseEpoch,
  );
}

async function appendCurrentConditionalEvent(
  store: WorkflowRunStore,
  runId: string,
  expectedLastEventOrdinal: number,
  type: string,
  payload: unknown,
  runEpoch?: number,
): Promise<WorkflowConditionalAppendResult> {
  const effectiveRunEpoch =
    runEpoch === undefined ? await currentRunEpoch(store, runId) : runEpoch;
  const leaseEpoch = await currentLeaseEpoch(store);
  return store.appendIfCurrent(
    runId,
    expectedLastEventOrdinal,
    type,
    payload,
    effectiveRunEpoch,
    leaseEpoch,
  );
}

function withMutationHash(
  payload: Record<string, unknown>,
  previousMutationHash: string | undefined,
): Record<string, unknown> {
  const previous = previousMutationHash ?? "";
  const mutationHash = createHash("sha256")
    .update(
      canonicalizeWorkflowValue({ previousMutationHash: previous, payload }),
    )
    .digest("hex");
  return { ...payload, previousMutationHash: previous, mutationHash };
}

function staleWorkflowRevision(expected: number, current: number): Error {
  return new Error(
    `Workflow plan revision is stale: expected ${expected}, current ${current}`,
  );
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
  // Durable admission owns one immutable snapshot. Process isolation is
  // rejected here, before lookup/create, while non-durable previews retain
  // their independent validation and runner behavior.
  const normalizedPlan =
    options.plan.schemaVersion === 1
      ? normalizeWorkflowPlan(options.plan, { durable: true })
      : options.plan;
  const normalizedOptions = { ...options, plan: normalizedPlan };
  const existing = activeDurableExecutionRegistry.get(
    options.owner,
    options.runId,
  );
  if (existing) return existing.promise;

  const abortController = new AbortController();
  const abortListener = () => {
    abortController.abort(options.signal?.reason);
  };
  if (options.signal) {
    if (options.signal.aborted) abortListener();
    else
      options.signal.addEventListener("abort", abortListener, { once: true });
  }
  let resolveExecution!: (projection: WorkflowProjection) => void;
  let rejectExecution!: (error: unknown) => void;
  const executionPromise = new Promise<WorkflowProjection>(
    (resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    },
  );
  // Keep the registry promise awaitable for trusted cancellation while
  // preventing an executor failure from becoming an unhandled rejection when
  // no controller is observing it.
  void executionPromise.catch(() => undefined);
  const execution: ActiveDurableWorkflowExecution = {
    runId: options.runId,
    owner: options.owner,
    store: options.store,
    abortController,
    promise: executionPromise,
    dispatcherSlot: {
      closeAdmission: () => {
        // Admission is closed by the caller before the abort signal is
        // delivered. The signal itself is owned by the caller so shutdown
        // can preserve its typed reason.
      },
    },
  };
  const duplicate = activeDurableExecutionRegistry.register(execution);
  if (duplicate) {
    if (options.signal)
      options.signal.removeEventListener("abort", abortListener);
    return duplicate.promise;
  }
  try {
    const result = await executeDurableWorkflowPlan({
      ...normalizedOptions,
      signal: abortController.signal,
    });
    resolveExecution(result);
    return result;
  } catch (error) {
    rejectExecution(error);
    throw error;
  } finally {
    if (options.signal)
      options.signal.removeEventListener("abort", abortListener);
    activeDurableExecutionRegistry.unregister(execution);
  }
}

async function executeDurableWorkflowPlan(
  options: DurableWorkflowPlanOptions,
): Promise<WorkflowProjection> {
  const { store, owner, runId, plan } = options;
  const planDigest =
    plan.schemaVersion === 1 ? canonicalWorkflowPlanDigest(plan) : "";
  const publish = (next: WorkflowProjection): WorkflowProjection => {
    options.onProjection?.(next);
    return next;
  };
  let projection: WorkflowProjection;
  let runEpoch = 1;
  const controller = new DurableWorkflowController({ store, owner });
  const append = (type: string, payload: unknown) =>
    appendCurrentEvent(store, runId, type, payload, runEpoch);
  try {
    const recovered = await controller.getStatus(runId);
    if (!recovered) {
      const missing = new Error("Workflow run not found");
      Object.assign(missing, { code: "ENOENT" });
      throw missing;
    }
    projection = recovered;
    runEpoch = Math.max(1, await currentRunEpoch(store, runId));
  } catch (error) {
    if (!isMissingRun(error)) throw error;
    // Do not leave an orphaned run directory for an invalid new plan.
    if (plan.schemaVersion !== 1)
      throw new Error("Invalid workflow plan header");
    await store.createRun({
      runId,
      planRevision: plan.schemaVersion,
      planDigest,
      plan,
      resumePolicy: options.resumePolicy ?? "manual",
      owner,
    });
    runEpoch = Math.max(1, await currentRunEpoch(store, runId));
    await append("run_created", {
      tasks: plan.phases.flatMap((phase) =>
        phase.tasks.map((task) => ({
          id: task.id,
          phaseId: phase.id,
          prompt: task.prompt,
          ...(task.label === undefined ? {} : { label: task.label }),
          ...(task.input === undefined ? {} : { input: task.input }),
        })),
      ),
    });
    projection = (await controller.getStatus(runId)) as WorkflowProjection;
  }
  if (projection.status === "running") {
    // No local registry entry exists at this point, so a running claim belongs
    // to a crashed/reloaded executor. Fence it before any trusted resume.
    await append("run_interrupted", { reason: "stale_execution" });
    projection = (await controller.getStatus(runId)) as WorkflowProjection;
    runEpoch = Math.max(1, await currentRunEpoch(store, runId));
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
  const launch = await store.readRun(runId);
  if (launch.launch.planDigest && launch.launch.planDigest !== planDigest) {
    throw new Error("Workflow plan definition mismatch");
  }
  // The stored revision owns mismatch reporting before resume validation.
  if (isTerminal(projection.status)) return publish(projection);
  if (projection.status === "interrupted" && options.resume) {
    runEpoch = Math.max(1, runEpoch + 1);
  }
  if (options.signal?.aborted || projection.cancellationRequested) {
    return publish(
      await commitAbortedDurableRun(
        store,
        owner,
        runId,
        runEpoch,
        options.signal,
      ),
    );
  }
  if (isRunDispatchSuspended(projection)) return publish(projection);
  if (projection.status === "created" || projection.status === "interrupted") {
    await append("run_started", {});
  }

  for (const phase of plan.phases) {
    const tasks = phase.tasks.filter((task) => {
      const current = projection.tasks[task.id];
      return current?.status !== "succeeded" && current?.status !== "skipped";
    });
    if (phase.mode === "parallel") {
      const completed = await runDurableParallelPhase(
        options,
        phase.id,
        tasks,
        runEpoch,
      );
      if (!completed) {
        const recovered = await recoverWorkflowRun({ store, owner }, runId);
        if (isTerminal(recovered.status))
          await appendDeliveryIntent(store, owner, runId, runEpoch);
        return publish(recovered);
      }
      continue;
    }
    for (const task of tasks) {
      projection = (await controller.getStatus(runId)) as WorkflowProjection;
      const existing = projection.tasks[task.id];
      if (existing?.status === "succeeded" || existing?.status === "skipped")
        continue;
      if (
        isRunDispatchSuspended(projection) ||
        projection.cancellationRequested ||
        !isTaskDispatchable(existing)
      )
        return publish(projection);
      if (options.signal?.aborted) {
        return publish(
          await commitAbortedDurableRun(
            store,
            owner,
            runId,
            runEpoch,
            options.signal,
          ),
        );
      }
      const attempt = (existing?.attempt ?? 0) + 1;
      await append("task_started", {
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
        if (options.signal?.aborted) {
          return publish(
            await commitAbortedDurableRun(
              store,
              owner,
              runId,
              runEpoch,
              options.signal,
            ),
          );
        }
        await append("usage_observed", {
          input: result.usage.input,
          output: result.usage.output,
          taskId: task.id,
          attempt,
        });
        if (result.isError) {
          await append("task_failed", {
            taskId: task.id,
            attempt,
            error: result.errorMessage ?? "Task failed",
          });
          await append("run_result", {
            result: {
              status: "error",
              error: {
                code: "task_failed",
                message: result.errorMessage ?? "Task failed",
              },
            },
          });
          await append("run_terminal", {});
          await appendDeliveryIntent(store, owner, runId, runEpoch);
          return publish(await recoverWorkflowRun({ store, owner }, runId));
        }
        await append("task_succeeded", {
          taskId: task.id,
          attempt,
          result: result.output,
        });
      } catch (error) {
        if (isSessionShutdownAbort(options.signal?.reason)) {
          return publish(
            await commitAbortedDurableRun(
              store,
              owner,
              runId,
              runEpoch,
              options.signal,
            ),
          );
        }
        if (options.signal?.aborted || projection.cancellationRequested) {
          return publish(
            await commitCancelledRun(store, owner, runId, runEpoch),
          );
        }
        await append("run_interrupted", {});
        throw error;
      }
    }
  }

  // Mutations are authoritative. Re-read after the declared plan so work
  // appended while the coordinator was running cannot be silently ignored.
  projection = await recoverWorkflowRun({ store, owner }, runId);
  if (isRunDispatchSuspended(projection) || projection.cancellationRequested)
    return publish(projection);
  const declaredTaskIds = new Set(
    plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
  );
  const executedAppended = new Set<string>();
  while (true) {
    projection = (await controller.getStatus(runId)) as WorkflowProjection;
    const appended = Object.values(projection.tasks).filter((task) => {
      return (
        !declaredTaskIds.has(task.id) &&
        !executedAppended.has(task.id) &&
        task.prompt &&
        task.status !== "succeeded" &&
        task.status !== "skipped" &&
        task.status !== "blocked"
      );
    });
    if (appended.length === 0) break;
    for (const task of appended) {
      executedAppended.add(task.id);
      if (
        declaredTaskIds.has(task.id) ||
        !task.prompt ||
        task.status === "succeeded" ||
        task.status === "skipped" ||
        task.status === "blocked"
      )
        continue;
      if (options.signal?.aborted) {
        return publish(
          await commitAbortedDurableRun(
            store,
            owner,
            runId,
            runEpoch,
            options.signal,
          ),
        );
      }
      const attempt = task.attempt + 1;
      await append("task_started", {
        taskId: task.id,
        attempt,
        phaseId: task.phaseId ?? "appended",
      });
      let result: SubagentResult;
      try {
        result = await options.runAgent({
          prompt: task.prompt,
          isolation: "in-process",
          label: task.label ?? task.id,
          signal: options.signal,
        });
        if (options.signal?.aborted) {
          return publish(
            await commitAbortedDurableRun(
              store,
              owner,
              runId,
              runEpoch,
              options.signal,
            ),
          );
        }
      } catch (error) {
        if (isSessionShutdownAbort(options.signal?.reason)) {
          return publish(
            await commitAbortedDurableRun(
              store,
              owner,
              runId,
              runEpoch,
              options.signal,
            ),
          );
        }
        if (options.signal?.aborted || projection.cancellationRequested) {
          return publish(
            await commitCancelledRun(store, owner, runId, runEpoch),
          );
        }
        await append("run_interrupted", {});
        throw error;
      }
      await append("usage_observed", {
        input: result.usage.input,
        output: result.usage.output,
        taskId: task.id,
        attempt,
      });
      if (result.isError) {
        const message = result.errorMessage ?? "Task failed";
        await append("task_failed", {
          taskId: task.id,
          attempt,
          error: message,
        });
        await append("run_result", {
          result: { status: "error", error: { code: "task_failed", message } },
        });
        await append("run_terminal", {});
        await appendDeliveryIntent(store, owner, runId, runEpoch);
        return publish(await recoverWorkflowRun({ store, owner }, runId));
      }
      await append("task_succeeded", {
        taskId: task.id,
        attempt,
        result: result.output,
      });
    }
  }

  projection = await recoverWorkflowRun({ store, owner }, runId);
  if (options.signal?.aborted) {
    return publish(
      await commitAbortedDurableRun(
        store,
        owner,
        runId,
        runEpoch,
        options.signal,
      ),
    );
  }
  if (isRunDispatchSuspended(projection) || projection.cancellationRequested)
    return publish(projection);
  await append("run_result", {
    result: { status: "done", result: "Workflow completed" },
  });
  await append("run_terminal", {});
  await appendDeliveryIntent(store, owner, runId, runEpoch);
  projection = await recoverWorkflowRun({ store, owner }, runId);
  return publish(projection);
}

async function runDurableParallelPhase(
  options: DurableWorkflowPlanOptions,
  phaseId: string,
  tasks: WorkflowPlan["phases"][number]["tasks"],
  runEpoch: number,
): Promise<boolean> {
  const limit = Math.max(1, Math.min(4, tasks.length));
  let nextIndex = 0;
  let firstError: unknown;
  let interrupted = false;
  const append = (type: string, payload: unknown) =>
    appendCurrentEvent(options.store, options.runId, type, payload, runEpoch);
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const task = tasks[nextIndex++];
      if (!task) return;
      const projection = await recoverWorkflowRun(
        { store: options.store, owner: options.owner },
        options.runId,
      );
      const attempt = (projection.tasks[task.id]?.attempt ?? 0) + 1;
      if (
        isRunDispatchSuspended(projection) ||
        projection.cancellationRequested ||
        !isTaskDispatchable(projection.tasks[task.id])
      )
        return;
      if (options.signal?.aborted) {
        firstError = options.signal.reason ?? new Error("Workflow cancelled");
        interrupted = isSessionShutdownAbort(options.signal.reason);
        return;
      }
      await append("task_started", {
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
        if (options.signal?.aborted) {
          firstError = options.signal.reason ?? new Error("Workflow cancelled");
          interrupted = isSessionShutdownAbort(options.signal.reason);
          return;
        }
        await append("usage_observed", {
          input: result.usage.input,
          output: result.usage.output,
          taskId: task.id,
          attempt,
        });
        if (result.isError) {
          const message = result.errorMessage ?? "Task failed";
          await append("task_failed", {
            taskId: task.id,
            attempt,
            error: message,
          });
          if (firstError === undefined) firstError = new Error(message);
          return;
        }
        await append("task_succeeded", {
          taskId: task.id,
          attempt,
          result: result.output,
        });
      } catch (error) {
        if (isSessionShutdownAbort(options.signal?.reason)) {
          interrupted = true;
          firstError ??= error;
          return;
        }
        if (options.signal?.aborted || projection.cancellationRequested) {
          firstError ??= error;
          return;
        }
        if (firstError === undefined) {
          interrupted = true;
          firstError = error;
          await append("run_interrupted", {});
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (firstError !== undefined) {
    if (interrupted) {
      if (isSessionShutdownAbort(options.signal?.reason)) {
        await commitAbortedDurableRun(
          options.store,
          options.owner,
          options.runId,
          runEpoch,
          options.signal,
        );
        return false;
      }
      throw firstError;
    }
    if (options.signal?.aborted) {
      await commitAbortedDurableRun(
        options.store,
        options.owner,
        options.runId,
        runEpoch,
        options.signal,
      );
      return false;
    }
    await append("run_result", {
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
    await append("run_terminal", {});
    await appendDeliveryIntent(
      options.store,
      options.owner,
      options.runId,
      runEpoch,
    );
    return false;
  }
  return true;
}

async function appendDeliveryIntent(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  runEpoch?: number,
): Promise<void> {
  const projection = await recoverWorkflowRun({ store, owner }, runId);
  if (projection.delivery) return;
  await appendCurrentEvent(
    store,
    runId,
    "delivery_intent",
    {
      deliveryId: workflowDeliveryId(runId),
      message: workflowDeliveryMessage(projection),
    },
    runEpoch,
  );
}

async function commitAbortedDurableRun(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  runEpoch: number,
  signal: AbortSignal | undefined,
): Promise<WorkflowProjection> {
  const current = await recoverWorkflowRun({ store, owner }, runId);
  if (
    signal?.aborted &&
    isSessionShutdownAbort(signal.reason) &&
    !current.cancellationRequested
  ) {
    return commitInterruptedRun(
      store,
      owner,
      runId,
      runEpoch,
      "session_shutdown",
    );
  }
  return commitCancelledRun(store, owner, runId, runEpoch);
}

async function commitInterruptedRun(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  runEpoch?: number,
  reason: "session_shutdown" = "session_shutdown",
): Promise<WorkflowProjection> {
  const current = await recoverWorkflowRun({ store, owner }, runId);
  if (current.terminal || current.cancellationRequested) return current;
  if (current.status !== "interrupted") {
    await appendCurrentEvent(
      store,
      runId,
      "run_interrupted",
      sessionShutdownPayload(reason),
      runEpoch,
    );
  }
  return recoverWorkflowRun({ store, owner }, runId);
}

const cancellationCommitPromises = new Map<
  string,
  Promise<WorkflowProjection>
>();

async function commitCancelledRun(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  runEpoch?: number,
): Promise<WorkflowProjection> {
  const key = activeExecutionKey(owner, runId);
  const existing = cancellationCommitPromises.get(key);
  if (existing) return existing;
  const pending = commitCancelledRunInternal(store, owner, runId, runEpoch);
  cancellationCommitPromises.set(key, pending);
  void pending.then(
    () => {
      if (cancellationCommitPromises.get(key) === pending)
        cancellationCommitPromises.delete(key);
    },
    () => {
      if (cancellationCommitPromises.get(key) === pending)
        cancellationCommitPromises.delete(key);
    },
  );
  return pending;
}

async function commitCancelledRunInternal(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  runEpoch?: number,
): Promise<WorkflowProjection> {
  let current = await recoverWorkflowRun({ store, owner }, runId);
  if (current.terminal) return current;
  const effectiveRunEpoch =
    runEpoch === undefined ? await currentRunEpoch(store, runId) : runEpoch;
  if (!current.cancellationRequested) {
    await appendCurrentEvent(
      store,
      runId,
      "run_cancel_requested",
      {},
      effectiveRunEpoch,
    );
    current = await recoverWorkflowRun({ store, owner }, runId);
  }
  if (current.terminal) return current;
  current = await settleCancelledTasks(store, owner, runId, effectiveRunEpoch);
  if (current.terminal) return current;
  await appendCurrentEvent(
    store,
    runId,
    "run_result",
    { result: { status: "cancelled" } },
    effectiveRunEpoch,
  );
  const hasCancellationMarker = (await store.readRun(runId)).events.some(
    (event) => event.type === "run_cancelled",
  );
  if (!hasCancellationMarker) {
    await appendCurrentEvent(
      store,
      runId,
      "run_cancelled",
      {},
      effectiveRunEpoch,
    );
  }
  await appendDeliveryIntent(store, owner, runId, effectiveRunEpoch);
  return recoverWorkflowRun({ store, owner }, runId);
}

async function settleCancelledTasks(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  runEpoch: number,
): Promise<WorkflowProjection> {
  let current = await recoverWorkflowRun({ store, owner }, runId);
  for (const task of Object.values(current.tasks)) {
    if (isTerminalTaskStatus(task.status)) continue;
    await appendCurrentEvent(
      store,
      runId,
      "task_skipped",
      {
        taskId: task.id,
        attempt: task.attempt,
        reason: "cancelled",
      },
      runEpoch,
    );
    current = await recoverWorkflowRun({ store, owner }, runId);
  }
  return current;
}

function isRunDispatchSuspended(projection: WorkflowProjection): boolean {
  return (
    projection.cancellationRequested ||
    projection.status === "blocked" ||
    projection.status === "awaiting_budget" ||
    projection.approval?.status === "pending"
  );
}

function isTaskDispatchable(
  task: WorkflowProjection["tasks"][string] | undefined,
): boolean {
  return (
    task === undefined || task.status === "pending" || task.status === "running"
  );
}
function isTerminalTaskStatus(
  status: WorkflowProjection["tasks"][string]["status"],
): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

function isTerminal(status: WorkflowProjection["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isMissingRun(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
