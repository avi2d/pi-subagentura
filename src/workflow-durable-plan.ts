import { randomUUID } from "node:crypto";
import type { SubagentResult } from "./helpers";
import type { WorkflowAgentRunner, WorkflowProgress } from "./workflow-core";
import {
  decodeDurableValue,
  encodeDurableValue,
  type DurableValue,
} from "./workflow-durable-value";
import {
  durableWorkflowOperationBlobCodec,
  WorkflowRunBlobResolver,
  WorkflowRunOperationJournal,
} from "./workflow-operation-journal";
import {
  WorkflowOperationGate,
  WorkflowOperationInterruptedError,
  type WorkflowOperationJournal,
} from "./workflow-operation-gate";
import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
} from "./workflow-plan";
import {
  runWorkflowPlan,
  type WorkflowPlanRunResult,
  type WorkflowPlanTaskDispatch,
} from "./workflow-plan-runner";
import type { WorkflowPlanEvent } from "./workflow-plan-state";
import {
  WorkflowProjectionFoldError,
  foldWorkflowRunEvents,
  InMemoryWorkflowProjectionRepository,
  type DurableWorkflowProjection,
  type WorkflowProjectionRepository,
} from "./workflow-projection-repository";
import {
  WorkflowRecoveryService,
  type WorkflowOwnerRecovery,
  type WorkflowRecoveryReason,
} from "./workflow-recovery";
import {
  WorkflowRunStore,
  WorkflowRunStoreError,
  type WorkflowLeaseAcquisition,
  type WorkflowRunJournal,
  type WorkflowRunLease,
} from "./workflow-run-store";
import {
  ROOT_WORKFLOW_DEFINITION_PATH,
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowDispatchOrdinal,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  durableWorkflowOwnerEquals,
  isDurableWorkflowRunId,
  isWorkflowIdentifier,
  type DurableWorkflowOwner,
  type DurableWorkflowResumePolicy,
  type DurableWorkflowRunId,
  type WorkflowDefinitionDigest,
  type WorkflowEventReceipt,
  type WorkflowOperationRequest,
  type WorkflowPlanTaskStatus,
  type WorkflowRunEpochFence,
  type WorkflowRunEvent,
  type WorkflowRunInterruptedEvent,
} from "./workflow-run-types";

export interface DurableWorkflowPlanControllerOptions extends WorkflowLeaseAcquisition {
  readonly store: WorkflowRunStore;
  readonly owner: DurableWorkflowOwner;
  readonly repository?: WorkflowProjectionRepository;
  readonly runAgentForRun: (runId: DurableWorkflowRunId) => WorkflowAgentRunner;
  readonly generateId?: () => string;
}

export interface DurableWorkflowPlanExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkflowProgress) => void;
}

export interface DurableWorkflowPlanStartOptions extends DurableWorkflowPlanExecutionOptions {
  readonly plan: WorkflowPlanDefinition;
  readonly runId?: DurableWorkflowRunId;
  readonly resumePolicy?: DurableWorkflowResumePolicy;
}

export interface DurableWorkflowPlanResumeOptions extends DurableWorkflowPlanExecutionOptions {
  readonly trustedActorId: string;
  readonly expectedOwner?: DurableWorkflowOwner;
  readonly expectedRunEpoch?: number;
}

export interface DurableWorkflowPlanExecution {
  readonly runId: DurableWorkflowRunId;
  readonly completion: Promise<WorkflowPlanRunResult>;
}

export interface DurableWorkflowPlanOpenResult {
  readonly recovery: WorkflowOwnerRecovery;
  readonly completions: readonly DurableWorkflowPlanExecution[];
}

export type DurableWorkflowPlanInterruptionReason =
  WorkflowRunInterruptedEvent["payload"]["reason"];

export class DurableWorkflowPlanControllerError extends Error {
  readonly code:
    | "closed"
    | "invalid_plan"
    | "wrong_owner"
    | "epoch_mismatch"
    | "run_active"
    | "run_not_found"
    | "terminal_run"
    | "resume_forbidden"
    | "trusted_resume_required"
    | "interrupted";

  constructor(
    code: DurableWorkflowPlanControllerError["code"],
    message: string,
  ) {
    super(message);
    this.name = "DurableWorkflowPlanControllerError";
    this.code = code;
  }
}

