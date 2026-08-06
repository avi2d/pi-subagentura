export const WORKFLOW_RUN_TYPES_VERSION = 1 as const;
export const WORKFLOW_RUN_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function validateWorkflowRunId(runId: string): void {
  if (!WORKFLOW_RUN_ID_PATTERN.test(runId)) {
    throw new Error("Invalid durable workflow run ID");
  }
}

export type WorkflowEagerMode = "off" | "preferred" | "always";
export type WorkflowResumePolicy = "manual" | "on-session-start";
export type WorkflowRunStatus =
  | "created"
  | "running"
  | "interrupted"
  | "blocked"
  | "done"
  | "error"
  | "cancelled";

export interface WorkflowOwnerIdentity {
  projectKey: string;
  cwd: string;
  piSessionId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseToken: string;
}

export interface WorkflowOperationIdentity {
  runId: string;
  definitionPath: string;
  operationId: string;
}

export interface WorkflowOperationRequest extends WorkflowOperationIdentity {
  requestDigest: string;
  prompt: string;
  responseOrdinal: number;
}

export interface WorkflowRunLaunch {
  schemaVersion: typeof WORKFLOW_RUN_TYPES_VERSION;
  runId: string;
  planRevision: number;
  resumePolicy: WorkflowResumePolicy;
  owner: WorkflowOwnerIdentity;
  createdAt: number;
  planDigest?: string;
}

export interface WorkflowAppendReceipt {
  eventId: string;
  runId: string;
  startByte: number;
  endByte: number;
  eventOrdinal: number;
  runEpoch: number;
}

export interface WorkflowOutcomeBlobRef {
  schemaVersion: typeof WORKFLOW_RUN_TYPES_VERSION;
  digest: string;
  bytes: number;
}

export interface WorkflowEventEnvelope<T extends string = string, P = unknown> {
  schemaVersion: typeof WORKFLOW_RUN_TYPES_VERSION;
  eventId: string;
  runId: string;
  eventOrdinal: number;
  runEpoch: number;
  type: T;
  payload: P;
}

export interface WorkflowTerminalResult {
  status: Extract<WorkflowRunStatus, "done" | "error" | "cancelled">;
  result?: unknown;
  error?: { code: string; message: string };
}

function isWorkflowBlobReference(
  value: unknown,
): value is WorkflowBlobReference {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["sha256", "sizeBytes"]) &&
    isWorkflowSha256Digest(value.sha256) &&
    isNonNegativeSafeInteger(value.sizeBytes)
  );
}

function isWorkflowRunEpochFenceValue(
  value: unknown,
): value is WorkflowRunEpochFence {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "durableOwner",
      "scopeId",
      "generation",
      "leaseToken",
      "runId",
      "runEpoch",
    ]) &&
    isDurableWorkflowOwner(value.durableOwner) &&
    isNonNegativeSafeInteger(value.scopeId) &&
    isPositiveSafeInteger(value.generation) &&
    isWorkflowLeaseToken(value.leaseToken) &&
    isDurableWorkflowRunId(value.runId) &&
    isPositiveSafeInteger(value.runEpoch)
  );
}

function isWorkflowOperationRequestValue(
  value: unknown,
): value is WorkflowOperationRequest {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "identity",
      "requestDigest",
      "definitionDigest",
      "dispatchOrdinal",
    ]) &&
    value.schemaVersion === WORKFLOW_RUN_SCHEMA_VERSION &&
    isWorkflowOperationIdentity(value.identity) &&
    isWorkflowSha256Digest(value.requestDigest) &&
    isWorkflowSha256Digest(value.definitionDigest) &&
    isWorkflowOrdinal(value.dispatchOrdinal)
  );
}

function isWorkflowOperationAttemptValue(
  value: unknown,
): value is WorkflowOperationAttempt {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "operation",
      "requestDigest",
      "definitionDigest",
      "dispatchOrdinal",
      "attemptId",
      "attemptNumber",
    ]) &&
    isWorkflowOperationIdentity(value.operation) &&
    isWorkflowSha256Digest(value.requestDigest) &&
    isWorkflowSha256Digest(value.definitionDigest) &&
    isWorkflowOrdinal(value.dispatchOrdinal) &&
    isWorkflowAttemptId(value.attemptId) &&
    isWorkflowOrdinal(value.attemptNumber)
  );
}

