import { createHash, randomUUID } from "node:crypto";
import type { SubagentResult } from "./helpers";
import {
  WorkflowExecutionError,
  type WorkflowAgentRunner,
  type WorkflowUsage,
} from "./workflow-core";
import { toDurableValue, type DurableValue } from "./workflow-durable-value";
import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import {
  DurableWorkflowProjectionRepository,
  projectWorkflowRun,
  type WorkflowProjection,
  type WorkflowProjectionOperation,
  type WorkflowProjectionRepository,
  type WorkflowTaskClaim,
} from "./workflow-projection-repository";
import { WorkflowRunStore } from "./workflow-run-store";
import type {
  WorkflowOwnerIdentity,
  WorkflowResumePolicy,
  WorkflowTerminalResult,
} from "./workflow-run-types";

export type { WorkflowTaskClaim } from "./workflow-projection-repository";

export interface DurableWorkflowPlanOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
  runId: string;
  plan: WorkflowPlan;
  resumePolicy?: WorkflowResumePolicy;
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  onProjection?: (projection: WorkflowProjection) => void;
}

export interface DurableWorkflowControllerOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
  projectionRepository?: WorkflowProjectionRepository;
}

export interface DurableWorkflowResumeOptions {
  expectedRevision: number;
  expectedRunEpoch: number;
  ownerGeneration: number;
  leaseEpoch: number;
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  onProjection?: (projection: WorkflowProjection) => void;
}

export type DurableWorkflowCreateOptions = Omit<
  DurableWorkflowPlanOptions,
  "store" | "owner"
>;

export interface DurableWorkflowStart {
  /** `run_created` is fsynced before this projection is returned. */
  projection: WorkflowProjection;
  /** Live convenience only; durable status never depends on this Promise. */
  completion: Promise<WorkflowProjection>;
}

interface ExecuteOptions extends DurableWorkflowPlanOptions {
  ownsExecution: boolean;
}

interface DispatchedAttempt {
  claim: WorkflowTaskClaim;
  result: Promise<SubagentResult>;
}

const runGates = new Map<string, Promise<void>>();

/** Owner-scoped durable creation, inspection, cancellation, and trusted resume. */
export class DurableWorkflowController {
  private readonly repository: WorkflowProjectionRepository;

  public constructor(
    private readonly options: DurableWorkflowControllerOptions,
  ) {
    this.repository =
      options.projectionRepository ??
      new DurableWorkflowProjectionRepository(options.store, options.owner);
  }

  public async create(
    options: DurableWorkflowCreateOptions,
  ): Promise<DurableWorkflowStart> {
    return prepareDurableWorkflowRun({
      ...options,
      store: this.options.store,
      owner: this.options.owner,
    });
  }

  public getStatus(runId: string): Promise<WorkflowProjection | undefined> {
    return this.repository.get(runId);
  }

  public async getResult(
    runId: string,
  ): Promise<WorkflowTerminalResult | undefined> {
    return (await this.getStatus(runId))?.terminal;
  }

