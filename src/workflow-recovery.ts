import {
  DurableWorkflowProjectionRepository,
  type WorkflowProjection,
} from "./workflow-projection-repository";
import type { WorkflowRunStore } from "./workflow-run-store";
import type { WorkflowOwnerIdentity } from "./workflow-run-types";

export {
  DurableWorkflowProjectionRepository,
  type DurableWorkflowProjectionRepositoryOptions,
} from "./workflow-projection-repository";

export interface WorkflowRecoveryOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
}

/** Fold only committed evidence; unfinished attempts project as interrupted. */
export async function recoverWorkflowRun(
  options: WorkflowRecoveryOptions,
  runId: string,
): Promise<WorkflowProjection> {
  const projection = await new DurableWorkflowProjectionRepository(
    options.store,
    options.owner,
  ).get(runId);
  if (!projection) {
    const error = new Error(
      `Durable workflow run not found: ${runId}`,
    ) as Error & {
      code: string;
    };
    error.code = "ENOENT";
    throw error;
  }
  return projection;
}

export async function enumerateRecoverableWorkflowRuns(
  options: WorkflowRecoveryOptions,
): Promise<readonly WorkflowProjection[]> {
  return new DurableWorkflowProjectionRepository(
    options.store,
    options.owner,
  ).list();
}