function isDurableWorkflowUsageValue(
  value: unknown,
): value is DurableWorkflowUsage {
  if (!isPlainRecord(value)) return false;
  const required = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "costUsd",
    "turns",
  ];
  const keys =
    value.costSource === undefined ? required : [...required, "costSource"];
  return (
    hasExactKeys(value, keys) &&
    isNonNegativeSafeInteger(value.input) &&
    isNonNegativeSafeInteger(value.output) &&
    isNonNegativeSafeInteger(value.cacheRead) &&
    isNonNegativeSafeInteger(value.cacheWrite) &&
    isNonNegativeSafeInteger(value.totalTokens) &&
    typeof value.costUsd === "number" &&
    Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 &&
    isNonNegativeSafeInteger(value.turns) &&
    (value.costSource === undefined ||
      value.costSource === "provider" ||
      value.costSource === "estimated" ||
      value.costSource === "unavailable" ||
      value.costSource === "mixed")
  );
}

function isWorkflowUsageAccountingValue(
  value: unknown,
): value is WorkflowUsageAccounting {
  if (!isPlainRecord(value)) return false;
  if (value.completeness === "exact") {
    return (
      hasExactKeys(value, ["completeness", "usage"]) &&
      isDurableWorkflowUsageValue(value.usage)
    );
  }
  return (
    value.completeness === "lower_bound" &&
    hasExactKeys(value, ["completeness", "usage", "reason"]) &&
    isDurableWorkflowUsageValue(value.usage) &&
    (value.reason === "provider_work_not_settled" ||
      value.reason === "ambiguous_dispatch" ||
      value.reason === "recovery_gap")
  );
}

function isWorkflowOperationOutcomeValue(
  value: unknown,
): value is WorkflowOperationOutcome {
  if (!isPlainRecord(value)) return false;
  switch (value.status) {
    case "succeeded":
      return (
        hasExactKeys(value, ["status", "value"]) &&
        isWorkflowBlobReference(value.value)
      );
    case "returned_error":
    case "thrown_error":
    case "schema_retry_exhausted":
      return (
        hasExactKeys(value, ["status", "error"]) &&
        isWorkflowBlobReference(value.error)
      );
    case "cancelled":
      return (
        hasExactKeys(value, ["status", "reason"]) &&
        typeof value.reason === "string"
      );
    default:
      return false;
  }
}

function isWorkflowTaskStatus(value: unknown): value is WorkflowPlanTaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "blocked" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "skipped" ||
    value === "cancelled"
  );
}

function isWorkflowTerminalStatusValue(
  value: unknown,
): value is WorkflowTerminalStatus {
  return value === "done" || value === "error" || value === "cancelled";
}

function eventOperationBelongsToRun(
  value: WorkflowOperationIdentity,
  runId: DurableWorkflowRunId,
): boolean {
  return value.runId === runId;
}

function eventAttemptBelongsToRun(
  value: WorkflowOperationAttempt,
  runId: DurableWorkflowRunId,
): boolean {
  return value.operation.runId === runId;
}

