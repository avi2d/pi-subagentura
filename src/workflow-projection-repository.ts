import {
  addWorkflowUsage,
  zeroWorkflowUsage,
  type WorkflowUsage,
} from "./workflow-core";
import {
  WorkflowRunCorruptionError,
  WorkflowRunStore,
} from "./workflow-run-store";
import type {
  WorkflowEventEnvelope,
  WorkflowOutcomeBlobRef,
  WorkflowOwnerIdentity,
  WorkflowRunLaunch,
  WorkflowRunStatus,
  WorkflowTerminalResult,
} from "./workflow-run-types";

export interface WorkflowTaskClaim {
  runId: string;
  taskId: string;
  operationId: string;
  attempt: number;
  runEpoch: number;
  ownerId: string;
  ownerGeneration: number;
  leaseEpoch: number;
  token: string;
}

export interface WorkflowProjectionAttempt {
  attempt: number;
  status: "running" | "interrupted" | "settled";
  claim: WorkflowTaskClaim;
  settlementEventId?: string;
  outcomeRef?: WorkflowOutcomeBlobRef;
  outcome?: "succeeded" | "failed";
  result?: unknown;
  error?: string;
  usage?: WorkflowAttemptUsage;
  usageProvenance?: "exact" | "lower_bound";
}

export interface WorkflowProjectionOperation {
  operationId: string;
  taskId: string;
  phaseId: string;
  requestDigest: string;
  status:
    "prepared" | "running" | "interrupted" | "attempt_settled" | "settled";
  attempt: number;
  attempts: Record<number, WorkflowProjectionAttempt>;
  settledAttempt?: number;
}

export interface WorkflowProjectionTask {
  id: string;
  status: "pending" | "running" | "interrupted" | "succeeded" | "failed";
  attempt: number;
  phaseId: string;
  prompt: string;
  label?: string;
  operationId?: string;
  result?: unknown;
  error?: string;
  claim?: WorkflowTaskClaim;
}

export interface WorkflowLiveProgress {
  runEpoch: number;
  ownerGeneration: number;
  leaseToken: string;
  leaseEpoch: number;
  status?: Extract<WorkflowRunStatus, "created" | "running" | "interrupted">;
  currentPhase?: string;
  tasks?: Readonly<
    Record<
      string,
      { status: "pending" | "running" | "interrupted"; attempt?: number }
    >
  >;
}

export interface WorkflowProjection {
  runId: string;
  planRevision: number;
  owner: WorkflowRunLaunch["owner"];
  status: WorkflowRunStatus;
  revision: number;
  resumeRevision: number;
  runEpoch: number;
  currentPhase?: string;
  tasks: Record<string, WorkflowProjectionTask>;
  operations: Record<string, WorkflowProjectionOperation>;
  terminal?: WorkflowTerminalResult;
  usage: WorkflowUsage;
  usageLowerBound?: boolean;
  cancellation?: { requestId: string };
  lastEventOrdinal: number;
}

export interface WorkflowProjectionRepository {
  get(runId: string): Promise<WorkflowProjection | undefined>;
  list(): Promise<readonly WorkflowProjection[]>;
}

export interface DurableWorkflowProjectionRepositoryOptions {
  /** Reserved for the controller between its own creation commit and executor start. */
  preserveCreated?: boolean;
  getLiveProgress?: (
    runId: string,
  ) =>
    | WorkflowLiveProgress
    | undefined
    | Promise<WorkflowLiveProgress | undefined>;
}

type Event = WorkflowEventEnvelope<string, unknown>;
type WorkflowAttemptUsage = NonNullable<Parameters<typeof addWorkflowUsage>[1]>;