interface ActiveExecution {
  readonly runId: DurableWorkflowRunId;
  readonly journal: WorkflowRunJournal;
  readonly plan: WorkflowPlanDefinition;
  readonly definitionDigest: WorkflowDefinitionDigest;
  readonly dispatchOrdinals: ReadonlyMap<string, number>;
  readonly abort: AbortController;
  readonly externalSignal?: AbortSignal;
  readonly onProgress?: (progress: WorkflowProgress) => void;
  interruptionReason?: DurableWorkflowPlanInterruptionReason;
  completion?: Promise<WorkflowPlanRunResult>;
}

interface DurablePlanLaunch {
  readonly executionKind: "plan";
  readonly plan: WorkflowPlanDefinition;
  readonly resumePolicy: DurableWorkflowResumePolicy;
}

const ROOT_DEFINITION_PATH = createWorkflowDefinitionPath(
  ROOT_WORKFLOW_DEFINITION_PATH,
);
const RESUME_POLICIES: readonly DurableWorkflowResumePolicy[] = [
  "automatic_on_reload_or_resume",
  "trusted_resume",
  "never",
];

export function createDurableWorkflowPlanRunId(): DurableWorkflowRunId {
  return createDurableWorkflowRunId(`plan-${randomUUID()}`);
}

export class DurableWorkflowPlanController {
  readonly owner: DurableWorkflowOwner;
  readonly repository: WorkflowProjectionRepository;

