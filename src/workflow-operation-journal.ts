import { randomUUID } from "node:crypto";
import {
  decodeDurableValue,
  encodeDurableValue,
  type DurableValue,
  type EncodedDurableValue,
} from "./workflow-durable-value";
import type {
  WorkflowOperationBlobCodec,
  WorkflowOperationEventDraft,
  WorkflowOperationGateEvent,
  WorkflowOperationJournal,
  WorkflowOperationJournalState,
} from "./workflow-operation-gate";
import {
  WorkflowProjectionFoldError,
  foldWorkflowRunEvents,
  type DurableWorkflowOperationProjection,
  type DurableWorkflowProjection,
} from "./workflow-projection-repository";
import type {
  WorkflowBlobVerificationRequest,
  WorkflowBlobVerificationResult,
  WorkflowRecoveryBlobResolver,
} from "./workflow-recovery";
import {
  WorkflowRunStoreError,
  type WorkflowRunJournal,
  type WorkflowRunStore,
} from "./workflow-run-store";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  createWorkflowAttemptId,
  createWorkflowAttemptNumber,
  createWorkflowResponseOrdinal,
  durableWorkflowOwnerEquals,
  isWorkflowIdentifier,
  isWorkflowRunEvent,
  workflowOperationIdentityEquals,
  workflowOperationRequestMatches,
  workflowRunEpochFenceEquals,
  type WorkflowBlobReference,
  type WorkflowEventReceipt,
  type WorkflowOperationAttempt,
  type WorkflowOperationIdentity,
  type WorkflowOperationRequest,
  type WorkflowResponseOrdinal,
  type WorkflowRunEpochFence,
  type WorkflowRunEvent,
} from "./workflow-run-types";

const GATE_EVENT_TYPES: Readonly<
  Record<WorkflowOperationGateEvent["type"], true>
> = Object.freeze({
  operation_prepared: true,
  operation_dispatched: true,
  operation_settled: true,
  attempt_interrupted: true,
  operation_replayed: true,
  attempt_started: true,
  attempt_usage_observed: true,
  attempt_settled: true,
  response_ready: true,
});

export type WorkflowOperationJournalIdGenerator = () => string;

interface ReservedEvent {
  readonly event: WorkflowOperationGateEvent;
  readonly canonicalJson: string;
}

interface JournalCoordinator {
  tail: Promise<void>;
  nextSequence: number;
  readonly nextAttemptNumbers: Map<string, number>;
  readonly nextResponseOrdinals: Map<string, number>;
  readonly reservedAttemptIds: Set<string>;
  readonly reservedEvents: Map<string, ReservedEvent>;
}

interface FoldedJournal {
  readonly events: readonly WorkflowRunEvent[];
  readonly projection: DurableWorkflowProjection;
}

const journalCoordinators = new WeakMap<
  WorkflowRunJournal,
  JournalCoordinator
>();

export const durableWorkflowOperationBlobCodec: WorkflowOperationBlobCodec =
  Object.freeze({
    encode: encodeDurableValue,
    decode: decodeDurableValue,
  });

/**
 * Durable operation-gate adapter over one current, leased run journal.
 * Complete physical event order is authoritative; allocation caches only reserve
 * values that have not reached the journal yet.
 */
export class WorkflowRunOperationJournal implements WorkflowOperationJournal {
  readonly #journal: WorkflowRunJournal;
  readonly #generateId: WorkflowOperationJournalIdGenerator;
  readonly #coordinator: JournalCoordinator;

  constructor(
    journal: WorkflowRunJournal,
    generateId: WorkflowOperationJournalIdGenerator = randomUUID,
  ) {
    this.#journal = journal;
    this.#generateId = generateId;
    this.#coordinator = coordinatorFor(journal);
  }

  revalidateFence(fence: WorkflowRunEpochFence): Promise<void> {
    return this.#serialized(() => this.#assertFence(fence));
  }