/** Fold the authoritative journal. An unfinished cold prefix is interrupted. */
export function projectWorkflowRun(
  launch: WorkflowRunLaunch,
  events: readonly Event[],
): WorkflowProjection {
  const projection: WorkflowProjection = {
    runId: launch.runId,
    planRevision: launch.planRevision,
    owner: launch.owner,
    status: "created",
    revision: 0,
    resumeRevision: 0,
    runEpoch: 0,
    tasks: Object.create(null) as Record<string, WorkflowProjectionTask>,
    operations: Object.create(null) as Record<
      string,
      WorkflowProjectionOperation
    >,
    usage: zeroWorkflowUsage(),
    lastEventOrdinal: -1,
  };
  const appliedEventIds = new Set<string>();
  const accountedOperations = new Set<string>();

  for (const event of events) {
    projection.lastEventOrdinal = Math.max(
      projection.lastEventOrdinal,
      event.eventOrdinal,
    );
    if (appliedEventIds.has(event.eventId)) continue;
    appliedEventIds.add(event.eventId);
    if (event.runId !== launch.runId || event.runEpoch < projection.runEpoch) {
      continue;
    }
    if (event.runEpoch > projection.runEpoch) {
      projection.runEpoch = event.runEpoch;
    }
    projection.revision++;
    applyEvent(projection, event, accountedOperations);
  }

  if (!projection.terminal && !isTerminalStatus(projection.status)) {
    let unfinished = false;
    for (const operation of Object.values(projection.operations)) {
      if (operation.status === "settled") continue;
      unfinished = true;
      const task = projection.tasks[operation.taskId];
      const attempt = operation.attempts[operation.attempt];
      if (attempt?.status === "running") {
        attempt.status = "interrupted";
        attempt.usageProvenance = "lower_bound";
        projection.usageLowerBound = true;
      }
      if (task && task.status !== "succeeded" && task.status !== "failed") {
        task.status = "interrupted";
        delete task.claim;
      }
    }
    if (projection.status === "running" || unfinished) {
      projection.status = "interrupted";
    }
  }

  return projection;
}

/** Owner-scoped durable read authority with an optional same-epoch live overlay. */
export class DurableWorkflowProjectionRepository implements WorkflowProjectionRepository {
  public constructor(
    private readonly store: WorkflowRunStore,
    private readonly owner: WorkflowOwnerIdentity,
    private readonly options: DurableWorkflowProjectionRepositoryOptions = {},
  ) {}