  public async cancel(
    runId: string,
    requestId: string = randomUUID(),
    interruptAndDrain?: () => Promise<void>,
    revalidate?: () => void | Promise<void>,
  ): Promise<WorkflowProjection | undefined> {
    return withRunGate(gateKey(this.options.owner, runId), async () => {
      let cancellationRequested = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const projection = await this.repository.get(runId);
        if (!projection || projection.terminal) return projection;
        if (projection.cancellation) {
          cancellationRequested = true;
          break;
        }
        const leaseEpoch = await this.options.store.getLeaseEpoch();
        const eventEpoch = Math.max(projection.runEpoch, leaseEpoch);
        const failed = Object.values(projection.tasks).find(
          (task) => task.status === "failed",
        );
        if (failed) {
          await revalidate?.();
          const terminal = await this.options.store.appendIfCurrent(
            runId,
            projection.lastEventOrdinal,
            "run_result",
            {
              result: {
                status: "error",
                error: {
                  code: "task_failed",
                  message: failed.error ?? "Task failed",
                },
              },
            },
            eventEpoch,
          );
          if (terminal.status === "conflict") continue;
          return this.repository.get(runId);
        }
        await revalidate?.();
        const requested = await this.options.store.appendIfCurrent(
          runId,
          projection.lastEventOrdinal,
          "run_cancel_requested",
          { requestId },
          eventEpoch,
        );
        if (requested.status === "conflict") continue;
        cancellationRequested = true;
        break;
      }
      if (!cancellationRequested) {
        const latest = await this.requiredProjection(runId);
        if (latest.terminal) return latest;
        throw staleRevision(latest.revision);
      }

      await revalidate?.();
      try {
        await interruptAndDrain?.();
      } catch {
        // The durable fence below is authoritative when a live drain fails.
      }

      for (let attempt = 0; attempt < 16; attempt++) {
        const projection = await this.requiredProjection(runId);
        if (projection.terminal) return projection;
        const operation = Object.values(projection.operations).find(
          (candidate) =>
            candidate.status === "attempt_settled" ||
            candidate.status === "running",
        );
        if (operation?.status === "attempt_settled") {
          await settlePreparedOutcome(
            {
              store: this.options.store,
              owner: this.options.owner,
              runId,
            },
            projection,
            operation,
            revalidate,
          );
          continue;
        }
        if (operation?.status === "running") {
          await persistProjectedInterruption(
            {
              store: this.options.store,
              owner: this.options.owner,
              runId,
            },
            projection,
            operation,
            revalidate,
          );
          continue;
        }
        const leaseEpoch = await this.options.store.getLeaseEpoch();
        await revalidate?.();
        const cancelled = await this.options.store.appendIfCurrent(
          runId,
          projection.lastEventOrdinal,
          "run_cancelled",
          { requestId: projection.cancellation?.requestId ?? requestId },
          Math.max(projection.runEpoch, leaseEpoch),
        );
        if (cancelled.status === "conflict") continue;
        return this.repository.get(runId);
      }
      const latest = await this.requiredProjection(runId);
      if (latest.terminal) return latest;
      throw staleRevision(latest.revision);
    });
  }

  /** Trusted host entrypoint. No model-facing caller can bypass its fences. */
  public async resume(
    runId: string,
    request: DurableWorkflowResumeOptions,
  ): Promise<WorkflowProjection | undefined> {
    let plan: WorkflowPlan | undefined;
    const projection = await withRunGate(
      gateKey(this.options.owner, runId),
      async () => {
        const current = await this.repository.get(runId);
        if (!current || current.terminal) return current;
        if (request.expectedRevision !== current.revision) {
          throw new Error(
            `Workflow resume revision is stale: expected ${request.expectedRevision}, current ${current.revision}`,
          );
        }
        if (request.expectedRunEpoch !== current.runEpoch) {
          throw new Error(
            `Workflow run epoch is stale: expected ${request.expectedRunEpoch}, current ${current.runEpoch}`,
          );
        }
        if (request.ownerGeneration !== this.options.owner.ownerGeneration) {
          throw new Error("Workflow resume owner generation is stale");
        }
        const leaseEpoch = await this.options.store.getLeaseEpoch();
        if (request.leaseEpoch !== leaseEpoch) {
          throw new Error(
            `Workflow resume lease epoch is stale: expected ${request.leaseEpoch}, current ${leaseEpoch}`,
          );
        }
        const nextRunEpoch = Math.max(current.runEpoch, leaseEpoch);

        plan = await readStoredPlan(this.options.store, runId);
        const appended = await this.options.store.appendIfCurrent(
          runId,
          current.lastEventOrdinal,
          "run_resume_requested",
          {
            resumeRevision: current.resumeRevision + 1,
            expectedRevision: request.expectedRevision,
            previousRunEpoch: current.runEpoch,
            ownerGeneration: request.ownerGeneration,
            leaseEpoch,
          },
          nextRunEpoch,
        );
        if (appended.status === "conflict") {
          const latest = await this.requiredProjection(runId);
          throw staleRevision(latest.revision);
        }
        return this.requiredProjection(runId);
      },
    );
    if (!projection || projection.terminal || !plan) return projection;

    return executeDurableWorkflowPlan({
      store: this.options.store,
      owner: this.options.owner,
      runId,
      plan,
      resumePolicy: "manual",
      runAgent: request.runAgent,
      signal: request.signal,
      onProjection: request.onProjection,
      ownsExecution: true,
    });
  }

  private async requiredProjection(runId: string): Promise<WorkflowProjection> {
    const projection = await this.repository.get(runId);
    if (!projection) throw new Error(`Workflow run not found: ${runId}`);
    return projection;
  }
}

