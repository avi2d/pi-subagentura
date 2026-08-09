import { isAbsolute } from "node:path";
import type { WorkflowOwnerIdentity } from "./workflow-run-types";
import { WorkflowRunStore } from "./workflow-run-store";
import { DurableWorkflowController } from "./workflow-durable-plan-runner";
import type { SessionScope } from "./session-scope";

export interface WorkflowOwnerIdentityInput {
  projectKey: string;
  cwd: string;
  piSessionId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseToken: string;
}

const SAFE_PATH_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Construct and validate the durable lookup identity and live owner fence. */
export function createWorkflowOwnerIdentity(
  input: WorkflowOwnerIdentityInput,
): WorkflowOwnerIdentity {
  if (!SAFE_PATH_KEY.test(input.projectKey)) {
    throw new Error("Invalid workflow owner projectKey");
  }
  if (!SAFE_PATH_KEY.test(input.piSessionId)) {
    throw new Error("Invalid workflow owner piSessionId");
  }
  if (
    !isAbsolute(input.cwd) ||
    input.cwd.length === 0 ||
    Buffer.byteLength(input.cwd, "utf8") > 4096
  ) {
    throw new Error("Invalid workflow owner cwd");
  }
  for (const [label, value] of [
    ["ownerId", input.ownerId],
    ["leaseToken", input.leaseToken],
  ] as const) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > 256
    ) {
      throw new Error(`Invalid workflow owner ${label}`);
    }
  }
  if (
    !Number.isSafeInteger(input.ownerGeneration) ||
    input.ownerGeneration < 0
  ) {
    throw new Error("Invalid workflow owner generation");
  }
  return {
    projectKey: input.projectKey,
    cwd: input.cwd,
    piSessionId: input.piSessionId,
    ownerId: input.ownerId,
    ownerGeneration: input.ownerGeneration,
    leaseToken: input.leaseToken,
  };
}

/** Create an owner-scoped store rooted at the caller-selected v1 base path. */
export function createWorkflowRunStore(
  rootDir: string,
  input: WorkflowOwnerIdentityInput,
): WorkflowRunStore {
  if (!isAbsolute(rootDir) || Buffer.byteLength(rootDir, "utf8") > 4096) {
    throw new Error("Invalid workflow store root directory");
  }
  return new WorkflowRunStore({
    rootDir,
    owner: createWorkflowOwnerIdentity(input),
  });
}

function sessionWorkflowRunStore(
  scope: SessionScope,
): WorkflowRunStore | undefined {
  if (
    scope.lifecycle !== "started" ||
    !scope.durableWorkflowRootDir ||
    !scope.durableWorkflowOwner
  ) {
    return undefined;
  }
  if (
    !isAbsolute(scope.durableWorkflowRootDir) ||
    scope.durableWorkflowRootDir.includes("\0") ||
    Buffer.byteLength(scope.durableWorkflowRootDir, "utf8") > 4096
  ) {
    throw new Error("Invalid workflow store root directory");
  }
  if (!scope.durableWorkflowStore) {
    scope.durableWorkflowStore = new WorkflowRunStore({
      rootDir: scope.durableWorkflowRootDir,
      owner: scope.durableWorkflowOwner,
    });
  }
  return scope.durableWorkflowStore;
}

export function durableWorkflowStoreForSession(
  scope: SessionScope,
): WorkflowRunStore | undefined {
  return sessionWorkflowRunStore(scope);
}

export function durableWorkflowControllerForSession(
  scope: SessionScope,
): DurableWorkflowController | undefined {
  if (scope.lifecycle !== "started" || !scope.durableWorkflowOwner) {
    return undefined;
  }
  if (!scope.durableWorkflowController) {
    const store = sessionWorkflowRunStore(scope);
    if (!store) return undefined;
    scope.durableWorkflowController = new DurableWorkflowController({
      store,
      owner: scope.durableWorkflowOwner,
    });
  }
  return scope.durableWorkflowController;
}
