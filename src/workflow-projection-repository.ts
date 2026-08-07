import type {
  WorkflowEventEnvelope,
  WorkflowRunLaunch,
  WorkflowRunStatus,
  WorkflowTerminalResult,
  WorkflowDeliveryIntent,
  WorkflowApprovalRequest,
  WorkflowApprovalDecision,
} from "./workflow-run-types";

export interface WorkflowProjectionTask {
  id: string;
  status:
    "pending" | "blocked" | "running" | "succeeded" | "failed" | "skipped";
  attempt: number;
  phaseId?: string;
  prompt?: string;
  label?: string;
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
  lastEventOrdinal: number;
  delivery?: WorkflowDeliveryIntent;
  approval?: {
    request: WorkflowApprovalRequest;
    status: "pending" | "approved" | "rejected";
    decision?: WorkflowApprovalDecision;
  };
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

  for (const [ordinal, event] of events.entries()) {
    if (appliedEventIds.has(event.eventId)) continue;
    appliedEventIds.add(event.eventId);
    projection.lastEventOrdinal = ordinal;
    projection.revision++;
    applyEvent(projection, event, usageKeys);
  }
  return projection;
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
    case "task_started": {
      const id = String(payload.taskId);
      const previous = projection.tasks[id];
      const attempt = Number(payload.attempt ?? (previous?.attempt ?? 0) + 1);
      if (previous && isTerminalTask(previous.status)) return;
      if (previous && attempt < previous.attempt) return;
      projection.tasks[id] = {
        id,
        status: "running",
        attempt,
        ...(previous?.result === undefined ? {} : { result: previous.result }),
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
      };
      projection.status =
        event.type === "task_blocked"
          ? "blocked"
          : projection.status === "blocked"
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
      break;
    case "run_blocked":
      projection.status = "blocked";
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
      if (projection.delivery?.deliveryId === String(payload.deliveryId))
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

function isTerminal(status: WorkflowRunStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isTerminalTask(status: WorkflowProjectionTask["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}