/** Create and execute a new run, or read an existing run without auto-resuming it. */
export async function runDurableWorkflowPlan(
  options: DurableWorkflowPlanOptions,
): Promise<WorkflowProjection> {
  return (await prepareDurableWorkflowRun(options)).completion;
}

async function prepareDurableWorkflowRun(
  options: DurableWorkflowPlanOptions,
): Promise<DurableWorkflowStart> {
  if (options.resumePolicy && options.resumePolicy !== "manual") {
    throw new Error("Durable workflow preview supports only manual resume");
  }
  const plan = durablePlan(options.plan);
  const repository = new DurableWorkflowProjectionRepository(
    options.store,
    options.owner,
  );
  let projection = await repository.get(options.runId);
  let created = false;

  if (!projection) {
    const runEpoch = await options.store.getLeaseEpoch();
    const creation = await options.store.createRunWithInitialEvent(
      {
        runId: options.runId,
        planRevision: plan.schemaVersion,
        resumePolicy: "manual",
        owner: options.owner,
      },
      {
        type: "run_created",
        payload: { plan },
        runEpoch,
      },
    );
    created = true;
    projection = projectWorkflowRun(creation.launch, [creation.initialEvent]);
  } else {
    const stored = await readStoredPlan(options.store, options.runId);
    assertStoredPlanMatches(projection, stored, plan);
  }

  options.onProjection?.(projection);
  const completion =
    created && !projection.terminal
      ? executeDurableWorkflowPlan({
          ...options,
          plan,
          ownsExecution: true,
        })
      : Promise.resolve(projection);
  return { projection, completion };
}

async function executeDurableWorkflowPlan(
  options: ExecuteOptions,
): Promise<WorkflowProjection> {
  const repository = new DurableWorkflowProjectionRepository(
    options.store,
    options.owner,
    { preserveCreated: true },
  );
  let projection = await requiredProjection(repository, options.runId);
  if (projection.terminal) return projection;

  const failedAtEntry = Object.values(projection.tasks).find(
    (task) => task.status === "failed",
  );
  if (failedAtEntry) {
    return commitTerminalResult(options, repository, {
      status: "error",
      error: {
        code: "task_failed",
        message: failedAtEntry.error ?? "Task failed",
      },
    });
  }
  if (!options.ownsExecution) return projection;

  if (projection.status === "created") {
    const leaseEpoch = await currentEpoch(options, projection);
    const started = await options.store.appendIfCurrent(
      options.runId,
      projection.lastEventOrdinal,
      "run_started",
      {},
      leaseEpoch,
    );
    if (started.status === "conflict") {
      projection = await requiredProjection(repository, options.runId);
      if (projection.terminal) return projection;
      throw staleRevision(projection.revision);
    }
  }

  for (const phase of options.plan.phases) {
    for (const task of phase.tasks) {
      const operationId = task.id;
      const expectedRequestDigest = requestDigest(phase.id, task);
      while (true) {
        projection = await requiredProjection(repository, options.runId);
        options.onProjection?.(projection);
        if (projection.terminal) return projection;
        if (projection.cancellation || options.signal?.aborted) {
          return projection;
        }

        const projectedTask = projection.tasks[task.id];
        if (projectedTask?.status === "succeeded") break;
        if (projectedTask?.status === "failed") {
          return commitTerminalResult(options, repository, {
            status: "error",
            error: {
              code: "task_failed",
              message: projectedTask.error ?? "Task failed",
            },
          });
        }

        const operation = projection.operations[operationId];
        if (
          operation &&
          (operation.taskId !== task.id || operation.phaseId !== phase.id)
        ) {
          throw new Error(`Workflow operation replay diverged for ${task.id}`);
        }
        if (operation?.status === "settled") continue;
        if (operation?.status === "attempt_settled") {
          const reconciled = await settlePreparedOutcome(
            options,
            projection,
            operation,
          );
          if (!reconciled) continue;
          const afterSettlement = await requiredProjection(
            repository,
            options.runId,
          );
          const settledTask = afterSettlement.tasks[task.id];
          if (settledTask?.status === "failed") {
            return commitTerminalResult(options, repository, {
              status: "error",
              error: {
                code: "task_failed",
                message: settledTask.error ?? "Task failed",
              },
            });
          }
          if (settledTask?.status === "succeeded") break;
          continue;
        }

        if (!operation) {
          const epoch = await currentEpoch(options, projection);
          const prepared = await options.store.appendIfCurrent(
            options.runId,
            projection.lastEventOrdinal,
            "operation_prepared",
            {
              taskId: task.id,
              phaseId: phase.id,
              operationId,
              requestDigest: expectedRequestDigest,
            },
            epoch,
          );
          if (prepared.status === "conflict") continue;
          continue;
        }

        if (operation.status === "running") {
          // A cold prefix with an uncommitted attempt requires another trusted
          // resume event before a new attempt may be allocated.
          return projection;
        }

        let dispatched: DispatchedAttempt | undefined;
        let result: SubagentResult;
        try {
          dispatched = await claimAndDispatch(
            options,
            operation,
            task.prompt,
            task.label ?? task.id,
          );
          if (!dispatched) continue;
          result = await dispatched.result;
        } catch (error) {
          if (options.signal?.aborted) {
            if (dispatched) {
              await persistAttemptInterruption(options, dispatched, error);
            }
            return requiredProjection(repository, options.runId);
          }
          // No outcome event is invented. Recovery projects this provider window
          // as interrupted and lower-bound, then trusted resume starts attempt N+1.
          throw error;
        }

        const settled = await persistAttemptOutcome(
          options,
          dispatched,
          result,
        );
        if (!settled) {
          return requiredProjection(repository, options.runId);
        }
        const latest = await requiredProjection(repository, options.runId);
        const latestOperation = latest.operations[operationId];
        if (!latestOperation || latestOperation.status !== "attempt_settled") {
          return latest;
        }
        await settlePreparedOutcome(options, latest, latestOperation);
      }
    }
  }

  projection = await requiredProjection(repository, options.runId);
  if (projection.terminal) return projection;
  const incomplete = Object.values(projection.tasks).find(
    (task) => task.status !== "succeeded",
  );
  if (incomplete) return projection;

  return commitTerminalResult(options, repository, {
    status: "done",
    result: "Workflow completed",
  });
}

