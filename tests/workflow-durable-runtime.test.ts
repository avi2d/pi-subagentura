import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobState, SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import {
  getDurableWorkflowPlanController,
  registerDurableWorkflowRunAgentFactory,
  startDurableWorkflowSession,
  stopDurableWorkflowSession,
} from "../src/workflow-durable-runtime";
import { validateWorkflowPlan } from "../src/workflow-plan";
import { registerSessionHandlers } from "../src/session-handlers";
import {
  clearSessionScopes,
  createSessionScope,
  type SessionScope,
} from "../src/session-scope";

function success(output: string): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

const plan = validateWorkflowPlan({
  name: "runtime-recovery",
  description: "durable runtime lifecycle coverage",
  phases: [
    {
      id: "phase-a",
      name: "Phase A",
      mode: "sequence",
      tasks: [
        { id: "task-a", content: "Task A", instruction: "run-a" },
        { id: "task-b", content: "Task B", instruction: "run-b" },
      ],
    },
  ],
});

interface TestSessionContext {
  readonly cwd: string;
  readonly ui?: {
    setStatus: (...args: unknown[]) => unknown;
    setWidget: (...args: unknown[]) => unknown;
    notify: (...args: unknown[]) => unknown;
  };
  readonly sessionManager?: {
    getSessionId?: () => string;
    getEntries?: () => unknown[];
  };
}

type CapturedHandler = (...args: unknown[]) => unknown;