  readOperation(
    fence: WorkflowRunEpochFence,
    operation: WorkflowOperationIdentity,
  ): Promise<WorkflowOperationJournalState> {
    return this.#serialized(async () => {
      if (operation.runId !== this.#journal.runId) {
        throw new WorkflowRunStoreError(
          "event_mismatch",
          "Workflow operation belongs to a different run.",
        );
      }
      const { projection } = await this.#fold(fence);
      const folded = projection.operations.find((candidate) =>
        workflowOperationIdentityEquals(candidate.identity, operation),
      );
      return folded === undefined ? { attempts: [] } : operationState(folded);
    });
  }

  allocateAttempt(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
  ): Promise<WorkflowOperationAttempt> {
    return this.#serialized(async () => {
      const { projection } = await this.#fold(fence);
      const operation = preparedOperation(projection, request);
      const key = `${request.identity.definitionPath}\u0000${request.identity.operationId}`;
      const nextNumber = Math.max(
        operation.nextAttemptNumber,
        this.#coordinator.nextAttemptNumbers.get(key) ?? 1,
      );
      const attemptId = createWorkflowAttemptId(this.#nextId("attempt"));
      if (
        this.#coordinator.reservedAttemptIds.has(attemptId) ||
        projection.operations.some((candidate) =>
          candidate.attempts.some(
            ({ attempt }) => attempt.attemptId === attemptId,
          ),
        )
      ) {
        throw new TypeError(
          `Workflow attempt ID ${attemptId} is already allocated.`,
        );
      }
      const attempt: WorkflowOperationAttempt = {
        operation: request.identity,
        requestDigest: request.requestDigest,
        definitionDigest: request.definitionDigest,
        dispatchOrdinal: request.dispatchOrdinal,
        attemptId,
        attemptNumber: createWorkflowAttemptNumber(nextNumber),
      };
      this.#coordinator.nextAttemptNumbers.set(key, nextNumber + 1);
      this.#coordinator.reservedAttemptIds.add(attemptId);
      return attempt;
    });
  }

  allocateResponseOrdinal(
    fence: WorkflowRunEpochFence,
    request: WorkflowOperationRequest,
  ): Promise<WorkflowResponseOrdinal> {
    return this.#serialized(async () => {
      const { projection } = await this.#fold(fence);
      preparedOperation(projection, request);
      const key = request.identity.definitionPath;
      const foldedNext =
        projection.ordinalAllocations.find(
          (allocation) => allocation.definitionPath === key,
        )?.nextResponseOrdinal ?? 1;
      const nextOrdinal = Math.max(
        foldedNext,
        this.#coordinator.nextResponseOrdinals.get(key) ?? 1,
      );
      this.#coordinator.nextResponseOrdinals.set(key, nextOrdinal + 1);
      return createWorkflowResponseOrdinal(nextOrdinal);
    });
  }

  createEvent(
    fence: WorkflowRunEpochFence,
    draft: WorkflowOperationEventDraft,
  ): Promise<WorkflowOperationGateEvent> {
    return this.#serialized(async () => {
      const { events, projection } = await this.#fold(fence);
      const eventId = this.#nextId("event");
      if (
        events.some((event) => event.eventId === eventId) ||
        this.#coordinator.reservedEvents.has(eventId)
      ) {
        throw new TypeError(
          `Workflow event ID ${eventId} is already allocated.`,
        );
      }
      const sequence = Math.max(
        projection.nextSequence,
        this.#coordinator.nextSequence || 1,
      );
      const event = {
        schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
        eventId,
        runId: fence.runId,
        runEpoch: fence.runEpoch,
        sequence,
        type: draft.type,
        payload: draft.payload,
      } as WorkflowOperationGateEvent;
      if (!isGateEvent(event)) {
        throw new TypeError("Workflow operation event draft is invalid.");
      }
      const canonicalJson = encodeDurableValue(event).json;
      this.#coordinator.nextSequence = sequence + 1;
      this.#coordinator.reservedEvents.set(eventId, {
        event,
        canonicalJson,
      });
      return event;
    });
  }

  append(
    fence: WorkflowRunEpochFence,
    event: WorkflowOperationGateEvent,
  ): Promise<WorkflowEventReceipt> {
    return this.#serialized(async () => {
      const { events, projection } = await this.#fold(fence);
      if (!isGateEvent(event)) {
        throw new TypeError("Workflow operation event is invalid.");
      }
      if (event.runId !== fence.runId || event.runEpoch !== fence.runEpoch) {
        throw new WorkflowRunStoreError(
          "epoch_mismatch",
          "Workflow operation event does not match the supplied fence.",
        );
      }
      const canonicalJson = encodeDurableValue(event).json;
      const committed = events.find(
        (candidate) => candidate.eventId === event.eventId,
      );
      if (committed !== undefined) {
        if (encodeDurableValue(committed).json !== canonicalJson) {
          throw new WorkflowRunStoreError(
            "event_mismatch",
            "Workflow event ID names different authoritative bytes.",
          );
        }
        return this.#journal.append(event);
      }
      const reserved = this.#coordinator.reservedEvents.get(event.eventId);
      if (
        reserved === undefined ||
        reserved.event !== event ||
        reserved.canonicalJson !== canonicalJson
      ) {
        throw new WorkflowRunStoreError(
          "event_mismatch",
          "Workflow operation event was not allocated by this journal.",
        );
      }
      if (event.sequence !== projection.nextSequence) {
        throw new WorkflowRunStoreError(
          "sequence_mismatch",
          "Workflow operation event does not extend the physical prefix.",
        );
      }
      const receipt = await this.#journal.append(event);
      this.#coordinator.reservedEvents.delete(event.eventId);
      return receipt;
    });
  }

  putOutcomeBlob(
    fence: WorkflowRunEpochFence,
    value: EncodedDurableValue,
  ): Promise<WorkflowBlobReference> {
    return this.#serialized(async () => {
      await this.#assertFence(fence);
      const decoded = decodeCanonicalEncoding(value);
      const reference = await this.#journal.writeOutput(decoded);
      if (
        reference.sha256 !== value.sha256 ||
        reference.sizeBytes !== value.bytes
      ) {
        throw new WorkflowRunStoreError(
          "immutable_conflict",
          "Workflow output reference does not match its canonical value.",
        );
      }
      return reference;
    });
  }

  readOutcomeBlob(
    fence: WorkflowRunEpochFence,
    reference: WorkflowBlobReference,
  ): Promise<string | Uint8Array> {
    return this.#serialized(async () => {
      await this.#assertFence(fence);
      const value = await this.#journal.readOutput(reference);
      await this.#journal.revalidateFence();
      return encodeDurableValue(value).json;
    });
  }

  #serialized<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#coordinator.tail.then(action);
    this.#coordinator.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #assertFence(fence: WorkflowRunEpochFence): Promise<void> {
    const journalFence = this.#journal.fence;
    if (
      journalFence === undefined ||
      !workflowRunEpochFenceEquals(journalFence, fence)
    ) {
      throw new WorkflowRunStoreError(
        "fence_lost",
        "Workflow operation journal fence is no longer current.",
      );
    }
    await this.#journal.revalidateFence();
  }

  async #fold(fence: WorkflowRunEpochFence): Promise<FoldedJournal> {
    await this.#assertFence(fence);
    const { events } = await this.#journal.readEventLog();
    const projection = foldWorkflowRunEvents(events);
    if (
      projection.runId !== this.#journal.runId ||
      !durableWorkflowOwnerEquals(projection.owner, this.#journal.owner) ||
      projection.runEpoch !== fence.runEpoch
    ) {
      throw new WorkflowProjectionFoldError(
        "wrong_run",
        "Workflow event prefix does not belong to the fenced journal.",
      );
    }
    return { events, projection };
  }

  #nextId(purpose: "attempt" | "event"): string {
    const id = this.#generateId();
    if (!isWorkflowIdentifier(id)) {
      throw new TypeError(`Generated workflow ${purpose} ID is invalid.`);
    }
    return id;
  }
}