async function claimAndDispatch(
  options: ExecuteOptions,
  operation: WorkflowProjectionOperation,
  prompt: string,
  label: string,
): Promise<DispatchedAttempt | undefined> {
  return withRunGate(gateKey(options.owner, options.runId), async () => {
    const repository = new DurableWorkflowProjectionRepository(
      options.store,
      options.owner,
    );
    const current = await requiredProjection(repository, options.runId);
    if (current.terminal || current.cancellation) return undefined;
    const liveOperation = current.operations[operation.operationId];
    if (!liveOperation || liveOperation.status !== "prepared") return undefined;
    const runEpoch = await currentEpoch(options, current);
    const leaseEpoch = await options.store.getLeaseEpoch();
    const attempt = liveOperation.attempt + 1;
    const claim: WorkflowTaskClaim = {
      runId: options.runId,
      taskId: liveOperation.taskId,
      operationId: liveOperation.operationId,
      attempt,
      runEpoch,
      ownerId: options.owner.ownerId,
      ownerGeneration: options.owner.ownerGeneration,
      leaseEpoch,
      token: randomUUID(),
    };
    const appended = await options.store.appendIfCurrent(
      options.runId,
      current.lastEventOrdinal,
      "attempt_started",
      {
        taskId: liveOperation.taskId,
        phaseId: liveOperation.phaseId,
        operationId: liveOperation.operationId,
        attempt,
        claim,
      },
      runEpoch,
    );
    if (appended.status === "conflict") return undefined;

    // Invoke the runner while the in-process operation gate is still held. A
    // cancellation append cannot slip between the durable claim and dispatch.
    const result = options.runAgent({
      prompt,
      isolation: "in-process",
      label,
      signal: options.signal,
    });
    return { claim, result };
  });
}