  public async get(runId: string): Promise<WorkflowProjection | undefined> {
    try {
      const record = await this.store.readRun(runId);
      assertSameOwner(record.launch.owner, this.owner);
      const projection = projectWorkflowRun(record.launch, record.events);
      await hydrateOutcomeBlobs(this.store, projection);
      const leaseEpoch = await this.store.getLeaseEpoch();
      if (
        !projection.terminal &&
        projection.status === "created" &&
        !this.options.preserveCreated
      ) {
        projection.status = "interrupted";
      }
      const live = await this.options.getLiveProgress?.(runId);
      return live?.runEpoch === projection.runEpoch &&
        live.ownerGeneration === this.owner.ownerGeneration &&
        live.leaseToken === this.owner.leaseToken &&
        live.leaseEpoch === leaseEpoch &&
        projection.runEpoch === leaseEpoch
        ? overlayLiveProgress(projection, live)
        : projection;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async list(): Promise<readonly WorkflowProjection[]> {
    const projections: WorkflowProjection[] = [];
    for (const runId of await this.store.listRunIds()) {
      const projection = await this.get(runId);
      if (projection) projections.push(projection);
    }
    return projections;
  }
}

async function hydrateOutcomeBlobs(
  store: WorkflowRunStore,
  projection: WorkflowProjection,
): Promise<void> {
  for (const operation of Object.values(projection.operations)) {
    for (const attempt of Object.values(operation.attempts)) {
      if (!attempt.outcomeRef) continue;
      const value = await store.readOutcomeBlob(
        projection.runId,
        attempt.outcomeRef,
      );
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new WorkflowRunCorruptionError(
          projection.runId,
          new Error("Workflow outcome blob is not an object"),
        );
      }
      if (value.status === "succeeded" && "result" in value) {
        attempt.outcome = "succeeded";
        attempt.result = value.result;
      } else if (
        value.status === "failed" &&
        "error" in value &&
        typeof value.error === "string"
      ) {
        attempt.outcome = "failed";
        attempt.error = value.error;
      } else {
        throw new WorkflowRunCorruptionError(
          projection.runId,
          new Error("Workflow outcome blob has an invalid settlement"),
        );
      }
    }

    if (
      operation.status !== "settled" ||
      operation.settledAttempt === undefined
    ) {
      continue;
    }
    const settled = operation.attempts[operation.settledAttempt];
    const task = projection.tasks[operation.taskId];
    if (!settled?.outcome || !task) {
      throw new WorkflowRunCorruptionError(
        projection.runId,
        new Error("Workflow operation references an unresolved outcome"),
      );
    }
    if (settled.outcome === "succeeded") {
      task.status = "succeeded";
      task.result = settled.result;
      delete task.error;
    } else {
      task.status = "failed";
      task.error = settled.error ?? "Task failed";
      delete task.result;
    }
  }
}

function applyEvent(
  projection: WorkflowProjection,
  event: Event,
  accountedOperations: Set<string>,
): void {
  const payload = recordPayload(event.payload);
  if (projection.terminal && !isTerminalFollowup(event.type)) return;

  switch (event.type) {
    case "run_created": {
      const plan = recordPayload(payload.plan);
      const phases = Array.isArray(plan.phases) ? plan.phases : [];
      for (const phaseValue of phases) {
        const phase = recordPayload(phaseValue);
        const phaseId = stringValue(phase.id);
        const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
        for (const taskValue of tasks) {
          const task = recordPayload(taskValue);
          const id = stringValue(task.id);
          const prompt = stringValue(task.prompt);
          if (!id || projection.tasks[id]) continue;
          projection.tasks[id] = {
            id,
            status: "pending",
            attempt: 0,
            phaseId,
            prompt,
            ...(typeof task.label === "string" ? { label: task.label } : {}),
          };
        }
      }
      projection.status = "created";
      break;
    }
    case "run_started":
      projection.status = "running";
      break;
    case "run_resume_requested": {
      const resumeRevision = integerValue(payload.resumeRevision);
      if (resumeRevision !== projection.resumeRevision + 1) break;
      projection.resumeRevision = resumeRevision;
      projection.status = "running";
      for (const operation of Object.values(projection.operations)) {
        if (
          operation.status !== "running" &&
          operation.status !== "interrupted"
        ) {
          continue;
        }
        const attempt = operation.attempts[operation.attempt];
        if (attempt?.status === "running") {
          attempt.status = "interrupted";
          attempt.usageProvenance = "lower_bound";
          projection.usageLowerBound = true;
        }
        operation.status = "prepared";
        const task = projection.tasks[operation.taskId];
        if (task && task.status !== "succeeded" && task.status !== "failed") {
          task.status = "pending";
          delete task.claim;
        }
      }
      break;
    }
    case "operation_prepared": {
      const taskId = stringValue(payload.taskId);
      const operationId = stringValue(payload.operationId);
      const phaseId = stringValue(payload.phaseId);
      const requestDigest = stringValue(payload.requestDigest);
      const task = projection.tasks[taskId];
      if (!task || !operationId || projection.operations[operationId]) break;
      projection.operations[operationId] = {
        operationId,
        taskId,
        phaseId,
        requestDigest,
        status: "prepared",
        attempt: 0,
        attempts: Object.create(null) as Record<
          number,
          WorkflowProjectionAttempt
        >,
      };
      task.operationId = operationId;
      projection.currentPhase = phaseId;
      projection.status = "running";
      break;
    }
    case "attempt_started": {
      const taskId = stringValue(payload.taskId);
      const operationId = stringValue(payload.operationId);
      const attemptNumber = integerValue(payload.attempt);
      const operation = projection.operations[operationId];
      const task = projection.tasks[taskId];
      const claim = parseClaim(
        payload.claim,
        projection.runId,
        taskId,
        operationId,
        attemptNumber,
        event.runEpoch,
      );
      if (
        !operation ||
        operation.taskId !== taskId ||
        !task ||
        operation.status === "settled" ||
        !claim ||
        attemptNumber <= operation.attempt
      ) {
        break;
      }
      operation.attempt = attemptNumber;
      operation.status = "running";
      operation.attempts[attemptNumber] = {
        attempt: attemptNumber,
        status: "running",
        claim,
      };
      task.status = "running";
      task.attempt = attemptNumber;
      task.claim = claim;
      projection.currentPhase = operation.phaseId;
      projection.status = "running";
      break;
    }
    case "attempt_interrupted": {
      const operationId = stringValue(payload.operationId);
      const attemptNumber = integerValue(payload.attempt);
      const operation = projection.operations[operationId];
      const attempt = operation?.attempts[attemptNumber];
      const task = operation ? projection.tasks[operation.taskId] : undefined;
      if (
        !operation ||
        operation.status !== "running" ||
        !attempt ||
        attempt.status !== "running" ||
        !task ||
        !sameClaim(attempt.claim, payload.claim)
      ) {
        break;
      }
      const usage = parseUsage(payload.usage);
      attempt.status = "interrupted";
      attempt.usage = usage;
      attempt.usageProvenance = "lower_bound";
      operation.status = "interrupted";
      if (task.status !== "succeeded" && task.status !== "failed") {
        task.status = "interrupted";
        delete task.claim;
      }
      projection.usage = addWorkflowUsage(projection.usage, usage);
      projection.usageLowerBound = true;
      break;
    }
    case "attempt_settled": {
      const operationId = stringValue(payload.operationId);
      const attemptNumber = integerValue(payload.attempt);
      const operation = projection.operations[operationId];
      const attempt = operation?.attempts[attemptNumber];
      if (
        !operation ||
        operation.status === "settled" ||
        !attempt ||
        attempt.status !== "running" ||
        !sameClaim(attempt.claim, payload.claim)
      ) {
        break;
      }
      const outcomeRef = parseOutcomeRef(payload.outcomeRef);
      if (!outcomeRef) {
        throw new WorkflowRunCorruptionError(
          projection.runId,
          new Error(
            "Workflow attempt settlement has an invalid outcome reference",
          ),
        );
      }
      const usage = parseUsage(payload.usage);
      attempt.status = "settled";
      attempt.settlementEventId = event.eventId;
      attempt.outcomeRef = outcomeRef;
      attempt.usage = usage;
      attempt.usageProvenance = "exact";
      operation.status = "attempt_settled";
      break;
    }
    case "operation_settled": {
      const operationId = stringValue(payload.operationId);
      const attemptNumber = integerValue(payload.attempt);
      const operation = projection.operations[operationId];
      const attempt = operation?.attempts[attemptNumber];
      const task = operation ? projection.tasks[operation.taskId] : undefined;
      if (
        !operation ||
        operation.status === "settled" ||
        !attempt ||
        attempt.status !== "settled" ||
        !task ||
        !sameClaim(attempt.claim, payload.claim) ||
        stringValue(payload.attemptSettlementEventId) !==
          attempt.settlementEventId
      ) {
        break;
      }
      operation.status = "settled";
      operation.settledAttempt = attemptNumber;
      delete task.claim;
      if (!accountedOperations.has(operationId)) {
        accountedOperations.add(operationId);
        projection.usage = addWorkflowUsage(projection.usage, attempt.usage);
      }
      // The repository applies the validated immutable outcome after the pure
      // event fold. The journal never trusts unreferenced output bytes.
      break;
    }
    case "run_cancel_requested": {
      const requestId = stringValue(payload.requestId);
      if (requestId && !projection.cancellation) {
        projection.cancellation = { requestId };
      }
      break;
    }
    case "run_cancelled":
      if (!projection.terminal) {
        for (const operation of Object.values(projection.operations)) {
          const attempt = operation.attempts[operation.attempt];
          const task = projection.tasks[operation.taskId];
          if (
            operation.status === "attempt_settled" &&
            attempt?.status === "settled"
          ) {
            operation.status = "settled";
            operation.settledAttempt = attempt.attempt;
            if (task) delete task.claim;
            if (!accountedOperations.has(operation.operationId)) {
              accountedOperations.add(operation.operationId);
              projection.usage = addWorkflowUsage(
                projection.usage,
                attempt.usage,
              );
            }
            continue;
          }
          if (operation.status !== "running") continue;
          if (attempt?.status === "running") {
            attempt.status = "interrupted";
            attempt.usageProvenance = "lower_bound";
            projection.usageLowerBound = true;
          }
          operation.status = "interrupted";
          if (task && task.status === "running") {
            task.status = "interrupted";
            delete task.claim;
          }
        }
        for (const task of Object.values(projection.tasks)) {
          if (task.status !== "running") continue;
          const operation = task.operationId
            ? projection.operations[task.operationId]
            : undefined;
          if (operation?.status === "settled") continue;
          task.status = "interrupted";
          delete task.claim;
          projection.usageLowerBound = true;
        }
        projection.status = "cancelled";
        projection.terminal = { status: "cancelled" };
      }
      break;
    case "run_result":
    case "run_terminal": {
      if (projection.terminal) break;
      const candidate = recordPayload(payload.result ?? payload);
      if (!isTerminalResult(candidate)) break;
      projection.terminal = candidate;
      projection.status = candidate.status;
      break;
    }
  }
}

function overlayLiveProgress(
  projection: WorkflowProjection,
  live: WorkflowLiveProgress,
): WorkflowProjection {
  if (projection.terminal) return projection;
  const tasks = { ...projection.tasks };
  for (const [taskId, progress] of Object.entries(live.tasks ?? {})) {
    const task = tasks[taskId];
    if (!task || task.status === "succeeded" || task.status === "failed")
      continue;
    tasks[taskId] = {
      ...task,
      status: progress.status,
      ...(progress.attempt === undefined ? {} : { attempt: progress.attempt }),
    };
  }
  return {
    ...projection,
    tasks,
    ...(live.status === undefined ? {} : { status: live.status }),
    ...(live.currentPhase === undefined
      ? {}
      : { currentPhase: live.currentPhase }),
  };
}

function parseOutcomeRef(value: unknown): WorkflowOutcomeBlobRef | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("digest" in value) ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.digest) ||
    !("bytes" in value) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) <= 0
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    digest: value.digest,
    bytes: value.bytes as number,
  };
}

