import type {
  WorkflowEventEnvelope,
  WorkflowRunLaunch,
  WorkflowRunStatus,
  WorkflowTerminalResult,
  WorkflowDeliveryIntent,
  WorkflowApprovalRequest,
  WorkflowApprovalDecision,
} from "./workflow-run-types";
import type { DurableValue } from "./workflow-durable-value";
import { canonicalizeWorkflowValue } from "./workflow-plan";
import { createHash } from "node:crypto";

export interface WorkflowProjectionTask {
  id: string;
  status:
    "pending" | "blocked" | "running" | "succeeded" | "failed" | "skipped";
  attempt: number;
  phaseId?: string;
  prompt?: string;
  label?: string;
  input?: DurableValue;
  result?: unknown;
  error?: string;
}

export interface WorkflowProjection {
  runId: string;
  planRevision: number;
  owner: WorkflowRunLaunch["owner"];
  status: WorkflowRunStatus;
  revision: number;
  currentPhase?: string;
  tasks: Record<string, WorkflowProjectionTask>;
  terminal?: WorkflowTerminalResult;
  usage: { input: number; output: number };
  usageLowerBound?: boolean;
  lastEventOrdinal: number;
  delivery?: WorkflowDeliveryIntent;
  approval?: {
    request: WorkflowApprovalRequest;
    status: "pending" | "approved" | "rejected";
    decision?: WorkflowApprovalDecision;
  };
  runBlock?: { reason: string; source: "approval" | "runtime" };
  cancellationRequested?: boolean;
  mutationHash?: string;
}

/** Read-only authority used by status, result, and tree projections. */
export interface WorkflowProjectionRepository {
  get(runId: string): Promise<WorkflowProjection | undefined>;
  list(): Promise<readonly WorkflowProjection[]>;
}

type Event = WorkflowEventEnvelope<string, any>;

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
    tasks: Object.create(null) as Record<string, WorkflowProjectionTask>,
    usage: { input: 0, output: 0 },
    lastEventOrdinal: -1,
  };

  const appliedEventIds = new Set<string>();
  const usageKeys = new Set<string>();
  let mutationHash = "";
  let currentRunEpoch = 0;

  for (const [ordinal, event] of events.entries()) {
    const eventEpoch = Number.isSafeInteger(event.runEpoch)
      ? event.runEpoch
      : 0;
    if (eventEpoch < currentRunEpoch) continue;
    if (eventEpoch > currentRunEpoch) currentRunEpoch = eventEpoch;
    if (appliedEventIds.has(event.eventId)) continue;
    appliedEventIds.add(event.eventId);
    projection.lastEventOrdinal = ordinal;
    projection.revision++;
    if (isMutationEvent(event.type)) {
      const payload = event.payload ?? {};
      const {
        previousMutationHash,
        mutationHash: candidate,
        ...data
      } = payload;
      const hasHashEvidence =
        previousMutationHash !== undefined || candidate !== undefined;
      if (hasHashEvidence) {
        const previous = previousMutationHash ?? "";
        const expectedCanonical = createHash("sha256")
          .update(
            canonicalizeWorkflowValue({
              previousMutationHash: previous,
              payload: data,
            }),
          )
          .digest("hex");
        const expectedLegacy = createHash("sha256")
          .update(
            JSON.stringify({
              previousMutationHash: previous,
              payload: data,
            }),
          )
          .digest("hex");
        if (
          previous !== mutationHash ||
          (candidate !== expectedCanonical && candidate !== expectedLegacy)
        )
          continue;
        mutationHash = candidate;
        projection.mutationHash = candidate;
      }
    }
    applyEvent(projection, event, usageKeys);
  }
  projection.tasks = Object.fromEntries(
    Object.entries(projection.tasks).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return projection;
}

function isMutationEvent(type: string): boolean {
  return [
    "task_blocked",
    "task_unblocked",
    "task_skipped",
    "task_appended",
  ].includes(type);
}