function isWorkflowRunEventPayload(
  type: string,
  payload: unknown,
  runId: DurableWorkflowRunId,
  runEpoch: number,
): boolean {
  if (!isPlainRecord(payload)) return false;
  switch (type) {
    case "run_created":
      return (
        hasExactKeys(payload, [
          "durableOwner",
          "executionKind",
          "rootDefinitionPath",
          "rootDefinitionDigest",
          "resumePolicy",
        ]) &&
        isDurableWorkflowOwner(payload.durableOwner) &&
        (payload.executionKind === "plan" ||
          payload.executionKind === "script") &&
        isWorkflowDefinitionPath(payload.rootDefinitionPath) &&
        isWorkflowSha256Digest(payload.rootDefinitionDigest) &&
        (payload.resumePolicy === "automatic_on_reload_or_resume" ||
          payload.resumePolicy === "trusted_resume" ||
          payload.resumePolicy === "never")
      );
    case "run_epoch_acquired":
      return (
        hasExactKeys(payload, ["fence", "previousRunEpoch", "reason"]) &&
        isWorkflowRunEpochFenceValue(payload.fence) &&
        payload.fence.runId === runId &&
        payload.fence.runEpoch === runEpoch &&
        (payload.previousRunEpoch === null ||
          isPositiveSafeInteger(payload.previousRunEpoch)) &&
        (payload.reason === "created" ||
          payload.reason === "reload" ||
          payload.reason === "resume" ||
          payload.reason === "startup" ||
          payload.reason === "stale_takeover")
      );
    case "definition_captured":
      if (
        payload.captureKind === "root" &&
        hasExactKeys(payload, [
          "captureKind",
          "definitionPath",
          "definitionDigest",
          "definition",
        ])
      ) {
        return (
          isWorkflowDefinitionPath(payload.definitionPath) &&
          isWorkflowSha256Digest(payload.definitionDigest) &&
          isWorkflowBlobReference(payload.definition)
        );
      }
      return (
        payload.captureKind === "nested" &&
        hasExactKeys(payload, [
          "captureKind",
          "definitionPath",
          "definitionDigest",
          "definition",
          "parentOperation",
        ]) &&
        isWorkflowDefinitionPath(payload.definitionPath) &&
        isWorkflowSha256Digest(payload.definitionDigest) &&
        isWorkflowBlobReference(payload.definition) &&
        isWorkflowOperationIdentity(payload.parentOperation) &&
        eventOperationBelongsToRun(payload.parentOperation, runId)
      );
    case "plan_defined":
      return (
        hasExactKeys(payload, ["revision", "definitionDigest", "definition"]) &&
        isPositiveSafeInteger(payload.revision) &&
        isWorkflowSha256Digest(payload.definitionDigest) &&
        isWorkflowBlobReference(payload.definition)
      );
    case "plan_revised":
      return (
        hasExactKeys(payload, [
          "previousRevision",
          "revision",
          "previousDefinitionDigest",
          "definitionDigest",
          "definition",
        ]) &&
        isPositiveSafeInteger(payload.previousRevision) &&
        isPositiveSafeInteger(payload.revision) &&
        payload.revision > payload.previousRevision &&
        isWorkflowSha256Digest(payload.previousDefinitionDigest) &&
        isWorkflowSha256Digest(payload.definitionDigest) &&
        isWorkflowBlobReference(payload.definition)
      );
    case "operation_prepared":
      return (
        hasExactKeys(payload, ["request"]) &&
        isWorkflowOperationRequestValue(payload.request) &&
        eventOperationBelongsToRun(payload.request.identity, runId)
      );
    case "operation_dispatched":
    case "attempt_started":
      return (
        hasExactKeys(payload, ["attempt"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId)
      );
    case "operation_settled":
    case "attempt_settled":
      return (
        hasExactKeys(payload, ["attempt", "outcome", "accounting"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId) &&
        isWorkflowOperationOutcomeValue(payload.outcome) &&
        isWorkflowUsageAccountingValue(payload.accounting)
      );
    case "operation_replayed":
      return (
        hasExactKeys(payload, [
          "request",
          "settledEventId",
          "responseOrdinal",
        ]) &&
        isWorkflowOperationRequestValue(payload.request) &&
        eventOperationBelongsToRun(payload.request.identity, runId) &&
        isWorkflowIdentifier(payload.settledEventId) &&
        isWorkflowOrdinal(payload.responseOrdinal)
      );
    case "attempt_usage_observed":
      return (
        hasExactKeys(payload, ["attempt", "usageDelta"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId) &&
        isDurableWorkflowUsageValue(payload.usageDelta)
      );
    case "attempt_interrupted":
      return (
        hasExactKeys(payload, ["attempt", "reason"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId) &&
        (payload.reason === "owner_replaced" ||
          payload.reason === "process_exit" ||
          payload.reason === "recovery")
      );
    case "attempt_cancelled":
      return (
        hasExactKeys(payload, ["attempt", "reason"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId) &&
        typeof payload.reason === "string"
      );
    case "task_transitioned":
      return (
        hasExactKeys(payload, [
          "definitionPath",
          "taskId",
          "planRevision",
          "from",
          "to",
        ]) &&
        isWorkflowDefinitionPath(payload.definitionPath) &&
        isWorkflowIdentifier(payload.taskId) &&
        isPositiveSafeInteger(payload.planRevision) &&
        isWorkflowTaskStatus(payload.from) &&
        isWorkflowTaskStatus(payload.to)
      );
    case "response_ready":
      return (
        hasExactKeys(payload, [
          "operation",
          "dispatchOrdinal",
          "responseOrdinal",
          "settlementEventId",
        ]) &&
        isWorkflowOperationIdentity(payload.operation) &&
        eventOperationBelongsToRun(payload.operation, runId) &&
        isWorkflowOrdinal(payload.dispatchOrdinal) &&
        isWorkflowOrdinal(payload.responseOrdinal) &&
        isWorkflowIdentifier(payload.settlementEventId)
      );
    case "budget_requested":
      return (
        hasExactKeys(payload, ["budgetRequestId", "reason", "accounting"]) &&
        isWorkflowIdentifier(payload.budgetRequestId) &&
        (payload.reason === "agent_limit" ||
          payload.reason === "token_limit" ||
          payload.reason === "cost_limit") &&
        isWorkflowUsageAccountingValue(payload.accounting)
      );
    case "budget_decided":
      return (
        hasExactKeys(payload, [
          "budgetRequestId",
          "requestEventId",
          "decision",
          "trustedActorId",
        ]) &&
        isWorkflowIdentifier(payload.budgetRequestId) &&
        isWorkflowIdentifier(payload.requestEventId) &&
        (payload.decision === "approved" || payload.decision === "denied") &&
        isWorkflowIdentifier(payload.trustedActorId)
      );
    case "run_interrupted":
      return (
        hasExactKeys(payload, ["reason"]) &&
        (payload.reason === "reload" ||
          payload.reason === "quit" ||
          payload.reason === "process_crash" ||
          payload.reason === "owner_replaced")
      );
    case "run_resumed": {
      const keys =
        payload.trustedActorId === undefined
          ? ["reason"]
          : ["reason", "trustedActorId"];
      return (
        hasExactKeys(payload, keys) &&
        (payload.reason === "reload" ||
          payload.reason === "resume" ||
          payload.reason === "trusted_resume") &&
        (payload.trustedActorId === undefined ||
          isWorkflowIdentifier(payload.trustedActorId))
      );
    }
    case "run_cancellation_requested":
      return (
        hasExactKeys(payload, ["reason", "trustedActorId"]) &&
        typeof payload.reason === "string" &&
        isWorkflowIdentifier(payload.trustedActorId)
      );
    case "run_cancelled":
      return (
        hasExactKeys(payload, ["reason", "accounting"]) &&
        typeof payload.reason === "string" &&
        isWorkflowUsageAccountingValue(payload.accounting)
      );
    case "run_result_recorded":
      return (
        hasExactKeys(payload, ["result", "accounting"]) &&
        isWorkflowBlobReference(payload.result) &&
        isWorkflowUsageAccountingValue(payload.accounting)
      );
    case "run_terminal": {
      const keys =
        payload.resultEventId === undefined
          ? ["status", "accounting"]
          : ["status", "accounting", "resultEventId"];
      return (
        hasExactKeys(payload, keys) &&
        isWorkflowTerminalStatusValue(payload.status) &&
        isWorkflowUsageAccountingValue(payload.accounting) &&
        (payload.resultEventId === undefined ||
          isWorkflowIdentifier(payload.resultEventId))
      );
    }
    case "delivery_intent_recorded":
      return (
        hasExactKeys(payload, [
          "outboxSchemaVersion",
          "deliveryId",
          "terminalEventId",
          "payload",
        ]) &&
        payload.outboxSchemaVersion === WORKFLOW_OUTBOX_SCHEMA_VERSION &&
        isWorkflowIdentifier(payload.deliveryId) &&
        isWorkflowIdentifier(payload.terminalEventId) &&
        isWorkflowBlobReference(payload.payload)
      );
    case "delivery_receipt_recorded":
      return (
        hasExactKeys(payload, [
          "outboxSchemaVersion",
          "deliveryId",
          "intentEventId",
          "deliveredBy",
        ]) &&
        payload.outboxSchemaVersion === WORKFLOW_OUTBOX_SCHEMA_VERSION &&
        isWorkflowIdentifier(payload.deliveryId) &&
        isWorkflowIdentifier(payload.intentEventId) &&
        isWorkflowIdentifier(payload.deliveredBy)
      );
    case "storage_failure": {
      const keys =
        payload.relatedEventId === undefined
          ? ["code", "diagnostic"]
          : ["code", "diagnostic", "relatedEventId"];
      return (
        hasExactKeys(payload, keys) &&
        (payload.code === "quota_exceeded" ||
          payload.code === "append_failed" ||
          payload.code === "sync_failed" ||
          payload.code === "blob_mismatch") &&
        typeof payload.diagnostic === "string" &&
        (payload.relatedEventId === undefined ||
          isWorkflowIdentifier(payload.relatedEventId))
      );
    }
    case "recovery_failed": {
      const keys =
        payload.byteOffset === undefined
          ? ["code", "diagnostic"]
          : ["code", "diagnostic", "byteOffset"];
      return (
        hasExactKeys(payload, keys) &&
        (payload.code === "malformed_complete_line" ||
          payload.code === "hash_mismatch" ||
          payload.code === "size_mismatch" ||
          payload.code === "path_mismatch" ||
          payload.code === "fence_lost") &&
        typeof payload.diagnostic === "string" &&
        (payload.byteOffset === undefined ||
          isNonNegativeSafeInteger(payload.byteOffset))
      );
    }
    default:
      return false;
  }
}

/**
 * Validate the exact persisted event shape. Complete journal lines that fail
 * this guard are authoritative corruption and must never be skipped.
 */
export function isWorkflowRunEvent(value: unknown): value is WorkflowRunEvent {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "eventId",
      "runId",
      "runEpoch",
      "sequence",
      "type",
      "payload",
    ]) ||
    value.schemaVersion !== WORKFLOW_RUN_EVENT_SCHEMA_VERSION ||
    !isWorkflowIdentifier(value.eventId) ||
    !isDurableWorkflowRunId(value.runId) ||
    !isPositiveSafeInteger(value.runEpoch) ||
    !isPositiveSafeInteger(value.sequence) ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  return isWorkflowRunEventPayload(
    value.type,
    value.payload,
    value.runId,
    value.runEpoch,
  );
}
