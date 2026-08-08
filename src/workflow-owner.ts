import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { WorkflowOwnerIdentity } from "./workflow-run-types";
import { WorkflowRunStore } from "./workflow-run-store";
import {
  DurableWorkflowController,
  runDurableWorkflowPlan,
  type DurableWorkflowPlanOptions,
} from "./workflow-durable-plan-runner";
import type { SessionScope } from "./session-scope";

export interface WorkflowOwnerIdentityInput {
  projectKey: string;
  cwd: string;
  piSessionId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseToken: string;
}

/** Resolve a portable project namespace from the canonical real cwd. */
export function canonicalWorkflowProjectKey(cwd: string): string {
  if (!cwd || cwd.length > 500) throw new Error("Invalid workflow cwd");
  let canonical: string;
  try {
    canonical = realpathSync.native(cwd);
  } catch (error) {
    throw new Error("Workflow cwd cannot be canonicalized", { cause: error });
  }
  return createHash("sha256").update(canonical).digest("hex");
}

/** Stable session owner IDs survive process restart; a namespace salt is used
 * only by explicit new/fork lifecycle boundaries. */
export function workflowSessionOwnerId(
  sessionId: string,
  namespaceSalt = "",
): string {
  if (!sessionId || sessionId.length > 200) {
    throw new Error("Invalid workflow session ID");
  }
  return `session-${createHash("sha256")
    .update(`${sessionId}\0${namespaceSalt}`)
    .digest("hex")}`;
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

function sessionScopeDurableStore(
  rootDir: string,
  scope: SessionScope,
): WorkflowRunStore | undefined {
  const owner = scope.durableWorkflowOwner;
  if (!owner) return undefined;
  if (!scope.durableWorkflowStore) {
    scope.durableWorkflowStore = new WorkflowRunStore({ rootDir, owner });
  }
  return scope.durableWorkflowStore;
}

export function durableWorkflowControllerForSession(
  rootDir: string,
  scope: SessionScope,
): DurableWorkflowController | undefined {
  const owner = scope.durableWorkflowOwner;
  if (!owner) return undefined;
  if (!scope.durableWorkflowController) {
    const store = sessionScopeDurableStore(rootDir, scope);
    if (!store) return undefined;
    scope.durableWorkflowController = new DurableWorkflowController({
      store,
      owner,
    });
  }
  return scope.durableWorkflowController;
}

export function durableWorkflowStoreForSession(
  rootDir: string,
  scope: SessionScope,
): WorkflowRunStore | undefined {
  return sessionScopeDurableStore(rootDir, scope);
}

export function runDurableWorkflowForSession(
  rootDir: string,
  scope: SessionScope,
  options: Omit<DurableWorkflowPlanOptions, "store" | "owner">,
): Promise<Awaited<ReturnType<typeof runDurableWorkflowPlan>>> {
  const owner = scope.durableWorkflowOwner;
  if (!owner) throw new Error("Durable workflow storage is unavailable.");
  const store = sessionScopeDurableStore(rootDir, scope);
  if (!store) throw new Error("Durable workflow storage is unavailable.");
  return runDurableWorkflowPlan({
    ...options,
    store,
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

/** Create a fresh unpredictable live lease token at each lifecycle boundary. */
export function workflowLeaseToken(
  cwd: string,
  sessionId: string,
  generation: number,
): string {
  return createHash("sha256")
    .update(`${cwd}\0${sessionId}\0${generation}\0${randomUUID()}`)
    .digest("hex");
}