  readonly #store: WorkflowRunStore;
  readonly #lease: WorkflowRunLease;
  readonly #runAgentForRun: (
    runId: DurableWorkflowRunId,
  ) => WorkflowAgentRunner;
  readonly #generateId: () => string;
  readonly #recovery: WorkflowRecoveryService;
  readonly #active = new Map<DurableWorkflowRunId, ActiveExecution>();
  #closed = false;

  private constructor(
    options: DurableWorkflowPlanControllerOptions,
    lease: WorkflowRunLease,
  ) {
    this.#store = options.store;
    this.#lease = lease;
    this.owner = options.owner;
    this.repository =
      options.repository ?? new InMemoryWorkflowProjectionRepository();
    this.#runAgentForRun = options.runAgentForRun;
    this.#generateId = options.generateId ?? randomUUID;
    this.#recovery = new WorkflowRecoveryService(
      this.#store,
      this.repository,
      new WorkflowRunBlobResolver(this.#store),
    );
  }

  static async acquire(
    options: DurableWorkflowPlanControllerOptions,
  ): Promise<DurableWorkflowPlanController> {
    const lease = await options.store.acquireLease(options.owner, {
      scopeId: options.scopeId,
      generation: options.generation,
    });
    return new DurableWorkflowPlanController(options, lease);
  }

  async open(
    reason: WorkflowRecoveryReason = "startup",
  ): Promise<DurableWorkflowPlanOpenResult> {
    this.#assertOpen();
    const recovery = await this.#recovery.recoverOwner(this.owner, reason);
    if (reason === "startup") {
      return Object.freeze({ recovery, completions: Object.freeze([]) });
    }

    const completions: DurableWorkflowPlanExecution[] = [];
    for (const recovered of recovery.runs) {
      if (
        !recovered.automaticResumeEligible ||
        recovered.projection === undefined
      ) {
        continue;
      }
      completions.push(
        await this.#resumePlan(recovered.projection, {
          reason,
        }),
      );
    }
    return Object.freeze({
      recovery,
      completions: Object.freeze(completions),
    });
  }

  async startPlan(
    options: DurableWorkflowPlanStartOptions,
  ): Promise<DurableWorkflowPlanExecution> {
    this.#assertOpen();
    const plan = canonicalSequentialPlan(options.plan);
    const canonicalDefinition = encodeDurableValue(plan);
    const runId = options.runId ?? createDurableWorkflowPlanRunId();
    if (!isDurableWorkflowRunId(runId)) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow run ID is invalid.",
      );
    }
    if (this.#active.has(runId)) {
      throw new DurableWorkflowPlanControllerError(
        "run_active",
        `Durable workflow run ${runId} already has an executor.`,
      );
    }
    const resumePolicy = options.resumePolicy ?? "trusted_resume";
    if (!RESUME_POLICIES.includes(resumePolicy)) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow resume policy is invalid.",
      );
    }

    const launch: DurablePlanLaunch = {
      executionKind: "plan",
      plan,
      resumePolicy,
    };
    const journal = await this.#lease.createRun({ runId, launch });
    const fence = requiredFence(journal);
    const definition = await journal.writeDefinition(canonicalDefinition.json);
    const definitionDigest = createWorkflowDefinitionDigest(
      canonicalDefinition.sha256,
    );
    if (
      definition.sha256 !== definitionDigest ||
      definition.sizeBytes !== Buffer.byteLength(canonicalDefinition.json)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Immutable workflow plan definition does not match its canonical digest.",
      );
    }

    await this.#appendEvent(
      journal,
      "run_created",
      {
        durableOwner: this.owner,
        executionKind: "plan",
        rootDefinitionPath: ROOT_DEFINITION_PATH,
        rootDefinitionDigest: definitionDigest,
        resumePolicy,
      },
      false,
    );
    await this.#appendEvent(journal, "run_epoch_acquired", {
      fence,
      previousRunEpoch: null,
      reason: "created",
    });
    await this.#appendEvent(journal, "definition_captured", {
      captureKind: "root",
      definitionPath: ROOT_DEFINITION_PATH,
      definitionDigest,
      definition,
    });
    await this.#appendEvent(journal, "plan_defined", {
      revision: 1,
      definitionDigest,
      definition,
    });

    const execution = this.#newExecution(
      journal,
      plan,
      definitionDigest,
      options,
    );
    return this.#startExecution(execution);
  }

  async createPlan(
    options: DurableWorkflowPlanStartOptions,
  ): Promise<WorkflowPlanRunResult> {
    return (await this.startPlan(options)).completion;
  }

  async trustedResume(
    runId: DurableWorkflowRunId,
    options: DurableWorkflowPlanResumeOptions,
  ): Promise<DurableWorkflowPlanExecution> {
    this.#assertOpen();
    if (!isWorkflowIdentifier(options.trustedActorId)) {
      throw new DurableWorkflowPlanControllerError(
        "trusted_resume_required",
        "Trusted resume requires a valid actor ID.",
      );
    }
    this.#assertExpectedOwner(options.expectedOwner);
    const projection = await this.repository.get(this.owner, runId);
    if (projection === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "run_not_found",
        `Durable workflow run ${runId} is not recovered.`,
      );
    }
    this.#assertExpectedEpoch(projection, options.expectedRunEpoch);
    if (projection.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${runId} is already terminal.`,
      );
    }
    if (projection.status !== "interrupted") {
      throw new DurableWorkflowPlanControllerError(
        "trusted_resume_required",
        `Durable workflow run ${runId} is not awaiting trusted resume.`,
      );
    }
    if (projection.resumePolicy === "never") {
      throw new DurableWorkflowPlanControllerError(
        "resume_forbidden",
        `Durable workflow run ${runId} cannot be resumed by policy.`,
      );
    }
    return this.#resumePlan(projection, {
      reason: "trusted_resume",
      trustedActorId: options.trustedActorId,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }

  getProjection(
    runId: DurableWorkflowRunId,
  ): Promise<DurableWorkflowProjection | undefined> {
    this.#assertOpen();
    return this.repository.get(this.owner, runId);
  }

  async getResult(
    runId: DurableWorkflowRunId,
  ): Promise<DurableValue | undefined> {
    this.#assertOpen();
    const journal = await this.#store.openRun(this.owner, runId);
    const binding = await journal.readResult();
    return binding === undefined
      ? undefined
      : journal.readOutput(binding.result);
  }

  async interrupt(
    reason: DurableWorkflowPlanInterruptionReason,
    runId?: DurableWorkflowRunId,
  ): Promise<void> {
    const executions =
      runId === undefined
        ? [...this.#active.values()]
        : [this.#active.get(runId)].filter(
            (execution): execution is ActiveExecution =>
              execution !== undefined,
          );
    for (const execution of executions) {
      execution.interruptionReason = reason;
      if (!execution.abort.signal.aborted) execution.abort.abort(reason);
    }
    await Promise.allSettled(
      executions.map((execution) => execution.completion),
    );
  }

  async release(): Promise<void> {
    this.#assertOpen();
    await this.interrupt("quit");
    await this.#lease.release();
    this.#closed = true;
  }

  async #resumePlan(
    recovered: DurableWorkflowProjection,
    options: DurableWorkflowPlanExecutionOptions & {
      readonly reason: WorkflowRecoveryReason | "trusted_resume";
      readonly trustedActorId?: string;
    },
  ): Promise<DurableWorkflowPlanExecution> {
    if (this.#active.has(recovered.runId)) {
      throw new DurableWorkflowPlanControllerError(
        "run_active",
        `Durable workflow run ${recovered.runId} already has an executor.`,
      );
    }
    if (recovered.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${recovered.runId} is already terminal.`,
      );
    }
    const acquisitionReason =
      options.reason === "trusted_resume" ? "resume" : options.reason;
    const journal = await this.#lease.acquireRun(
      recovered.runId,
      acquisitionReason,
    );
    let projection = await this.#refresh(journal);
    if (projection.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${recovered.runId} became terminal.`,
      );
    }
    if (projection.status !== "interrupted") {
      await this.#appendEvent(journal, "run_interrupted", {
        reason: options.reason === "reload" ? "reload" : "process_crash",
      });
      projection = await this.#refresh(journal);
    }
    for (const operation of projection.operations) {
      const activeAttempt = operation.attempts.at(-1);
      if (activeAttempt?.status !== "started") continue;
      await this.#appendEvent(journal, "attempt_interrupted", {
        attempt: activeAttempt.attempt,
        reason: "recovery",
      });
    }
    const plan = await this.#readLaunchPlan(journal);
    if (encodeDurableValue(plan).sha256 !== projection.rootDefinitionDigest) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Persisted workflow launch does not match its immutable definition.",
      );
    }
    const resumeReason =
      options.reason === "trusted_resume"
        ? "trusted_resume"
        : options.reason === "reload"
          ? "reload"
          : "resume";
    await this.#appendEvent(journal, "run_resumed", {
      reason: resumeReason,
      ...(options.trustedActorId === undefined
        ? {}
        : { trustedActorId: options.trustedActorId }),
    });
    projection = await this.#refresh(journal);
    const execution = this.#newExecution(
      journal,
      plan,
      projection.rootDefinitionDigest,
      options,
    );
    return this.#startExecution(execution);
  }

  #newExecution(
    journal: WorkflowRunJournal,
    plan: WorkflowPlanDefinition,
    definitionDigest: WorkflowDefinitionDigest,
    options: DurableWorkflowPlanExecutionOptions,
  ): ActiveExecution {
    const abort = new AbortController();
    if (options.signal?.aborted) abort.abort(options.signal.reason);
    return {
      runId: journal.runId,
      journal,
      plan,
      definitionDigest,
      dispatchOrdinals: new Map(
        plan.phases
          .flatMap((phase) => phase.tasks)
          .map((task, index) => [task.id, index + 1]),
      ),
      abort,
      externalSignal: options.signal,
      onProgress: options.onProgress,
      ...(options.signal?.aborted
        ? { interruptionReason: "owner_replaced" }
        : {}),
    };
  }

  #startExecution(execution: ActiveExecution): DurableWorkflowPlanExecution {
    this.#active.set(execution.runId, execution);
    const onAbort = () => {
      execution.interruptionReason = "owner_replaced";
      if (!execution.abort.signal.aborted) {
        execution.abort.abort(execution.externalSignal?.reason);
      }
    };
    if (execution.externalSignal?.aborted) {
      onAbort();
    } else {
      execution.externalSignal?.addEventListener("abort", onAbort, {
        once: true,
      });
    }
    const completion = this.#execute(execution).finally(() => {
      execution.externalSignal?.removeEventListener("abort", onAbort);
      if (this.#active.get(execution.runId) === execution) {
        this.#active.delete(execution.runId);
      }
    });
    execution.completion = completion;
    return Object.freeze({ runId: execution.runId, completion });
  }

  async #execute(execution: ActiveExecution): Promise<WorkflowPlanRunResult> {
    const fence = requiredFence(execution.journal);
    let currentDispatch: (() => Promise<SubagentResult>) | undefined;
    const durableJournal = new WorkflowRunOperationJournal(
      execution.journal,
      this.#generateId,
    );
    const operationJournal: WorkflowOperationJournal = {
      revalidateFence: (nextFence) => durableJournal.revalidateFence(nextFence),
      readOperation: (nextFence, operation) =>
        durableJournal.readOperation(nextFence, operation),
      allocateAttempt: (nextFence, request) =>
        durableJournal.allocateAttempt(nextFence, request),
      allocateResponseOrdinal: (nextFence, request) =>
        durableJournal.allocateResponseOrdinal(nextFence, request),
      createEvent: (nextFence, draft) =>
        durableJournal.createEvent(nextFence, draft),
      append: async (nextFence, event) => {
        const receipt = await durableJournal.append(nextFence, event);
        await this.#refresh(execution.journal);
        return receipt;
      },
      putOutcomeBlob: (nextFence, value) =>
        durableJournal.putOutcomeBlob(nextFence, value),
      readOutcomeBlob: (nextFence, reference) =>
        durableJournal.readOutcomeBlob(nextFence, reference),
    };
    const gate = new WorkflowOperationGate({
      journal: operationJournal,
      blobCodec: durableWorkflowOperationBlobCodec,
      dispatcher: {
        run: async () => {
          if (currentDispatch === undefined) {
            throw new DurableWorkflowPlanControllerError(
              "run_active",
              "Durable operation dispatched outside its plan task authority.",
            );
          }
          try {
            const result = await currentDispatch();
            if (execution.interruptionReason !== undefined) {
              throw operationInterruption(execution.interruptionReason);
            }
            return result;
          } catch (error) {
            if (
              execution.interruptionReason !== undefined &&
              !(error instanceof WorkflowOperationInterruptedError)
            ) {
              throw operationInterruption(execution.interruptionReason);
            }
            throw error;
          }
        },
      },
    });
    const runAgent = this.#runAgentForRun(execution.runId);
    let result: WorkflowPlanRunResult;
    try {
      result = await runWorkflowPlan(execution.plan, {
        runAgent,
        concurrency: 1,
        signal: execution.abort.signal,
        appendEvent: (event) => this.#appendPlanEvent(execution, event),
        onProgress: execution.onProgress,
        dispatchTask: async (input) => {
          if (execution.interruptionReason !== undefined) {
            throw operationInterruption(execution.interruptionReason);
          }
          const request = this.#operationRequest(execution, input);
          currentDispatch = input.dispatch;
          try {
            const outcome = await gate.execute(fence, request, input.request);
            await this.#refresh(execution.journal);
            return requiredPlanResult(outcome);
          } catch (error) {
            try {
              const projection = await this.#refresh(execution.journal);
              const operation = projection.operations.find(
                (candidate) =>
                  candidate.identity.operationId === input.task.definition.id,
              );
              if (
                operation?.settlement === undefined &&
                execution.interruptionReason === undefined
              ) {
                execution.interruptionReason = "owner_replaced";
              }
            } catch (refreshError) {
              if (
                error instanceof WorkflowRunStoreError ||
                refreshError instanceof WorkflowRunStoreError ||
                refreshError instanceof WorkflowProjectionFoldError
              ) {
                execution.interruptionReason = "owner_replaced";
              }
            }
            throw error;
          } finally {
            currentDispatch = undefined;
          }
        },
      });
    } catch (error) {
      if (execution.interruptionReason !== undefined) {
        await this.#finishInterruption(execution);
      }
      throw error;
    }

    if (execution.interruptionReason !== undefined) {
      await this.#finishInterruption(execution);
    }
    await this.#reconcileTaskStatuses(execution, result);
    const projection = await this.#refresh(execution.journal);
    const resultReference = await execution.journal.writeOutput(result);
    const resultEvent = await this.#appendEvent(
      execution.journal,
      "run_result_recorded",
      {
        result: resultReference,
        accounting: projection.accounting,
      },
    );
    const terminal = await this.#appendEvent(
      execution.journal,
      "run_terminal",
      {
        status: result.status === "done" ? "done" : "error",
        accounting: projection.accounting,
        resultEventId: resultEvent.eventId,
      },
    );
    await execution.journal.writeResult({
      terminalEventId: terminal.eventId,
      baseEventByteEndExclusive: terminal.receipt.byteEndExclusive,
      result: resultReference,
    });
    await this.#refresh(execution.journal);
    return result;
  }

  #operationRequest(
    execution: ActiveExecution,
    input: WorkflowPlanTaskDispatch,
  ): WorkflowOperationRequest {
    const ordinal = execution.dispatchOrdinals.get(input.task.definition.id);
    if (ordinal === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        `Task ${input.task.definition.id} has no stable dispatch ordinal.`,
      );
    }
    const requestSettings = encodeDurableValue({
      prompt: input.request.prompt,
      persona: input.request.persona ?? null,
      model: input.request.model ?? null,
      isolation: input.request.isolation ?? "in-process",
      schema: input.request.schema ?? null,
      thinkingLevel: input.request.thinkingLevel ?? null,
    });
    return {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      identity: createWorkflowOperationIdentity(
        execution.runId,
        ROOT_DEFINITION_PATH,
        input.task.definition.id,
      ),
      requestDigest: createWorkflowRequestDigest(requestSettings.sha256),
      definitionDigest: execution.definitionDigest,
      dispatchOrdinal: createWorkflowDispatchOrdinal(ordinal),
    };
  }

  async #appendPlanEvent(
    execution: ActiveExecution,
    event: WorkflowPlanEvent,
  ): Promise<void> {
    if (
      execution.interruptionReason !== undefined ||
      event.type === "run_cancelled"
    ) {
      return;
    }
    const projection = await this.#refresh(execution.journal);
    const taskId = event.taskId;
    const current = projection.taskStates[taskId]?.status ?? "pending";
    const target = planEventTarget(event);
    if (
      target === undefined ||
      current === target ||
      isTerminalTaskStatus(current)
    ) {
      return;
    }
    if (
      target === "failed" &&
      projection.operations.some(
        (operation) =>
          operation.identity.operationId === taskId &&
          operation.settlement === undefined &&
          operation.attempts.at(-1)?.status === "started",
      )
    ) {
      return;
    }
    await this.#appendEvent(execution.journal, "task_transitioned", {
      definitionPath: ROOT_DEFINITION_PATH,
      taskId,
      planRevision: 1,
      from: current,
      to: target,
    });
  }

  async #reconcileTaskStatuses(
    execution: ActiveExecution,
    result: WorkflowPlanRunResult,
  ): Promise<void> {
    for (const task of result.result) {
      let projection = await this.#refresh(execution.journal);
      const current = projection.taskStates[task.id]?.status ?? "pending";
      if (current === task.status) continue;
      if (isTerminalTaskStatus(current)) {
        throw new DurableWorkflowPlanControllerError(
          "invalid_plan",
          `Durable task ${task.id} conflicts with terminal runner state.`,
        );
      }
      if (task.status === "pending" || task.status === "blocked") continue;
      if (current === "pending" && task.status !== "cancelled") {
        await this.#appendEvent(execution.journal, "task_transitioned", {
          definitionPath: ROOT_DEFINITION_PATH,
          taskId: task.id,
          planRevision: 1,
          from: "pending",
          to: "running",
        });
        projection = await this.#refresh(execution.journal);
      }
      const next = projection.taskStates[task.id]?.status ?? "pending";
      if (next === task.status) continue;
      await this.#appendEvent(execution.journal, "task_transitioned", {
        definitionPath: ROOT_DEFINITION_PATH,
        taskId: task.id,
        planRevision: 1,
        from: next,
        to: task.status,
      });
    }
  }

  async #finishInterruption(execution: ActiveExecution): Promise<never> {
    const reason = execution.interruptionReason ?? "owner_replaced";
    let projection = await this.#refresh(execution.journal);
    if (
      projection.terminal === undefined &&
      projection.status !== "interrupted"
    ) {
      await this.#appendEvent(execution.journal, "run_interrupted", { reason });
      projection = await this.#refresh(execution.journal);
    }
    for (const operation of projection.operations) {
      const attempt = operation.attempts.at(-1);
      if (attempt?.status !== "started") continue;
      await this.#appendEvent(execution.journal, "attempt_interrupted", {
        attempt: attempt.attempt,
        reason: "process_exit",
      });
    }
    throw new DurableWorkflowPlanControllerError(
      "interrupted",
      `Durable workflow run ${execution.runId} was interrupted (${reason}).`,
    );
  }

  async #readLaunchPlan(
    journal: WorkflowRunJournal,
  ): Promise<WorkflowPlanDefinition> {
    const launch = journal.readLaunch();
    if (
      !isDurableRecord(launch) ||
      launch.executionKind !== "plan" ||
      !("plan" in launch)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow launch is not a plan.",
      );
    }
    return canonicalSequentialPlan(
      validateWorkflowPlan(
        decodeDurableValue(encodeDurableValue(launch.plan).json),
      ),
    );
  }

  async #refresh(
    journal: WorkflowRunJournal,
  ): Promise<DurableWorkflowProjection> {
    const projection = foldWorkflowRunEvents(await journal.readEvents());
    await this.repository.replace(this.owner, projection);
    return projection;
  }

  async #appendEvent<Type extends WorkflowRunEvent["type"]>(
    journal: WorkflowRunJournal,
    type: Type,
    payload: Extract<WorkflowRunEvent, { type: Type }>["payload"],
    refresh = true,
  ): Promise<{
    readonly eventId: string;
    readonly receipt: WorkflowEventReceipt;
  }> {
    const fence = requiredFence(journal);
    const events = await journal.readEvents();
    const event = {
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: `${type}-${this.#generateId()}`,
      runId: journal.runId,
      runEpoch: fence.runEpoch,
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      type,
      payload,
    } as Extract<WorkflowRunEvent, { type: Type }>;
    const receipt = await journal.append(event);
    if (refresh) await this.#refresh(journal);
    return { eventId: event.eventId, receipt };
  }

  #assertExpectedOwner(expected: DurableWorkflowOwner | undefined): void {
    if (
      expected !== undefined &&
      !durableWorkflowOwnerEquals(expected, this.owner)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "wrong_owner",
        "Durable workflow resume owner does not match this controller.",
      );
    }
  }

  #assertExpectedEpoch(
    projection: DurableWorkflowProjection,
    expected: number | undefined,
  ): void {
    if (expected !== undefined && expected !== projection.runEpoch) {
      throw new DurableWorkflowPlanControllerError(
        "epoch_mismatch",
        `Durable workflow run epoch ${expected} is stale.`,
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DurableWorkflowPlanControllerError(
        "closed",
        "Durable workflow plan controller is released.",
      );
    }
  }
}

