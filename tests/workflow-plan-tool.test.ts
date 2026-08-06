import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  clearSessionScopes,
  setLegacyActiveSessionRefs,
  type SessionOwnerToken,
} from "../src/session-scope";
import type { WorkflowPlanDefinition } from "../src/workflow-plan";

const {
  mockAwaitInteractiveResult,
  mockLaunchInteractiveSubagent,
  mockLoadWorkflowScript,
} = vi.hoisted(() => ({
  mockAwaitInteractiveResult: vi.fn(),
  mockLaunchInteractiveSubagent: vi.fn(),
  mockLoadWorkflowScript: vi.fn(),
}));

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    launchInteractiveSubagent: mockLaunchInteractiveSubagent,
  };
});

vi.mock("../src/workflow-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/workflow-worker")>();
  return { ...actual, awaitInteractiveResult: mockAwaitInteractiveResult };
});

vi.mock("../src/workflow-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workflow-core")>();
  return { ...actual, loadWorkflowScript: mockLoadWorkflowScript };
});

import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import {
  MAX_WORKFLOW_JOBS,
  getWorkflowJobForOwner,
  startWorkflowPlanJob,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import { registerWorkflowTool } from "../src/workflow-tool";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

const BASE_PLAN: WorkflowPlanDefinition = {
  name: "preview",
  description: "Two-phase declarative preview",
  phases: [
    {
      id: "discover",
      name: "Discover",
      mode: "sequence",
      tasks: [
        {
          id: "inspect",
          content: "Inspect inputs",
          instruction: "inspect the inputs",
        },
      ],
    },
    {
      id: "review",
      name: "Review",
      mode: "sequence",
      tasks: [
        {
          id: "review-result",
          content: "Review result",
          instruction: "review the result",
        },
      ],
    },
  ],
};

const LEGACY_SCRIPT = (name: string) =>
  `export const meta = { name: "${name}", description: "legacy" };\n` +
  'return await agent("legacy task", { label: "legacy" });';

function successfulResult(output: string): SubagentResult {
  return {
    isError: false,
    output,
    usage: { ...ZERO_USAGE, input: 2, output: 3, turns: 1 },
    model: "test/model",
  };
}

function failedResult(message: string): SubagentResult {
  return {
    isError: true,
    output: "",
    errorMessage: message,
    usage: { ...ZERO_USAGE, input: 1, output: 1, turns: 1 },
  };
}

function cancelledResult(): SubagentResult {
  return {
    isError: false,
    output: "",
    cancelled: true,
    usage: { ...ZERO_USAGE },
  };
}

function makePi() {
  const tools = new Map<string, any>();
  const pi = {
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    sendMessage: vi.fn(),
  };
  registerWorkflowTool(pi as never);
  return { pi, tools };
}

function toolContext() {
  return { cwd: "/tmp", model: "test/model", modelRegistry: {} };
}

function runningScriptJob(
  id: string,
  owner: SessionOwnerToken,
): WorkflowJobState {
  return {
    id,
    kind: "script",
    name: id,
    status: "running",
    startedAt: Date.now(),
    promise: new Promise<never>(() => {}),
    abort: new AbortController(),
    parentSessionOwner: owner,
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      phases: [],
    },
  };
}