function createLifecycleHarness(): {
  readonly handlers: Map<string, CapturedHandler[]>;
  readonly scope: SessionScope;
} {
  const handlers = new Map<string, CapturedHandler[]>();
  const pi = {
    on: (name: string, handler: CapturedHandler) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { handlers, scope: registerSessionHandlers(pi) };
}

function manualScope(): SessionScope {
  const scope = createSessionScope({} as unknown as ExtensionAPI);
  scope.generation = 1;
  return scope;
}

function context(cwd: string, sessionId?: string): TestSessionContext {
  return {
    cwd,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    sessionManager:
      sessionId === undefined
        ? {}
        : { getSessionId: () => sessionId, getEntries: () => [] },
  };
}

describe("durable workflow session runtime", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    home = mkdtempSync(join(tmpdir(), "workflow-durable-runtime-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    clearSessionScopes();
    const globalState = globalThis as typeof globalThis & {
      __piSubagenturaInteractivePollerHandle?: NodeJS.Timeout;
    };
    globalState.__piSubagenturaInteractivePollerHandle = undefined;
  });

  afterEach(() => {
    const globalState = globalThis as typeof globalThis & {
      __piSubagenturaInteractivePollerHandle?: NodeJS.Timeout;
    };
    clearInterval(globalState.__piSubagenturaInteractivePollerHandle);
    clearSessionScopes();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it("opens same-owner reload recovery and automatically resumes eligible work", async () => {
    const scope = manualScope();
    const ctx = context(cwd, "pi-session-a");
    let markTaskBStarted!: () => void;
    const taskBStarted = new Promise<void>((resolve) => {
      markTaskBStarted = resolve;
    });
    const firstRunner: WorkflowAgentRunner = async ({ prompt, signal }) => {
      if (prompt === "run-a") return success("committed-a");
      markTaskBStarted();
      return new Promise<SubagentResult>((resolve) => {
        const interrupted = () =>
          resolve({ ...success("interrupted-b"), cancelled: true });
        if (signal?.aborted) interrupted();
        else signal?.addEventListener("abort", interrupted, { once: true });
      });
    };
    registerDurableWorkflowRunAgentFactory(scope, () => firstRunner, {
      homeDir: home,
    });

    await startDurableWorkflowSession(scope, "startup", ctx);
    const first = getDurableWorkflowPlanController(scope);
    expect(first).toBeDefined();
    const execution = await first!.startPlan({
      plan,
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await taskBStarted;

    const stopping = stopDurableWorkflowSession(scope, "reload");
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await stopping;

    const reloadCalls: string[] = [];
    const reloadRunner: WorkflowAgentRunner = async ({ prompt }) => {
      reloadCalls.push(prompt);
      return success("recovered-b");
    };
    scope.generation++;
    registerDurableWorkflowRunAgentFactory(scope, () => reloadRunner, {
      homeDir: home,
    });
    const opened = await startDurableWorkflowSession(scope, "reload", ctx);

    expect(opened?.recovery.runs.map((run) => run.runId)).toContain(
      execution.runId,
    );
    expect(opened?.completions).toHaveLength(1);
    expect(opened?.completions[0]?.runId).toBe(execution.runId);
    await opened?.completions[0]?.completion;
    expect(reloadCalls).toEqual(["run-b"]);
    expect(
      await getDurableWorkflowPlanController(scope)?.getProjection(
        execution.runId,
      ),
    ).toMatchObject({ status: "done" });
    await stopDurableWorkflowSession(scope, "quit");
  });

  it("does not recover on new or fork and never crosses a wrong or missing identity", async () => {
    const scope = manualScope();
    const ownerContext = context(cwd, "pi-session-a");
    const runner: WorkflowAgentRunner = async ({ prompt }) => success(prompt);
    registerDurableWorkflowRunAgentFactory(scope, () => runner, {
      homeDir: home,
    });
    await startDurableWorkflowSession(scope, "startup", ownerContext);
    const initial = getDurableWorkflowPlanController(scope);
    const initialOwner = initial!.owner;
    const completed = await initial!.startPlan({ plan });
    await completed.completion;
    await stopDurableWorkflowSession(scope, "quit");

    for (const reason of ["new", "fork"] as const) {
      scope.generation++;
      const opened = await startDurableWorkflowSession(
        scope,
        reason,
        ownerContext,
      );
      expect(opened).toBeUndefined();
      expect(
        await getDurableWorkflowPlanController(scope)?.getProjection(
          completed.runId,
        ),
      ).toBeUndefined();
      await stopDurableWorkflowSession(scope, "owner_replaced");
    }

    scope.generation++;
    const wrongIdentity = context(cwd, "pi-session-b");
    const wrongOpened = await startDurableWorkflowSession(
      scope,
      "reload",
      wrongIdentity,
    );
    expect(wrongOpened?.recovery.runs).toEqual([]);
    expect(getDurableWorkflowPlanController(scope)?.owner).not.toEqual(
      initialOwner,
    );
    expect(
      await getDurableWorkflowPlanController(scope)?.getProjection(
        completed.runId,
      ),
    ).toBeUndefined();
    await stopDurableWorkflowSession(scope, "quit");

    scope.generation++;
    expect(
      await startDurableWorkflowSession(scope, "reload", context(cwd)),
    ).toBeUndefined();
    expect(getDurableWorkflowPlanController(scope)).toBeUndefined();
  });

  it("session shutdown interrupts and releases durable work before ordinary cleanup", async () => {
    const { handlers, scope } = createLifecycleHarness();
    const ctx = context(cwd, "pi-session-a");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let sawOrdinaryStateAtInterruption = false;
    const runner: WorkflowAgentRunner = async ({ signal }) => {
      markStarted();
      return new Promise<SubagentResult>((resolve) => {
        const interrupted = () => {
          sawOrdinaryStateAtInterruption = scope.inProcessJobs.has("sentinel");
          resolve({ ...success("interrupted"), cancelled: true });
        };
        if (signal?.aborted) interrupted();
        else signal?.addEventListener("abort", interrupted, { once: true });
      });
    };
    registerDurableWorkflowRunAgentFactory(scope, () => runner, {
      homeDir: home,
    });
    await handlers.get("session_start")![0]({ reason: "new" }, ctx);

    const controller = getDurableWorkflowPlanController(scope)!;
    const interrupt = vi.spyOn(controller, "interrupt");
    const release = vi.spyOn(controller, "release");
    // The fixture only needs an owned row whose removal is observable.
    scope.inProcessJobs.set("sentinel", {
      id: "sentinel",
      status: "done",
    } as unknown as JobState);
    const execution = await controller.startPlan({ plan });
    await started;
    const completion = expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });

    await handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
    await completion;

    expect(sawOrdinaryStateAtInterruption).toBe(true);
    expect(scope.inProcessJobs.size).toBe(0);
    expect(interrupt).toHaveBeenCalledWith("quit");
    expect(interrupt.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
    expect(getDurableWorkflowPlanController(scope)).toBeUndefined();
    expect(scope.lifecycle).toBe("shutdown");
  });
});
