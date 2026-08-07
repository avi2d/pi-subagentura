import type { WorkflowOwnerIdentity } from "./workflow-run-types";
import { WorkflowRunStore } from "./workflow-run-store";
import { DurableWorkflowController } from "./workflow-durable-plan-runner";

export interface WorkflowOwnerIdentityInput {
  projectKey: string;
  cwd: string;
  piSessionId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseToken: string;
}

/** Construct the complete durable owner fence from host-provided identity. */
export function createWorkflowOwnerIdentity(
  input: WorkflowOwnerIdentityInput,
): WorkflowOwnerIdentity {
  for (const [label, value] of Object.entries(input)) {
    if (label === "ownerGeneration") continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 200) {
      throw new Error(`Invalid workflow owner ${label}`);
    }
  }
  if (
    !Number.isSafeInteger(input.ownerGeneration) ||
    input.ownerGeneration < 0
  ) {
    throw new Error("Invalid workflow owner generation");
  }
  return { ...input };
}

export function createWorkflowRunStore(
  rootDir: string,
  input: WorkflowOwnerIdentityInput,
): WorkflowRunStore {
  if (!rootDir || rootDir.length > 500) {
    throw new Error("Invalid workflow store root directory");
  }
  return new WorkflowRunStore({
    rootDir,
    owner: createWorkflowOwnerIdentity(input),
  });
}

export function createDurableWorkflowController(
  rootDir: string,
  input: WorkflowOwnerIdentityInput,
): DurableWorkflowController {
  const owner = createWorkflowOwnerIdentity(input);
  return new DurableWorkflowController({
    store: new WorkflowRunStore({ rootDir, owner }),
    owner,
  });
}

export function workflowOwnerFromSessionContext(input: {
  projectKey: string;
  cwd: string;
  sessionId: string;
  ownerId: string;
  generation: number;
  leaseToken: string;
}): WorkflowOwnerIdentity {
  return createWorkflowOwnerIdentity({
    projectKey: input.projectKey,
    cwd: input.cwd,
    piSessionId: input.sessionId,
    ownerId: input.ownerId,
    ownerGeneration: input.generation,
    leaseToken: input.leaseToken,
  });
}