/** Safe recovery verifier which derives every blob location through openRun. */
export class WorkflowRunBlobResolver implements WorkflowRecoveryBlobResolver {
  readonly #store: Pick<WorkflowRunStore, "openRun">;

  constructor(store: Pick<WorkflowRunStore, "openRun">) {
    this.#store = store;
  }

  async verifyBlob(
    request: WorkflowBlobVerificationRequest,
  ): Promise<WorkflowBlobVerificationResult> {
    try {
      const journal = await this.#store.openRun(request.owner, request.runId);
      if (
        request.purpose === "definition" ||
        request.purpose === "plan_definition"
      ) {
        await journal.readDefinition(request.reference);
      } else {
        await journal.readOutput(request.reference);
      }
      return { ok: true };
    } catch (error) {
      return mapBlobVerificationFailure(error);
    }
  }
}

function coordinatorFor(journal: WorkflowRunJournal): JournalCoordinator {
  const existing = journalCoordinators.get(journal);
  if (existing !== undefined) return existing;
  const coordinator: JournalCoordinator = {
    tail: Promise.resolve(),
    nextSequence: 0,
    nextAttemptNumbers: new Map(),
    nextResponseOrdinals: new Map(),
    reservedAttemptIds: new Set(),
    reservedEvents: new Map(),
  };
  journalCoordinators.set(journal, coordinator);
  return coordinator;
}

