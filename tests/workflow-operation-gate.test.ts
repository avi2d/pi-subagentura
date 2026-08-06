import { describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner, WorkflowUsage } from "../src/workflow-core";
import { WorkflowAgentDispatcher } from "../src/workflow-dispatcher";
import {
  decodeDurableValue,
  encodeDurableValue,
  type EncodedDurableValue,
} from "../src/workflow-durable-value";
import {
  WorkflowOperationGate,
  WorkflowOperationInterruptedError,
  type WorkflowOperationEventDraft,
  type WorkflowOperationGateEvent,
  type WorkflowOperationJournal,
  type WorkflowOperationJournalState,
} from "../src/workflow-operation-gate";
import {
  WORKFLOW_APPEND_RECEIPT_SCHEMA_VERSION,
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowAttemptId,
  createWorkflowAttemptNumber,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowDispatchOrdinal,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  createWorkflowResponseOrdinal,
  createWorkflowRunEpochFence,
  createWorkflowSha256Digest,
  workflowOperationIdentityEquals,
  workflowRunEpochFenceEquals,
  type DurableWorkflowUsage,
  type WorkflowBlobReference,
  type WorkflowEventReceipt,
  type WorkflowOperationAttempt,
  type WorkflowOperationIdentity,
  type WorkflowOperationRequest,
  type WorkflowResponseOrdinal,
  type WorkflowRunEpochFence,
  type WorkflowUsageAccounting,
} from "../src/workflow-run-types";

const REQUEST_DIGEST = "1".repeat(64);
const OTHER_REQUEST_DIGEST = "2".repeat(64);
const DEFINITION_DIGEST = "3".repeat(64);
const RECEIPT_DIGEST = createWorkflowSha256Digest("f".repeat(64));
const RUN_ID = createDurableWorkflowRunId("operation-gate");
const DEFINITION_PATH = createWorkflowDefinitionPath("root");
const FENCE = createWorkflowRunEpochFence(
  {
    projectKey: "a".repeat(64),
    piSessionKey: "pi-session",
  },
  {
    scopeId: 10,
    generation: 4,
    leaseToken: "unpredictable_lease_token",
    runEpoch: 1,
  },
  RUN_ID,
);

const blobCodec = {
  encode: encodeDurableValue,
  decode: decodeDurableValue,
};

function request(requestDigest = REQUEST_DIGEST): WorkflowOperationRequest {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    identity: createWorkflowOperationIdentity(
      RUN_ID,
      DEFINITION_PATH,
      "task-a",
    ),
    requestDigest: createWorkflowRequestDigest(requestDigest),
    definitionDigest: createWorkflowDefinitionDigest(DEFINITION_DIGEST),
    dispatchOrdinal: createWorkflowDispatchOrdinal(1),
  };
}

function usage(input = 7, output = 3): SubagentResult["usage"] {
  return {
    input,
    output,
    cacheRead: 2,
    cacheWrite: 1,
    cost: 0.25,
    costSource: "provider",
    turns: 1,
  };
}

function durableUsage(input = 7, output = 3): DurableWorkflowUsage {
  return {
    input,
    output,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: input + output + 3,
    costUsd: 0.25,
    costSource: "provider",
    turns: 1,
  };
}

function success(
  output: string,
  overrides: Partial<Extract<SubagentResult, { isError: false }>> = {},
): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: usage(),
    ...overrides,
  };
}

function returnedError(
  message: string,
): Extract<SubagentResult, { isError: true }> {
  return {
    isError: true,
    output: "",
    errorMessage: message,
    usage: usage(),
  };
}