function isDurableRecord(
  value: DurableValue,
): value is { readonly [key: string]: DurableValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalSequentialPlan(
  input: WorkflowPlanDefinition,
): WorkflowPlanDefinition {
  const validated = validateWorkflowPlan(input);
  for (const phase of validated.phases) {
    if (phase.mode !== "sequence") {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow preview supports sequential phases only.",
      );
    }
    for (const task of phase.tasks) {
      if (
        task.agent?.isolation !== undefined &&
        task.agent.isolation !== "in-process"
      ) {
        throw new DurableWorkflowPlanControllerError(
          "invalid_plan",
          `Durable workflow task ${task.id} requests unsupported process isolation.`,
        );
      }
    }
  }
  const effective = {
    name: validated.name,
    description: validated.description,
    phases: validated.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      mode: phase.mode,
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        content: task.content,
        instruction: task.instruction,
        agent: { ...task.agent, isolation: "in-process" },
      })),
    })),
  };
  return validateWorkflowPlan(
    decodeDurableValue(encodeDurableValue(effective).json),
  );
}

function requiredFence(journal: WorkflowRunJournal): WorkflowRunEpochFence {
  if (journal.fence === undefined) {
    throw new DurableWorkflowPlanControllerError(
      "wrong_owner",
      "Durable workflow journal has no current owner fence.",
    );
  }
  return journal.fence;
}

function requiredPlanResult(result: SubagentResult | null): SubagentResult {
  if (result === null) {
    throw new DurableWorkflowPlanControllerError(
      "invalid_plan",
      "Durable plan task returned no agent result.",
    );
  }
  return result;
}

function operationInterruption(
  reason: DurableWorkflowPlanInterruptionReason,
): WorkflowOperationInterruptedError {
  const attemptReason =
    reason === "process_crash" || reason === "quit"
      ? "process_exit"
      : "owner_replaced";
  return new WorkflowOperationInterruptedError(
    attemptReason,
    `Durable workflow operation interrupted (${reason}).`,
  );
}

function planEventTarget(
  event: WorkflowPlanEvent,
): WorkflowPlanTaskStatus | undefined {
  switch (event.type) {
    case "task_started":
      return "running";
    case "task_blocked":
      return "blocked";
    case "task_unblocked":
      return "pending";
    case "task_succeeded":
      return "succeeded";
    case "task_failed":
      return "failed";
    case "task_skipped":
      return "skipped";
    case "task_cancelled":
      return "cancelled";
    case "run_cancelled":
      return undefined;
  }
}

function isTerminalTaskStatus(status: WorkflowPlanTaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "cancelled"
  );
}