describe("declarative workflow tool preview", () => {
  beforeEach(() => {
    clearSessionScopes();
    setLegacyActiveSessionRefs(undefined);
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
    mockLoadWorkflowScript.mockReset();
    mockLoadWorkflowScript.mockReturnValue(null);
    mockAwaitInteractiveResult.mockReset();
    mockAwaitInteractiveResult.mockImplementation(async (state: any) =>
      successfulResult(`completed: ${state.task}`),
    );
    let childId = 0;
    mockLaunchInteractiveSubagent.mockReset();
    mockLaunchInteractiveSubagent.mockImplementation((params: any) => ({
      id: `plan-child-${++childId}`,
      name: params.name,
      task: params.task,
      paneId: `%${childId}`,
      mux: "tmux",
      sessionFile: `/tmp/plan-child-${childId}.jsonl`,
      cwd: "/tmp",
      startedAt: Date.now(),
      status: "running",
      attachCommand: "attach",
      selectPaneCommand: "select",
      launchScriptFile: `/tmp/plan-child-${childId}.sh`,
      artifactDir: `/tmp/plan-child-${childId}`,
      supervisorOwner: params.supervisorOwner,
      workflowId: params.workflowId,
      completionOwner: params.completionOwner,
    }));
  });

  afterEach(() => {
    for (const job of workflowJobRegistry.values()) job.abort.abort();
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
  });

  it("publishes an exact nested plan schema with no unknown object fields", () => {
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const parameters = workflow.parameters as any;
    const plan = parameters.properties.plan;
    const phase = plan.properties.phases.items;
    const task = phase.properties.tasks.items;

    expect(parameters.additionalProperties).toBe(false);
    expect(plan.additionalProperties).toBe(false);
    expect(phase.additionalProperties).toBe(false);
    expect(task.additionalProperties).toBe(false);
    expect(task.properties.agent.additionalProperties).toBe(false);
    expect(parameters.properties.durable.type).toBe("boolean");
  });

  it("requires exactly one of script, name, and plan before loading or dispatching", async () => {
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const script = LEGACY_SCRIPT("conflict");

    for (const params of [
      {},
      { script, name: "saved" },
      { script, plan: BASE_PLAN },
      { name: "saved", plan: BASE_PLAN },
    ]) {
      const result = await workflow.execute(
        "invalid-input",
        params,
        undefined,
        vi.fn(),
        toolContext(),
      );
      expect(result.isError).toBe(true);
      expect(result.details.error).toContain("exactly one");
    }

    expect(mockLoadWorkflowScript).not.toHaveBeenCalled();
    expect(mockLaunchInteractiveSubagent).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
  });

  it("rejects invalid, unknown, runtime, and durable plan fields before runner work", async () => {
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const duplicateTaskPlan = {
      ...BASE_PLAN,
      phases: BASE_PLAN.phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((task) => ({ ...task, id: "duplicate" })),
      })),
    };
    const runtimePlan = {
      ...BASE_PLAN,
      phases: [
        {
          ...BASE_PLAN.phases[0]!,
          tasks: [
            {
              ...BASE_PLAN.phases[0]!.tasks[0],
              runtime: { retries: 3 },
            },
          ],
        },
      ],
    };

    for (const params of [
      { plan: duplicateTaskPlan },
      { plan: { ...BASE_PLAN, unknown: true } },
      { plan: runtimePlan },
      { plan: BASE_PLAN, durable: true },
    ]) {
      const result = await workflow.execute(
        "invalid-plan",
        params,
        undefined,
        vi.fn(),
        toolContext(),
      );
      expect(result.isError).toBe(true);
    }

    expect(mockLaunchInteractiveSubagent).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
  });

  it("starts plans asynchronously by default and exposes bounded status/result projections", async () => {
    const secretOutput = `SECRET-${"x".repeat(1_000)}`;
    let release!: (result: SubagentResult) => void;
    mockAwaitInteractiveResult.mockImplementationOnce(
      () =>
        new Promise<SubagentResult>((resolve) => {
          release = resolve;
        }),
    );
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const started = await workflow.execute(
      "async-plan",
      { plan: BASE_PLAN },
      undefined,
      vi.fn(),
      toolContext(),
    );

    expect(started.details).toMatchObject({
      status: "started",
      kind: "plan",
      name: "preview",
    });
    expect(started.details.workflowId).toMatch(/^wf_[0-9a-f]{10}$/);
    const job = workflowJobRegistry.get(started.details.workflowId)!;
    expect(job.kind).toBe("plan");
    expect(job.planProjection).toBeDefined();

    await vi.waitFor(() =>
      expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1),
    );
    const running = await tools
      .get("get_workflow_status")
      .execute("status", { workflowId: job.id });
    expect(running.details).toMatchObject({
      status: "running",
      kind: "plan",
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "running" }),
        ]),
      },
    });

    release(successfulResult(secretOutput));
    await vi.waitFor(() =>
      expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(2),
    );
    const result = await tools
      .get("get_workflow_result")
      .execute("result", { workflowId: job.id });
    expect(result.details).toMatchObject({
      status: "done",
      kind: "plan",
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "succeeded" }),
          expect.objectContaining({
            taskId: "review-result",
            status: "succeeded",
          }),
        ]),
      },
    });
    expect(JSON.stringify(result.details.planProjection)).not.toContain(
      "SECRET",
    );
    expect(result.content[0].text).toContain(secretOutput);
  });

  it("streams synchronous plan progress and returns the final task results", async () => {
    const onUpdate = vi.fn();
    const { tools } = makePi();
    const result = await tools
      .get("workflow")
      .execute(
        "sync-plan",
        { plan: BASE_PLAN, async: false },
        undefined,
        onUpdate,
        toolContext(),
      );

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      status: "done",
      kind: "plan",
      agentsSpawned: 2,
      errorCount: 0,
      phases: ["discover", "review"],
    });
    expect(result.content[0].text).toContain("completed: inspect the inputs");
    expect(onUpdate).toHaveBeenCalled();
    expect(
      onUpdate.mock.calls.some(
        ([update]) =>
          update.details.kind === "plan" && update.details.status === "running",
      ),
    ).toBe(true);
    expect(
      [...workflowJobRegistry.values()].some((job) => job.name === "preview"),
    ).toBe(false);
  });

  it("projects coordinator-owned agent failure and stops later phases", async () => {
    mockAwaitInteractiveResult.mockResolvedValueOnce(
      failedResult("agent boom"),
    );
    const { tools } = makePi();
    const result = await tools
      .get("workflow")
      .execute(
        "failed-plan",
        { plan: BASE_PLAN, async: false },
        undefined,
        vi.fn(),
        toolContext(),
      );

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      status: "error",
      kind: "plan",
      errorCount: 1,
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "failed" }),
          expect.objectContaining({
            taskId: "review-result",
            status: "cancelled",
          }),
        ]),
      },
    });
    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
  });

  it("uses the shared cancellation lifecycle for a running plan", async () => {
    mockAwaitInteractiveResult.mockImplementation(
      (_state: unknown, signal: AbortSignal) =>
        new Promise<SubagentResult>((resolve) => {
          if (signal.aborted) resolve(cancelledResult());
          else
            signal.addEventListener("abort", () => resolve(cancelledResult()), {
              once: true,
            });
        }),
    );
    const { tools } = makePi();
    const started = await tools
      .get("workflow")
      .execute(
        "cancel-plan",
        { plan: BASE_PLAN },
        undefined,
        vi.fn(),
        toolContext(),
      );
    const workflowId = started.details.workflowId;
    await vi.waitFor(() =>
      expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1),
    );

    const cancelled = await tools
      .get("cancel_workflow")
      .execute("cancel", { workflowId });
    expect(cancelled.details).toMatchObject({
      status: "cancelled",
      workflowId,
      cancelled: true,
    });
    await workflowJobRegistry.get(workflowId)!.promise;
    const status = await tools
      .get("get_workflow_status")
      .execute("status", { workflowId });
    expect(status.details).toMatchObject({
      status: "cancelled",
      kind: "plan",
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "cancelled" }),
          expect.objectContaining({
            taskId: "review-result",
            status: "cancelled",
          }),
        ]),
      },
    });
  });

  it("shares the script job cap and owner fences", async () => {
    const ownerA = { id: 41, generation: 1 };
    const ownerB = { id: 42, generation: 1 };
    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      const job = runningScriptJob(`script-${index}`, ownerA);
      workflowJobRegistry.set(job.id, job);
    }
    const runner = vi.fn(async () => successfulResult("never"));

    expect(() =>
      startWorkflowPlanJob(
        BASE_PLAN,
        { runAgent: runner },
        undefined,
        undefined,
        ownerA,
      ),
    ).toThrow(/workflow jobs already running/);
    expect(runner).not.toHaveBeenCalled();

    workflowJobRegistry.clear();
    const job = startWorkflowPlanJob(
      BASE_PLAN,
      { runAgent: runner },
      undefined,
      undefined,
      ownerA,
    );
    expect(getWorkflowJobForOwner(job.id, ownerA)).toBe(job);
    expect(getWorkflowJobForOwner(job.id, ownerB)).toBeUndefined();
    await job.promise;
  });

  it("keeps legacy script and saved-name call results unchanged", async () => {
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const scriptResult = await workflow.execute(
      "legacy-script",
      { script: LEGACY_SCRIPT("legacy-script"), async: false },
      undefined,
      vi.fn(),
      toolContext(),
    );
    expect(scriptResult.details).toMatchObject({
      status: "done",
      name: "legacy-script",
      agentsSpawned: 1,
    });
    expect(scriptResult.details).not.toHaveProperty("kind");

    mockLoadWorkflowScript.mockReturnValue(LEGACY_SCRIPT("legacy-name"));
    const nameResult = await workflow.execute(
      "legacy-name",
      { name: "saved", async: false },
      undefined,
      vi.fn(),
      toolContext(),
    );
    expect(mockLoadWorkflowScript).toHaveBeenCalledWith("saved");
    expect(nameResult.details).toMatchObject({
      status: "done",
      name: "legacy-name",
      agentsSpawned: 1,
    });
    expect(nameResult.details).not.toHaveProperty("kind");
  });
});