function applyEvent(
  projection: WorkflowProjection,
  event: Event,
  usageKeys: Set<string>,
): void {
  const payload = event.payload ?? {};
  // A task failure moves the projection to `error` before the coordinator
  // appends the richer terminal result. Keep that follow-up event applicable,
  // otherwise failed runs lose their durable error envelope during recovery.
  if (
    isTerminal(projection.status) &&
    event.type !== "run_result" &&
    event.type !== "run_terminal" &&
    event.type !== "delivery_intent" &&
    event.type !== "delivery_dispatched" &&
    event.type !== "delivery_receipt"
  )
    return;
  switch (event.type) {
    case "run_created":
      projection.status = "created";
      for (const task of payload.tasks ?? []) {
        const id = String(task.id);
        if (!projection.tasks[id]) {
          projection.tasks[id] = {
            id,
            status: "pending",
            attempt: 0,
            phaseId: String(task.phaseId),
            prompt: String(task.prompt),
            ...(task.label === undefined ? {} : { label: String(task.label) }),
            ...(task.input === undefined ? {} : { input: task.input }),
          };
        }
      }
      break;
    case "run_started":
      projection.status = "running";
      break;
    case "run_awaiting_budget":
      projection.status = "awaiting_budget";
      break;
    case "run_budget_resumed":
      projection.status = "running";
      break;
    case "approval_requested":
      projection.approval = {
        request: payload.request as WorkflowApprovalRequest,
        status: "pending",
      };
      break;
    case "approval_decided":
      if (!projection.approval) return;
      projection.approval.status = payload.status;
      projection.approval.decision = payload as WorkflowApprovalDecision;
      break;
    case "run_cancel_requested":
    case "run_cancellation_requested":
    case "run_admission_closed":
      projection.cancellationRequested = true;
      break;
    case "task_started": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      const attempt = Number(payload.attempt ?? (previous?.attempt ?? 0) + 1);
      if (previous && isTerminalTask(previous.status)) return;
      if (previous?.status === "blocked") return;
      if (previous && attempt < previous.attempt) return;
      projection.tasks[id] = {
        id,
        status: "running",
        attempt,
        ...definitionFields(previous),
      };
      projection.status = "running";
      projection.currentPhase = payload.phaseId ?? projection.currentPhase;
      break;
    }
    case "task_succeeded":
    case "task_done": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      const attempt = Number(payload.attempt ?? previous?.attempt ?? 1);
      if (previous && attempt < previous.attempt) return;
      if (previous?.status === "succeeded") return;
      projection.tasks[id] = {
        id,
        status: "succeeded",
        attempt,
        ...definitionFields(previous),
        ...(payload.result === undefined ? {} : { result: payload.result }),
      };
      break;
    }
    case "task_failed": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      const attempt = Number(payload.attempt ?? previous?.attempt ?? 1);
      if (previous && attempt < previous.attempt) return;
      if (previous && isTerminalTask(previous.status)) return;
      projection.tasks[id] = {
        id,
        status: "failed",
        attempt,
        ...definitionFields(previous),
        error: String(payload.error ?? payload.message ?? "Task failed"),
      };
      projection.status = "error";
      break;
    }
    case "task_blocked":
    case "task_unblocked":
    case "task_skipped": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      if (previous && isTerminalTask(previous.status)) return;
      const status =
        event.type === "task_blocked"
          ? "blocked"
          : event.type === "task_skipped"
            ? "skipped"
            : "pending";
      projection.tasks[id] = {
        id,
        status,
        attempt: previous?.attempt ?? 0,
        ...definitionFields(previous),
      };
      projection.status =
        event.type === "task_blocked"
          ? "blocked"
          : projection.status === "blocked" &&
              !projection.runBlock &&
              !Object.values(projection.tasks).some(
                (task) => task.status === "blocked",
              )
            ? "running"
            : projection.status;
      break;
    }
    case "task_appended": {
      const id = String(payload.taskId);
      if (projection.tasks[id]) return;
      projection.tasks[id] = {
        id,
        status: "pending",
        attempt: 0,
        phaseId: String(payload.phaseId),
        prompt: String(payload.prompt),
        ...(payload.label === undefined
          ? {}
          : { label: String(payload.label) }),
        ...(payload.input === undefined ? {} : { input: payload.input }),
      };
      break;
    }
    case "usage_observed": {
      const taskId = payload.taskId;
      const attempt = payload.attempt;
      const key =
        taskId === undefined || attempt === undefined
          ? event.eventId
          : `${String(taskId)}:${String(attempt)}`;
      if (usageKeys.has(key)) return;
      usageKeys.add(key);
      projection.usage.input += finite(payload.input);
      projection.usage.output += finite(payload.output);
      break;
    }
    case "run_interrupted":
      projection.status = "interrupted";
      projection.usageLowerBound = true;
      break;
    case "run_blocked":
      projection.status = "blocked";
      projection.runBlock = {
        reason: String(payload.reason ?? "Workflow blocked"),
        source: payload.source === "approval" ? "approval" : "runtime",
      };
      break;
    case "run_cancelled":
      projection.status = "cancelled";
      projection.terminal = { status: "cancelled" };
      break;
    case "run_result":
    case "run_terminal": {
      // Terminal state is append-only. A late or stale terminal event must not
      // replace the result already committed by the coordinator.
      if (projection.terminal) return;
      const terminal = (payload.result ?? payload) as WorkflowTerminalResult;
      projection.terminal = terminal;
      projection.status = terminal.status;
      break;
    }
    case "delivery_intent":
      if (!projection.delivery) {
        projection.delivery = {
          deliveryId: String(payload.deliveryId),
          kind: "terminal",
          status: "pending",
          message: String(payload.message ?? ""),
        };
      }
      break;
    case "delivery_dispatched":
      if (
        projection.delivery?.deliveryId === String(payload.deliveryId) &&
        projection.delivery.status !== "delivered"
      )
        projection.delivery.status = "dispatched";
      break;
    case "delivery_receipt":
      if (projection.delivery?.deliveryId === String(payload.deliveryId))
        projection.delivery.status = "delivered";
      break;
  }
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
function definitionFields(
  previous: WorkflowProjectionTask | undefined,
): Pick<WorkflowProjectionTask, "phaseId" | "prompt" | "label" | "input"> {
  return {
    ...(previous?.phaseId === undefined ? {} : { phaseId: previous.phaseId }),
    ...(previous?.prompt === undefined ? {} : { prompt: previous.prompt }),
    ...(previous?.label === undefined ? {} : { label: previous.label }),
    ...(previous?.input === undefined ? {} : { input: previous.input }),
  };
}

function isTerminal(status: WorkflowRunStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isTerminalTask(status: WorkflowProjectionTask["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}