function parseClaim(
  value: unknown,
  runId: string,
  taskId: string,
  operationId: string,
  attempt: number,
  runEpoch: number,
): WorkflowTaskClaim | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.runId !== runId ||
    candidate.taskId !== taskId ||
    candidate.operationId !== operationId ||
    candidate.attempt !== attempt ||
    candidate.runEpoch !== runEpoch ||
    typeof candidate.ownerId !== "string" ||
    !Number.isSafeInteger(candidate.ownerGeneration) ||
    (candidate.ownerGeneration as number) < 0 ||
    !Number.isSafeInteger(candidate.leaseEpoch) ||
    (candidate.leaseEpoch as number) < 0 ||
    typeof candidate.token !== "string" ||
    candidate.token.length === 0
  ) {
    return undefined;
  }
  return candidate as unknown as WorkflowTaskClaim;
}

function sameClaim(left: WorkflowTaskClaim, right: unknown): boolean {
  if (right === null || typeof right !== "object" || Array.isArray(right)) {
    return false;
  }
  const candidate = right as Record<string, unknown>;
  return (
    left.runId === candidate.runId &&
    left.taskId === candidate.taskId &&
    left.operationId === candidate.operationId &&
    left.attempt === candidate.attempt &&
    left.runEpoch === candidate.runEpoch &&
    left.ownerId === candidate.ownerId &&
    left.ownerGeneration === candidate.ownerGeneration &&
    left.leaseEpoch === candidate.leaseEpoch &&
    left.token === candidate.token
  );
}