async function persistAttemptOutcome(
  options: ExecuteOptions,
  claimed: DispatchedAttempt,
  result: SubagentResult,
): Promise<boolean> {
  if ((await options.store.getLeaseEpoch()) !== claimed.claim.leaseEpoch) {
    return false;
  }
  let outcome: DurableValue;
  try {
    outcome = toDurableValue(
      result.isError
        ? { status: "failed", error: boundedError(result.errorMessage) }
        : { status: "succeeded", result: result.output },
    );
  } catch {
    outcome = toDurableValue({
      status: "failed",
      error: "Task outcome exceeded durable storage bounds",
    });
  }
  // The immutable blob is fsynced first. It has no authority until the
  // conditional attempt settlement below references its digest and size.
  const outcomeRef = await options.store.writeOutcomeBlob(
    options.runId,
    outcome,
  );
  const appended = await appendAttemptEventIfActive(
    options,
    claimed.claim,
    "attempt_settled",
    {
      outcomeRef,
      usage: durableAttemptUsage(result.usage),
      usageProvenance: "exact",
    },
  );
  return appended;
}

async function persistAttemptInterruption(
  options: ExecuteOptions,
  claimed: DispatchedAttempt,
  error: unknown,
): Promise<boolean> {
  return appendAttemptEventIfActive(
    options,
    claimed.claim,
    "attempt_interrupted",
    {
      usage: durableInterruptedUsage(error),
      usageProvenance: "lower_bound",
    },
  );
}

async function appendAttemptEventIfActive(
  options: Pick<ExecuteOptions, "store" | "owner" | "runId">,
  claim: WorkflowTaskClaim,
  type: "attempt_settled" | "attempt_interrupted",
  payload: Record<string, unknown>,
  revalidate?: () => void | Promise<void>,
): Promise<boolean> {
  const repository = new DurableWorkflowProjectionRepository(
    options.store,
    options.owner,
    { preserveCreated: true },
  );
  for (let retry = 0; retry < 8; retry++) {
    if ((await options.store.getLeaseEpoch()) !== claim.leaseEpoch)
      return false;
    const projection = await requiredProjection(repository, options.runId);
    if (projection.terminal) return false;
    const operation = projection.operations[claim.operationId];
    const attempt = operation?.attempts[claim.attempt];
    if (
      operation?.status !== "running" ||
      !attempt ||
      (attempt.status !== "running" && attempt.status !== "interrupted") ||
      !sameAttemptClaim(attempt.claim, claim)
    ) {
      return false;
    }
    await revalidate?.();
    const appended = await options.store.appendIfCurrent(
      options.runId,
      projection.lastEventOrdinal,
      type,
      {
        taskId: claim.taskId,
        operationId: claim.operationId,
        attempt: claim.attempt,
        claim,
        ...payload,
      },
      claim.runEpoch,
    );
    if (appended.status === "appended") return true;
  }
  return false;
}

async function persistProjectedInterruption(
  options: Pick<ExecuteOptions, "store" | "owner" | "runId">,
  projection: WorkflowProjection,
  operation: WorkflowProjectionOperation,
  revalidate?: () => void | Promise<void>,
): Promise<boolean> {
  const attempt = operation.attempts[operation.attempt];
  if (!attempt) return false;
  return appendAttemptEventIfActive(
    options,
    attempt.claim,
    "attempt_interrupted",
    {
      usage: durableAttemptUsage(undefined),
      usageProvenance: "lower_bound",
    },
    revalidate,
  );
}

async function settlePreparedOutcome(
  options: Pick<ExecuteOptions, "store" | "owner" | "runId">,
  projection: WorkflowProjection,
  operation: WorkflowProjectionOperation,
  revalidate?: () => void | Promise<void>,
): Promise<boolean> {
  const attempt = operation.attempts[operation.attempt];
  if (!attempt?.settlementEventId || attempt.status !== "settled") return false;
  const runEpoch = await currentEpoch(options, projection);
  await revalidate?.();
  const appended = await options.store.appendIfCurrent(
    options.runId,
    projection.lastEventOrdinal,
    "operation_settled",
    {
      taskId: operation.taskId,
      operationId: operation.operationId,
      attempt: attempt.attempt,
      claim: attempt.claim,
      attemptSettlementEventId: attempt.settlementEventId,
    },
    runEpoch,
  );
  return appended.status === "appended";
}

async function commitTerminalResult(
  options: Pick<ExecuteOptions, "store" | "owner" | "runId" | "onProjection">,
  repository: WorkflowProjectionRepository,
  terminal: WorkflowTerminalResult,
): Promise<WorkflowProjection> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const projection = await requiredProjection(repository, options.runId);
    if (projection.terminal) return projection;
    const epoch = await currentEpoch(options, projection);
    const appended = await options.store.appendIfCurrent(
      options.runId,
      projection.lastEventOrdinal,
      "run_result",
      { result: toDurableValue(terminal) },
      epoch,
    );
    if (appended.status === "conflict") continue;
    const committed = await requiredProjection(repository, options.runId);
    options.onProjection?.(committed);
    return committed;
  }
  const latest = await requiredProjection(repository, options.runId);
  if (latest.terminal) return latest;
  throw staleRevision(latest.revision);
}

