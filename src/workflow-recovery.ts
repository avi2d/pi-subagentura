import { WorkflowRunStore, type WorkflowRunRecord } from "./workflow-run-store";
import {
  projectWorkflowRun,
  type WorkflowProjection,
} from "./workflow-projection-repository";
import type { WorkflowOwnerIdentity } from "./workflow-run-types";

export interface WorkflowRecoveryOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
}

export async function recoverWorkflowRun(
  options: WorkflowRecoveryOptions,
  runId: string,
): Promise<WorkflowProjection> {
  const record = await options.store.readRun(runId);
  assertOwner(record, options.owner);
  return projectWorkflowRun(record.launch, record.events);
}

export async function enumerateRecoverableWorkflowRuns(
  options: WorkflowRecoveryOptions,
): Promise<readonly WorkflowProjection[]> {
  const projections: WorkflowProjection[] = [];
  for (const runId of await options.store.listRunIds()) {
    const record = await options.store.readRun(runId);
    if (!sameOwner(record.launch.owner, options.owner)) continue;
    projections.push(projectWorkflowRun(record.launch, record.events));
  }
  return projections;
}

function assertOwner(
  record: WorkflowRunRecord,
  owner: WorkflowOwnerIdentity,
): void {
  if (!sameOwner(record.launch.owner, owner)) {
    throw new Error("Workflow run belongs to a different owner or session.");
  }
}

function sameOwner(
  left: WorkflowOwnerIdentity,
  right: WorkflowOwnerIdentity,
): boolean {
  return (
    left.projectKey === right.projectKey &&
    left.cwd === right.cwd &&
    left.piSessionId === right.piSessionId &&
    left.ownerId === right.ownerId &&
    left.ownerGeneration === right.ownerGeneration &&
    left.leaseToken === right.leaseToken
  );
}