function isGateEvent(
  event: WorkflowRunEvent,
): event is WorkflowOperationGateEvent {
  return (
    isWorkflowRunEvent(event) &&
    GATE_EVENT_TYPES[event.type as WorkflowOperationGateEvent["type"]] === true
  );
}

function preparedOperation(
  projection: DurableWorkflowProjection,
  request: WorkflowOperationRequest,
): DurableWorkflowOperationProjection {
  const operation = projection.operations.find((candidate) =>
    workflowOperationIdentityEquals(candidate.identity, request.identity),
  );
  if (operation === undefined) {
    throw new WorkflowProjectionFoldError(
      "identity_conflict",
      "Workflow operation must be prepared before ordinal allocation.",
    );
  }
  if (!workflowOperationRequestMatches(operation.request, request)) {
    throw new WorkflowProjectionFoldError(
      "identity_conflict",
      "Workflow operation request conflicts with its prepared request.",
    );
  }
  return operation;
}

function operationState(
  operation: DurableWorkflowOperationProjection,
): WorkflowOperationJournalState {
  const settlement = operation.settlement;
  const response =
    settlement === undefined
      ? undefined
      : operation.responses.find(
          (candidate) => candidate.settlementEventId === settlement.eventId,
        );
  return {
    request: operation.request,
    attempts: operation.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      dispatched: attempt.dispatchedEventId !== undefined,
      ...(attempt.usageEventIds.length === 0
        ? {}
        : { observedUsage: attempt.usageObserved }),
      ...(attempt.settlementEventId === undefined ||
      attempt.outcome === undefined ||
      attempt.accounting === undefined
        ? {}
        : {
            settlement: {
              eventId: attempt.settlementEventId,
              outcome: attempt.outcome,
              accounting: attempt.accounting,
            },
          }),
    })),
    ...(settlement === undefined
      ? {}
      : {
          settlement: {
            eventId: settlement.eventId,
            attempt: settlement.attempt,
            outcome: settlement.outcome,
            accounting: settlement.accounting,
            ...(response === undefined
              ? {}
              : { responseOrdinal: response.responseOrdinal }),
          },
        }),
  };
}

function decodeCanonicalEncoding(value: EncodedDurableValue): DurableValue {
  const decoded = decodeDurableValue(value.json);
  const canonical = encodeDurableValue(decoded);
  if (
    canonical.json !== value.json ||
    canonical.bytes !== value.bytes ||
    canonical.sha256 !== value.sha256
  ) {
    throw new TypeError("Encoded durable workflow value metadata is invalid.");
  }
  return decoded;
}

function mapBlobVerificationFailure(
  error: unknown,
): WorkflowBlobVerificationResult {
  if (error instanceof WorkflowRunStoreError) {
    if (error.code === "hash_mismatch" || error.code === "size_mismatch") {
      return { ok: false, code: error.code, diagnostic: error.message };
    }
    if (
      error.code === "path_mismatch" ||
      error.code === "symlink_rejected" ||
      error.code === "run_not_found" ||
      error.code === "invalid_owner" ||
      error.code === "invalid_run_id"
    ) {
      return {
        ok: false,
        code: "path_mismatch",
        diagnostic:
          "Workflow blob could not be resolved through its run namespace.",
      };
    }
  }
  if (isFilesystemPathFailure(error)) {
    return {
      ok: false,
      code: "path_mismatch",
      diagnostic: "Workflow blob path is absent or is not a regular file.",
    };
  }
  throw error;
}

function isFilesystemPathFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return ["ENOENT", "ENOTDIR", "EISDIR", "ELOOP"].includes(
    String((error as { readonly code: unknown }).code),
  );
}
