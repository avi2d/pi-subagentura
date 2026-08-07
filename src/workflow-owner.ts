import type { WorkflowOwnerIdentity } from "./workflow-run-types";
import { WorkflowRunStore } from "./workflow-run-store";

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
