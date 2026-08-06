import { homedir } from "node:os";
import type { WorkflowAgentRunner } from "./workflow-core";
import {
  DurableWorkflowPlanController,
  type DurableWorkflowPlanInterruptionReason,
  type DurableWorkflowPlanOpenResult,
} from "./workflow-durable-plan";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
  type WorkflowRunStoreOptions,
} from "./workflow-run-store";
import type { DurableWorkflowRunId } from "./workflow-run-types";
import type { SessionScope } from "./session-scope";

export type DurableWorkflowRunAgentFactory = (
  runId: DurableWorkflowRunId,
  context: DurableWorkflowSessionContext,
) => WorkflowAgentRunner;

export interface DurableWorkflowRuntimeOptions {
  readonly homeDir?: string;
  readonly storeOptions?: Omit<WorkflowRunStoreOptions, "homeDir">;
  readonly resolveRealPath?: (path: string) => Promise<string>;
}

export interface DurableWorkflowSessionContext {
  readonly cwd?: string;
  readonly sessionManager?: {
    getSessionId?: () => string;
  };
}

interface DurableWorkflowRegistration {
  readonly factory: DurableWorkflowRunAgentFactory;
  readonly options: DurableWorkflowRuntimeOptions;
}

interface DurableWorkflowRuntime {
  readonly controller: DurableWorkflowPlanController;
  openResult?: DurableWorkflowPlanOpenResult;
  stopping?: Promise<void>;
}

const registrations = new WeakMap<SessionScope, DurableWorkflowRegistration>();
const runtimes = new WeakMap<SessionScope, DurableWorkflowRuntime>();

export function registerDurableWorkflowRunAgentFactory(
  scope: SessionScope,
  factory: DurableWorkflowRunAgentFactory,
  options: DurableWorkflowRuntimeOptions = {},
): void {
  registrations.set(scope, { factory, options });
}

export function getDurableWorkflowPlanController(
  scope: SessionScope,
): DurableWorkflowPlanController | undefined {
  return runtimes.get(scope)?.controller;
}

export async function startDurableWorkflowSession(
  scope: SessionScope,
  eventReason: string,
  ctx: DurableWorkflowSessionContext,
): Promise<DurableWorkflowPlanOpenResult | undefined> {
  if (runtimes.has(scope)) {
    await stopDurableWorkflowSession(scope, "owner_replaced");
  }

  const registration = registrations.get(scope);
  const cwd = ctx.cwd;
  const piSessionId = sessionId(ctx);
  if (
    registration === undefined ||
    cwd === undefined ||
    piSessionId === undefined
  ) {
    return undefined;
  }

  let owner;
  try {
    owner = await deriveDurableWorkflowOwner(
      cwd,
      piSessionId,
      registration.options.resolveRealPath,
    );
  } catch {
    return undefined;
  }

  const store = new WorkflowRunStore({
    ...registration.options.storeOptions,
    homeDir: registration.options.homeDir ?? homedir(),
  });
  const controller = await DurableWorkflowPlanController.acquire({
    store,
    owner,
    scopeId: scope.id,
    generation: scope.generation,
    runAgentForRun: (runId) => registration.factory(runId, ctx),
  });
  const runtime: DurableWorkflowRuntime = { controller };
  runtimes.set(scope, runtime);

  if (!isRecoveryReason(eventReason)) return undefined;

  try {
    const openResult = await controller.open(eventReason);
    runtime.openResult = openResult;
    for (const execution of openResult.completions) {
      void execution.completion.catch(() => undefined);
    }
    return openResult;
  } catch (error) {
    runtimes.delete(scope);
    await controller.release().catch(() => undefined);
    throw error;
  }
}

export async function stopDurableWorkflowSession(
  scope: SessionScope,
  reason: string | undefined,
): Promise<void> {
  const runtime = runtimes.get(scope);
  if (runtime === undefined) return;
  if (runtime.stopping !== undefined) return runtime.stopping;

  const stopping = (async () => {
    let interruptionError: unknown;
    try {
      await runtime.controller.interrupt(interruptionReason(reason));
    } catch (error) {
      interruptionError = error;
    }

    try {
      await runtime.controller.release();
    } finally {
      if (runtimes.get(scope) === runtime) runtimes.delete(scope);
    }

    if (interruptionError !== undefined) throw interruptionError;
  })();
  runtime.stopping = stopping;
  return stopping;
}

function sessionId(ctx: DurableWorkflowSessionContext): string | undefined {
  try {
    const value = ctx.sessionManager?.getSessionId?.();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecoveryReason(
  reason: string,
): reason is "startup" | "reload" | "resume" {
  return reason === "startup" || reason === "reload" || reason === "resume";
}

function interruptionReason(
  reason: string | undefined,
): DurableWorkflowPlanInterruptionReason {
  if (reason === "reload" || reason === "resume") return "reload";
  if (reason === "quit") return "quit";
  if (reason === "owner_replaced" || reason === "new" || reason === "fork") {
    return "owner_replaced";
  }
  return "process_crash";
}
