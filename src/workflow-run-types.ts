export const WORKFLOW_RUN_TYPES_VERSION = 1 as const;

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
}

export interface WorkflowAppendReceipt {
  eventId: string;
  runId: string;
  startByte: number;
  endByte: number;
  eventOrdinal: number;
}

export interface WorkflowEventEnvelope<T extends string = string, P = unknown> {
  schemaVersion: typeof WORKFLOW_RUN_TYPES_VERSION;
  eventId: string;
  runId: string;
  runEpoch: number;
  type: T;
  payload: P;
}

export interface WorkflowTerminalResult {
  status: Extract<WorkflowRunStatus, "done" | "error" | "cancelled">;
  result?: unknown;
  error?: { code: string; message: string };
}