async function readStoredPlan(
  store: WorkflowRunStore,
  runId: string,
): Promise<WorkflowPlan> {
  const record = await store.readRun(runId);
  const created = record.events.find((event) => event.type === "run_created");
  if (
    !created ||
    created.payload === null ||
    typeof created.payload !== "object" ||
    !("plan" in created.payload)
  ) {
    throw new Error(`Workflow run ${runId} has no creation plan`);
  }
  const plan = created.payload.plan;
  validateWorkflowPlan(plan);
  return durablePlan(plan);
}

function durablePlan(plan: unknown): WorkflowPlan {
  const durable = toDurableValue(plan) as unknown;
  validateWorkflowPlan(durable);
  return durable;
}

function assertStoredPlanMatches(
  projection: WorkflowProjection,
  stored: WorkflowPlan,
  requested: WorkflowPlan,
): void {
  if (projection.planRevision !== requested.schemaVersion) {
    throw new Error(
      `Workflow plan revision mismatch: stored ${projection.planRevision}, requested ${requested.schemaVersion}`,
    );
  }
  if (JSON.stringify(stored) !== JSON.stringify(requested)) {
    throw new Error("Workflow plan definition mismatch");
  }
}

function durableAttemptUsage(
  usage: SubagentResult["usage"] | WorkflowUsage | undefined,
) {
  const integer = (value: number | undefined): number =>
    Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value ?? 0) : 0;
  const costValue =
    usage && "cost" in usage ? usage.cost : (usage?.costUsd ?? 0);
  const cost =
    Number.isFinite(costValue) && costValue >= 0 ? String(costValue) : "0";
  return {
    input: integer(usage?.input),
    output: integer(usage?.output),
    cacheRead: integer(usage?.cacheRead),
    cacheWrite: integer(usage?.cacheWrite),
    turns: integer(usage?.turns),
    cost,
    ...(usage?.costSource ? { costSource: usage.costSource } : {}),
  };
}

function durableInterruptedUsage(error: unknown) {
  const usage =
    error instanceof WorkflowExecutionError ? error.usage : undefined;
  return durableAttemptUsage(usage);
}

function sameAttemptClaim(
  left: WorkflowTaskClaim,
  right: WorkflowTaskClaim,
): boolean {
  return (
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.operationId === right.operationId &&
    left.attempt === right.attempt &&
    left.runEpoch === right.runEpoch &&
    left.ownerId === right.ownerId &&
    left.ownerGeneration === right.ownerGeneration &&
    left.leaseEpoch === right.leaseEpoch &&
    left.token === right.token
  );
}

function boundedError(message: string | undefined): string {
  const value = message || "Task failed";
  return value.length <= 4096 ? value : value.slice(0, 4096);
}

function requestDigest(
  phaseId: string,
  task: WorkflowPlan["phases"][number]["tasks"][number],
): string {
  return createHash("sha256")
    .update(JSON.stringify(toDurableValue({ phaseId, task })))
    .digest("hex");
}

async function currentEpoch(
  options: Pick<ExecuteOptions, "store">,
  projection: WorkflowProjection,
): Promise<number> {
  const leaseEpoch = await options.store.getLeaseEpoch();
  return Math.max(projection.runEpoch, leaseEpoch);
}

function gateKey(owner: WorkflowOwnerIdentity, runId: string): string {
  return `${owner.projectKey}\u0000${owner.piSessionId}\u0000${runId}`;
}

async function withRunGate<T>(
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = runGates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  runGates.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (runGates.get(key) === tail) runGates.delete(key);
  }
}

async function requiredProjection(
  repository: WorkflowProjectionRepository,
  runId: string,
): Promise<WorkflowProjection> {
  const projection = await repository.get(runId);
  if (!projection) throw new Error(`Workflow run not found: ${runId}`);
  return projection;
}

function staleRevision(current: number): Error {
  return new Error(
    `Workflow journal changed concurrently at revision ${current}`,
  );
}
