import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { DurableWorkflowPlanController } from "../src/workflow-durable-plan";
import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
} from "../src/workflow-plan";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
} from "../src/workflow-run-store";
import {
  createDurableWorkflowRunId,
  type DurableWorkflowOwner,
} from "../src/workflow-run-types";

function success(
  output: string,
  input = 0,
  outputTokens = 0,
): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: {
      input,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function sequentialPlan(isolation?: string): WorkflowPlanDefinition {
  return validateWorkflowPlan({
    name: "durable-preview",
    description: "sequential durable plan",
    phases: [
      {
        id: "phase-a",
        name: "Phase A",
        mode: "sequence",
        tasks: [
          {
            id: "task-a",
            content: "Task A",
            instruction: "run-a",
            ...(isolation === undefined ? {} : { agent: { isolation } }),
          },
          {
            id: "task-b",
            content: "Task B",
            instruction: "run-b",
          },
        ],
      },
    ],
  });
}

function parallelPlan(): WorkflowPlanDefinition {
  return validateWorkflowPlan({
    name: "parallel-preview",
    description: "unsupported parallel plan",
    phases: [
      {
        id: "parallel",
        name: "Parallel",
        mode: "parallel",
        tasks: [{ id: "task-a", content: "Task A", instruction: "run-a" }],
      },
    ],
  });
}

describe("DurableWorkflowPlanController", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;
  let processNumber: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-durable-plan-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "pi-session-a");
    processNumber = 100;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function store(
    sync?: ConstructorParameters<typeof WorkflowRunStore>[0]["sync"],
  ): WorkflowRunStore {
    processNumber++;
    return new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: processNumber,
        processStartIdentity: `process-${processNumber}`,
      },
      sync,
    });
  }

  async function controller(
    runStore: WorkflowRunStore,
    runner: WorkflowAgentRunner,
    generation = 1,
  ): Promise<DurableWorkflowPlanController> {
    return DurableWorkflowPlanController.acquire({
      store: runStore,
      owner,
      scopeId: generation,
      generation,
      runAgentForRun: () => runner,
    });
  }

  it("syncs run creation before runner work and keeps terminal results queryable", async () => {
    const runStore = store();
    const runId = createDurableWorkflowRunId("created-before-runner");
    const observed: Array<{
      prompt: string;
      isolation: string | undefined;
      firstEvent: string | undefined;
    }> = [];
    const runner: WorkflowAgentRunner = async ({ prompt, isolation }) => {
      const events = await (await runStore.openRun(owner, runId)).readEvents();
      observed.push({ prompt, isolation, firstEvent: events[0]?.type });
      return success(`done:${prompt}`, 2, 1);
    };
    const durable = await controller(runStore, runner);

    const handle = await durable.startPlan({
      runId,
      plan: sequentialPlan(),
      resumePolicy: "trusted_resume",
    });
    const result = await handle.completion;

    expect(observed).toEqual([
      { prompt: "run-a", isolation: "in-process", firstEvent: "run_created" },
      { prompt: "run-b", isolation: "in-process", firstEvent: "run_created" },
    ]);
    expect(result.status).toBe("done");
    expect(result.result.map((task) => task.output)).toEqual([
      "done:run-a",
      "done:run-b",
    ]);
    expect(await durable.getProjection(runId)).toMatchObject({
      status: "done",
      terminal: { status: "done" },
      accounting: {
        completeness: "exact",
        usage: { input: 4, output: 2 },
      },
    });
    expect(await durable.getResult(runId)).toMatchObject({
      status: "done",
      result: [
        { id: "task-a", output: "done:run-a" },
        { id: "task-b", output: "done:run-b" },
      ],
    });
    await expect(
      durable.trustedResume(runId, { trustedActorId: "human-a" }),
    ).rejects.toMatchObject({ code: "terminal_run" });
    await durable.release();

    const reopened = await controller(
      store(),
      async () => {
        throw new Error("terminal query must not run agents");
      },
      2,
    );
    const opened = await reopened.open("startup");
    expect(opened.completions).toEqual([]);
    expect(await reopened.getProjection(runId)).toMatchObject({
      status: "done",
    });
    expect(await reopened.getResult(runId)).toMatchObject({ status: "done" });
    await reopened.release();
  });

  it("rejects parallel and process-isolated plans before creating or dispatching", async () => {
    const runStore = store();
    let calls = 0;
    const durable = await controller(runStore, async () => {
      calls++;
      return success("unexpected");
    });

    await expect(
      durable.startPlan({ plan: parallelPlan() }),
    ).rejects.toMatchObject({ code: "invalid_plan" });
    await expect(
      durable.startPlan({ plan: sequentialPlan("process") }),
    ).rejects.toMatchObject({ code: "invalid_plan" });
    expect(calls).toBe(0);
    expect(await runStore.listRunIds(owner)).toEqual([]);
    await durable.release();
  });

  it("requires trusted startup resume, replays committed A, retries B, and does not double usage", async () => {
    let failNextEventSync = false;
    const firstStore = store({
      file: async (handle, purpose) => {
        await handle.sync();
        if (purpose === "events" && failNextEventSync) {
          failNextEventSync = false;
          throw new Error("injected event sync failure");
        }
      },
    });
    const runId = createDurableWorkflowRunId("resume-two-tasks");
    const firstCalls: string[] = [];
    const first = await controller(firstStore, async ({ prompt }) => {
      firstCalls.push(prompt);
      if (prompt === "run-b") failNextEventSync = true;
      return prompt === "run-a"
        ? success("committed-a", 5, 3)
        : success("uncommitted-b");
    });

    const initial = await first.startPlan({
      runId,
      plan: sequentialPlan(),
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await expect(initial.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    expect(firstCalls).toEqual(["run-a", "run-b"]);
    await first.release();

    const resumedCalls: string[] = [];
    const second = await controller(
      store(),
      async ({ prompt }) => {
        resumedCalls.push(prompt);
        return success("retried-b", 2, 1);
      },
      2,
    );
    const startup = await second.open("startup");
    expect(startup.completions).toEqual([]);
    expect(startup.recovery.runs[0]).toMatchObject({
      interrupted: true,
      trustedResumeRequired: true,
      automaticResumeEligible: false,
    });
    expect(resumedCalls).toEqual([]);

    await expect(
      second.trustedResume(runId, { trustedActorId: "" }),
    ).rejects.toMatchObject({ code: "trusted_resume_required" });
    await expect(
      second.trustedResume(runId, {
        trustedActorId: "human-a",
        expectedOwner: { ...owner, piSessionKey: "another-session" },
      }),
    ).rejects.toMatchObject({ code: "wrong_owner" });
    const interrupted = await second.getProjection(runId);
    if (interrupted === undefined)
      throw new Error("missing recovered projection");
    await expect(
      second.trustedResume(runId, {
        trustedActorId: "human-a",
        expectedRunEpoch: interrupted.runEpoch + 1,
      }),
    ).rejects.toMatchObject({ code: "epoch_mismatch" });

    const resumed = await second.trustedResume(runId, {
      trustedActorId: "human-a",
      expectedOwner: owner,
      expectedRunEpoch: interrupted.runEpoch,
    });
    await resumed.completion;

    expect(resumedCalls).toEqual(["run-b"]);
    const projection = await second.getProjection(runId);
    expect(projection).toMatchObject({
      status: "done",
      accounting: {
        completeness: "lower_bound",
        usage: { input: 7, output: 4 },
      },
    });
    const operationA = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-a",
    );
    const operationB = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-b",
    );
    expect(operationA?.attempts).toHaveLength(1);
    expect(operationA?.replays).toHaveLength(1);
    expect(operationB?.attempts).toHaveLength(2);
    expect(
      operationB?.attempts.map((attempt) => attempt.attempt.attemptNumber),
    ).toEqual([1, 2]);
    await second.release();
  });

  it("automatically continues reload-eligible runs and exposes their completion", async () => {
    const runId = createDurableWorkflowRunId("automatic-reload");
    const firstStore = store();
    let markTaskBStarted!: () => void;
    const taskBStarted = new Promise<void>((resolve) => {
      markTaskBStarted = resolve;
    });
    const first = await controller(firstStore, async ({ prompt, signal }) => {
      if (prompt === "run-a") return success("committed-a", 3, 1);
      markTaskBStarted();
      return new Promise<SubagentResult>((resolve) => {
        const cancelled = () =>
          resolve({ ...success("interrupted-b"), cancelled: true });
        if (signal?.aborted) cancelled();
        else signal?.addEventListener("abort", cancelled, { once: true });
      });
    });
    const initial = await first.startPlan({
      runId,
      plan: sequentialPlan(),
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await taskBStarted;
    const interruption = first.interrupt("reload", runId);
    await expect(initial.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await interruption;
    await first.release();

    const reloadCalls: string[] = [];
    const second = await controller(
      store(),
      async ({ prompt }) => {
        reloadCalls.push(prompt);
        return success("fresh-b", 1, 1);
      },
      2,
    );
    const opened = await second.open("reload");
    expect(opened.completions).toHaveLength(1);
    expect(opened.completions[0]?.runId).toBe(runId);
    await opened.completions[0]?.completion;
    expect(reloadCalls).toEqual(["run-b"]);
    expect(await second.getProjection(runId)).toMatchObject({ status: "done" });
    await second.release();
  });

  it("aborts active model work and leaves the attempt retryable on interruption", async () => {
    const runId = createDurableWorkflowRunId("interrupt-active");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const active = await controller(store(), async ({ signal }) => {
      markStarted();
      return new Promise<SubagentResult>((resolve) => {
        const cancelled = () =>
          resolve({
            ...success("interrupted"),
            cancelled: true,
          });
        if (signal?.aborted) cancelled();
        else signal?.addEventListener("abort", cancelled, { once: true });
      });
    });
    const execution = await active.startPlan({
      runId,
      plan: sequentialPlan(),
    });
    await started;

    const interruption = active.interrupt("reload", runId);
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await interruption;

    const projection = await active.getProjection(runId);
    expect(projection).toMatchObject({ status: "interrupted" });
    expect(projection?.operations[0]?.settlement).toBeUndefined();
    expect(projection?.operations[0]?.attempts[0]).toMatchObject({
      status: "interrupted",
    });
    await active.release();
  });
});