function parseUsage(value: unknown): WorkflowAttemptUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    };
  }
  const usage = value as Record<string, unknown>;
  return {
    input: finite(usage.input),
    output: finite(usage.output),
    cacheRead: finite(usage.cacheRead),
    cacheWrite: finite(usage.cacheWrite),
    cost: decimalCost(usage.cost),
    turns: finite(usage.turns),
    ...(usage.costSource === "provider" ||
    usage.costSource === "estimated" ||
    usage.costSource === "unavailable" ||
    usage.costSource === "mixed"
      ? { costSource: usage.costSource }
      : {}),
  };
}

function assertSameOwner(
  left: WorkflowOwnerIdentity,
  right: WorkflowOwnerIdentity,
): void {
  if (
    left.projectKey !== right.projectKey ||
    left.piSessionId !== right.piSessionId
  ) {
    throw new Error("Workflow run belongs to a different durable namespace");
  }
}

function isTerminalResult(value: unknown): value is WorkflowTerminalResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "done" ||
    candidate.status === "error" ||
    candidate.status === "cancelled"
  );
}

function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isTerminalFollowup(type: string): boolean {
  return (
    type === "run_result" || type === "run_terminal" || type === "run_cancelled"
  );
}

function recordPayload(value: unknown): Record<string, unknown> {
  // Journal payloads have already crossed the store's canonical-value boundary.
  return (value ?? {}) as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerValue(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : -1;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function decimalCost(value: unknown): number {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    value.trim() !== value
  ) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