function dispatchRequest(): Parameters<WorkflowAgentRunner>[0] {
  return { prompt: "do task A", isolation: "in-process" };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class InMemoryOperationJournal implements WorkflowOperationJournal {
  readonly events: WorkflowOperationGateEvent[] = [];
  readonly blobs = new Map<string, string>();
  readonly actions: string[] = [];
  currentFence: WorkflowRunEpochFence = FENCE;
  fenceValid = true;
  onAppend?: (event: WorkflowOperationGateEvent) => void;
  #sequence = 0;
  #byteOffset = 0;
  #responseOrdinal = 0;

  async revalidateFence(fence: WorkflowRunEpochFence): Promise<void> {
    this.actions.push("fence");
    this.#assertFence(fence);
  }

  async readOperation(
    fence: WorkflowRunEpochFence,
    operation: WorkflowOperationIdentity,
  ): Promise<WorkflowOperationJournalState> {
    this.actions.push("fold");
    this.#assertFence(fence);
    let prepared: WorkflowOperationRequest | undefined;
    const attempts: Array<{
      attempt: WorkflowOperationAttempt;
      dispatched: boolean;
      observedUsage?: DurableWorkflowUsage;
      settlement?: {
        eventId: string;
        outcome: Extract<
          WorkflowOperationGateEvent,
          { type: "attempt_settled" }
        >["payload"]["outcome"];
        accounting: WorkflowUsageAccounting;
      };
    }> = [];
    let settlement: WorkflowOperationJournalState["settlement"];

    for (const event of this.events) {
      if (event.type === "operation_prepared") {
        if (
          workflowOperationIdentityEquals(
            event.payload.request.identity,
            operation,
          )
        ) {
          prepared = event.payload.request;
        }
        continue;
      }
      if (event.type === "operation_replayed") continue;
      if (event.type === "response_ready") {
        if (
          settlement !== undefined &&
          workflowOperationIdentityEquals(event.payload.operation, operation)
        ) {
          settlement = {
            ...settlement,
            responseOrdinal: event.payload.responseOrdinal,
          };
        }
        continue;
      }
      const attempt = event.payload.attempt;
      if (!workflowOperationIdentityEquals(attempt.operation, operation)) {
        continue;
      }
      if (event.type === "attempt_started") {
        attempts.push({ attempt, dispatched: false });
      } else if (event.type === "operation_dispatched") {
        const state = attempts.find(
          (candidate) => candidate.attempt.attemptId === attempt.attemptId,
        );
        if (state) state.dispatched = true;
      } else if (event.type === "attempt_usage_observed") {
        const state = attempts.find(
          (candidate) => candidate.attempt.attemptId === attempt.attemptId,
        );
        if (state) state.observedUsage = event.payload.usageDelta;
      } else if (event.type === "attempt_settled") {
        const state = attempts.find(
          (candidate) => candidate.attempt.attemptId === attempt.attemptId,
        );
        if (state) {
          state.settlement = {
            eventId: event.eventId,
            outcome: event.payload.outcome,
            accounting: event.payload.accounting,
          };
        }
      } else if (event.type === "operation_settled") {
        settlement = {
          eventId: event.eventId,
          attempt,
          outcome: event.payload.outcome,
          accounting: event.payload.accounting,
        };
      }
    }
    return { request: prepared, attempts, settlement };
  }

  async allocateAttempt(
    fence: WorkflowRunEpochFence,
    operationRequest: WorkflowOperationRequest,
  ): Promise<WorkflowOperationAttempt> {
    this.actions.push("allocate_attempt");
    this.#assertFence(fence);
    const state = await this.readOperation(fence, operationRequest.identity);
    const next =
      state.attempts.reduce(
        (maximum, attempt) => Math.max(maximum, attempt.attempt.attemptNumber),
        0,
      ) + 1;
    return {
      operation: operationRequest.identity,
      requestDigest: operationRequest.requestDigest,
      definitionDigest: operationRequest.definitionDigest,
      dispatchOrdinal: operationRequest.dispatchOrdinal,
      attemptId: createWorkflowAttemptId(`attempt-${next}`),
      attemptNumber: createWorkflowAttemptNumber(next),
    };
  }

  async allocateResponseOrdinal(
    fence: WorkflowRunEpochFence,
    _operationRequest: WorkflowOperationRequest,
  ): Promise<WorkflowResponseOrdinal> {
    this.actions.push("allocate_response");
    this.#assertFence(fence);
    this.#responseOrdinal++;
    return createWorkflowResponseOrdinal(this.#responseOrdinal);
  }

  async createEvent(
    fence: WorkflowRunEpochFence,
    draft: WorkflowOperationEventDraft,
  ): Promise<WorkflowOperationGateEvent> {
    this.#assertFence(fence);
    this.#sequence++;
    return {
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: `event-${this.#sequence}`,
      runId: fence.runId,
      runEpoch: fence.runEpoch,
      sequence: this.#sequence,
      type: draft.type,
      payload: draft.payload,
    } as WorkflowOperationGateEvent;
  }

  async append(
    fence: WorkflowRunEpochFence,
    event: WorkflowOperationGateEvent,
  ): Promise<WorkflowEventReceipt> {
    this.#assertFence(fence);
    this.events.push(event);
    this.actions.push(`append:${event.type}`);
    const byteStart = this.#byteOffset;
    this.#byteOffset += 100;
    this.onAppend?.(event);
    return {
      schemaVersion: WORKFLOW_APPEND_RECEIPT_SCHEMA_VERSION,
      runId: fence.runId,
      eventId: event.eventId,
      runEpoch: fence.runEpoch,
      byteStart,
      byteEndExclusive: this.#byteOffset,
      lineDigest: RECEIPT_DIGEST,
    };
  }

  async putOutcomeBlob(
    fence: WorkflowRunEpochFence,
    value: EncodedDurableValue,
  ): Promise<WorkflowBlobReference> {
    this.#assertFence(fence);
    this.actions.push("blob:put");
    this.blobs.set(value.sha256, value.json);
    return {
      sha256: createWorkflowSha256Digest(value.sha256),
      sizeBytes: value.bytes,
    };
  }

  async readOutcomeBlob(
    fence: WorkflowRunEpochFence,
    reference: WorkflowBlobReference,
  ): Promise<string> {
    this.#assertFence(fence);
    this.actions.push("blob:read");
    const blob = this.blobs.get(reference.sha256);
    if (blob === undefined) throw new Error("missing test blob");
    return blob;
  }

  async seed(draft: WorkflowOperationEventDraft): Promise<void> {
    const event = await this.createEvent(FENCE, draft);
    await this.append(FENCE, event);
  }

  clearActions(): void {
    this.actions.length = 0;
  }

  #assertFence(fence: WorkflowRunEpochFence): void {
    if (
      !this.fenceValid ||
      !workflowRunEpochFenceEquals(fence, this.currentFence)
    ) {
      throw new Error("workflow fence lost");
    }
  }
}

function dispatcher(runAgent: WorkflowAgentRunner): WorkflowAgentDispatcher {
  return new WorkflowAgentDispatcher({
    concurrency: 1,
    processConcurrency: 1,
    runAgent,
  });
}

async function seedUncommittedAttempt(
  journal: InMemoryOperationJournal,
  operationRequest: WorkflowOperationRequest,
  observedUsage?: DurableWorkflowUsage,
): Promise<WorkflowOperationAttempt> {
  const attempt: WorkflowOperationAttempt = {
    operation: operationRequest.identity,
    requestDigest: operationRequest.requestDigest,
    definitionDigest: operationRequest.definitionDigest,
    dispatchOrdinal: operationRequest.dispatchOrdinal,
    attemptId: createWorkflowAttemptId("attempt-1"),
    attemptNumber: createWorkflowAttemptNumber(1),
  };
  await journal.seed({
    type: "operation_prepared",
    payload: { request: operationRequest },
  });
  await journal.seed({ type: "attempt_started", payload: { attempt } });
  await journal.seed({ type: "operation_dispatched", payload: { attempt } });
  if (observedUsage !== undefined) {
    await journal.seed({
      type: "attempt_usage_observed",
      payload: { attempt, usageDelta: observedUsage },
    });
  }
  journal.clearActions();
  return attempt;
}

describe("WorkflowOperationGate", () => {
  it("joins concurrent identical calls under one operation mutex", async () => {
    const release = deferred();
    const started = deferred();
    const result = success("shared");
    const runAgent = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return result;
    });
    const sharedDispatcher = dispatcher(runAgent);
    const journal = new InMemoryOperationJournal();
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: sharedDispatcher,
    });

    const first = gate.execute(FENCE, request(), dispatchRequest());
    await started.promise;
    const second = gate.execute(FENCE, request(), dispatchRequest());
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      result,
      result,
    ]);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(
      journal.events.filter((event) => event.type === "attempt_started"),
    ).toHaveLength(1);
    expect(
      journal.events.filter((event) => event.type === "operation_replayed"),
    ).toHaveLength(0);
  });

  it("replays a committed outcome before acquiring a dispatcher slot", async () => {
    const journal = new InMemoryOperationJournal();
    const firstRunner = vi.fn(async () => success("durable"));
    const firstGate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(firstRunner),
    });
    await firstGate.execute(FENCE, request(), dispatchRequest());

    const replayRunner = vi.fn(async () => {
      throw new Error("must not run");
    });
    const replayDispatcher = dispatcher(replayRunner);
    const runSpy = vi.spyOn(replayDispatcher, "run");
    const replacementGate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: replayDispatcher,
    });

    await expect(
      replacementGate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toEqual(success("durable"));
    expect(runSpy).not.toHaveBeenCalled();
    expect(replayRunner).not.toHaveBeenCalled();
    expect(replayDispatcher.activeCount).toBe(0);
    expect(journal.events.at(-1)?.type).toBe("operation_replayed");
  });

  it("rejects a conflicting digest for the same committed identity", async () => {
    const journal = new InMemoryOperationJournal();
    const runAgent = vi.fn(async () => success("first"));
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });
    await gate.execute(FENCE, request(), dispatchRequest());

    await expect(
      gate.execute(FENCE, request(OTHER_REQUEST_DIGEST), dispatchRequest()),
    ).rejects.toMatchObject({ code: "replay_diverged" });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("publishes dispatch evidence before work and commits before return", async () => {
    const journal = new InMemoryOperationJournal();
    const result = success("ordered");
    const runAgent = vi.fn(async () => {
      journal.actions.push("dispatcher:run");
      return result;
    });
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    const promise = gate
      .execute(FENCE, request(), dispatchRequest())
      .then((value) => {
        journal.actions.push("caller:return");
        return value;
      });
    await expect(promise).resolves.toEqual(result);

    expect(journal.actions).toEqual(
      expect.arrayContaining([
        "append:operation_prepared",
        "append:attempt_started",
        "append:operation_dispatched",
        "dispatcher:run",
        "blob:put",
        "append:attempt_usage_observed",
        "append:attempt_settled",
        "append:operation_settled",
        "append:response_ready",
        "caller:return",
      ]),
    );
    expect(journal.actions.indexOf("append:attempt_started")).toBeLessThan(
      journal.actions.indexOf("dispatcher:run"),
    );
    expect(journal.actions.indexOf("append:operation_dispatched")).toBeLessThan(
      journal.actions.indexOf("dispatcher:run"),
    );
    expect(journal.actions.indexOf("blob:put")).toBeLessThan(
      journal.actions.indexOf("append:attempt_usage_observed"),
    );
    expect(
      journal.actions.indexOf("append:attempt_usage_observed"),
    ).toBeLessThan(journal.actions.indexOf("append:attempt_settled"));
    expect(journal.actions.indexOf("append:operation_settled")).toBeLessThan(
      journal.actions.indexOf("caller:return"),
    );
    expect(journal.actions.indexOf("append:response_ready")).toBeLessThan(
      journal.actions.indexOf("caller:return"),
    );
  });

  it("commits and replays success with a null structured value", async () => {
    const journal = new InMemoryOperationJournal();
    const result = success("", {
      workflowStructuredOutput: { called: true, value: null },
    });
    const runAgent = vi.fn(async () => result);
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toEqual(result);
    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toEqual(result);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(
      journal.events.find((event) => event.type === "operation_settled")
        ?.payload.outcome.status,
    ).toBe("succeeded");
  });

  it("commits and replays a top-level null outcome", async () => {
    const journal = new InMemoryOperationJournal();
    const unusedRunner = vi.fn(async () => success("unused"));
    const sharedDispatcher = dispatcher(unusedRunner);
    const runSpy = vi
      .spyOn(sharedDispatcher, "run")
      .mockResolvedValue(null as never);
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: sharedDispatcher,
    });

    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toBeNull();
    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toBeNull();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(unusedRunner).not.toHaveBeenCalled();
  });

  it("commits and replays returned errors without throwing", async () => {
    const journal = new InMemoryOperationJournal();
    const result = returnedError("provider rejected request");
    const runAgent = vi.fn(async () => result);
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toEqual(result);
    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toEqual(result);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(
      journal.events.find((event) => event.type === "operation_settled")
        ?.payload.outcome.status,
    ).toBe("returned_error");
  });

  it("commits thrown errors and rethrows their durable envelope on replay", async () => {
    const journal = new InMemoryOperationJournal();
    const runAgent = vi.fn(async () => {
      const error = new Error("runner exploded");
      error.name = "RunnerError";
      throw error;
    });
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).rejects.toMatchObject({
      name: "RunnerError",
      message: "runner exploded",
    });
    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).rejects.toMatchObject({
      name: "RunnerError",
      message: "runner exploded",
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(
      journal.events.find((event) => event.type === "operation_settled")
        ?.payload.outcome.status,
    ).toBe("thrown_error");
  });

  it("interrupts an attempt without committing the operation and retries it", async () => {
    const journal = new InMemoryOperationJournal();
    const interruptedRunner = vi.fn(async () => {
      throw new WorkflowOperationInterruptedError("owner_replaced");
    });
    const firstGate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(interruptedRunner),
    });

    await expect(
      firstGate.execute(FENCE, request(), dispatchRequest()),
    ).rejects.toBeInstanceOf(WorkflowOperationInterruptedError);
    expect(
      journal.events.filter((event) => event.type === "attempt_interrupted"),
    ).toHaveLength(1);
    expect(
      journal.events.some(
        (event) =>
          event.type === "attempt_settled" ||
          event.type === "operation_settled",
      ),
    ).toBe(false);

    const retryResult = success("retried");
    const retryRunner = vi.fn(async () => retryResult);
    const secondGate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(retryRunner),
    });
    await expect(
      secondGate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toEqual(retryResult);
    expect(retryRunner).toHaveBeenCalledTimes(1);
    expect(
      journal.events
        .filter((event) => event.type === "attempt_started")
        .map((event) => event.payload.attempt.attemptNumber),
    ).toEqual([1, 2]);
  });

  it("commits and replays cancellation as a terminal operation outcome", async () => {
    const journal = new InMemoryOperationJournal();
    const result = success("cancelled by owner", { cancelled: true });
    const runAgent = vi.fn(async () => result);
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toEqual(result);
    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).resolves.toEqual(result);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(
      journal.events.find((event) => event.type === "operation_settled")
        ?.payload.outcome.status,
    ).toBe("cancelled");
  });

  it("fails acknowledgement when the live fence is lost after commit", async () => {
    const journal = new InMemoryOperationJournal();
    journal.onAppend = (event) => {
      if (event.type === "response_ready") journal.fenceValid = false;
    };
    const runAgent = vi.fn(async () => success("committed but fenced"));
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    await expect(
      gate.execute(FENCE, request(), dispatchRequest()),
    ).rejects.toThrow("workflow fence lost");
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(journal.events.at(-1)?.type).toBe("response_ready");
  });

  it("retries an uncommitted dispatch with the next attempt and lower-bound accounting", async () => {
    const operationRequest = request();
    const journal = new InMemoryOperationJournal();
    const priorUsage = durableUsage(2, 1);
    await seedUncommittedAttempt(journal, operationRequest, priorUsage);
    const retryResult = success("retried", { usage: usage(5, 4) });
    const runAgent = vi.fn(async () => retryResult);
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    await expect(
      gate.execute(FENCE, operationRequest, dispatchRequest()),
    ).resolves.toEqual(retryResult);

    const starts = journal.events.filter(
      (event) => event.type === "attempt_started",
    );
    expect(starts.map((event) => event.payload.attempt.attemptNumber)).toEqual([
      1, 2,
    ]);
    const operationSettlement = journal.events.findLast(
      (event) => event.type === "operation_settled",
    );
    expect(operationSettlement?.payload.accounting).toEqual({
      completeness: "lower_bound",
      reason: "provider_work_not_settled",
      usage: {
        input: 7,
        output: 5,
        cacheRead: 4,
        cacheWrite: 2,
        totalTokens: 18,
        costUsd: 0.5,
        costSource: "provider",
        turns: 2,
      },
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps first-attempt accounting exact and does not count live samples twice", async () => {
    const journal = new InMemoryOperationJournal();
    const finalResult = success("accounted");
    const liveUsage: WorkflowUsage = durableUsage();
    const runAgent = vi.fn(
      async (agentRequest: Parameters<WorkflowAgentRunner>[0]) => {
        agentRequest.onProgress?.({
          kind: "phase",
          phase: "running",
          liveUsage,
        });
        agentRequest.onProgress?.({
          kind: "phase",
          phase: "running",
          liveUsage,
        });
        return finalResult;
      },
    );
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    await gate.execute(FENCE, request(), dispatchRequest());

    const operationSettlements = journal.events.filter(
      (event) => event.type === "operation_settled",
    );
    expect(operationSettlements).toHaveLength(1);
    expect(operationSettlements[0]?.payload.accounting).toEqual({
      completeness: "exact",
      usage: durableUsage(),
    });
    const usageEvents = journal.events.filter(
      (event) => event.type === "attempt_usage_observed",
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.payload.usageDelta).toEqual(durableUsage());
    await gate.execute(FENCE, request(), dispatchRequest());
    expect(
      journal.events.filter((event) => event.type === "operation_settled"),
    ).toHaveLength(1);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("finishes a durably settled attempt without dispatching or double-counting", async () => {
    const operationRequest = request();
    const journal = new InMemoryOperationJournal();
    const attempt = await seedUncommittedAttempt(journal, operationRequest);
    const result = success("settled before crash");
    const encoded = blobCodec.encode(result);
    const reference = await journal.putOutcomeBlob(FENCE, encoded);
    const accounting: WorkflowUsageAccounting = {
      completeness: "exact",
      usage: durableUsage(),
    };
    await journal.seed({
      type: "attempt_settled",
      payload: {
        attempt,
        outcome: { status: "succeeded", value: reference },
        accounting,
      },
    });
    journal.clearActions();
    const runAgent = vi.fn(async () => {
      throw new Error("settled evidence must not redispatch");
    });
    const gate = new WorkflowOperationGate({
      journal,
      blobCodec,
      dispatcher: dispatcher(runAgent),
    });

    await expect(
      gate.execute(FENCE, operationRequest, dispatchRequest()),
    ).resolves.toEqual(result);
    expect(runAgent).not.toHaveBeenCalled();
    expect(
      journal.events.filter((event) => event.type === "operation_settled"),
    ).toHaveLength(1);
    expect(
      journal.events.find((event) => event.type === "operation_settled")
        ?.payload.accounting,
    ).toEqual(accounting);
  });
});
