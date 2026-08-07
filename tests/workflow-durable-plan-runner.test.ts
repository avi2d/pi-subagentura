import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { runDurableWorkflowPlan } from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import type { WorkflowPlan } from "../src/workflow-plan";

const roots: string[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease",
};
const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "durable",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [
        { id: "a", prompt: "A" },
        { id: "b", prompt: "B" },
      ],
    },
  ],
};
const success = (output: string): SubagentResult => ({
  isError: false,
  output,
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
  },
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable sequential plan runner", () => {
  it("creates before dispatch and replays committed tasks after interruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const calls: string[] = [];
    let failOnce = true;

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "run",
        plan,
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          if (prompt === "B" && failOnce) {
            failOnce = false;
            throw new Error("parent died");
          }
          return success(`done:${prompt}`);
        },
      }),
    ).rejects.toThrow("parent died");

    const interrupted = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "run",
      plan,
      resume: false,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
    });
    expect(interrupted.status).toBe("interrupted");
    expect(calls).toEqual(["A", "B"]);

    const done = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "run",
      plan,
      resume: true,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
    });
    expect(done.status).toBe("done");
    expect(done.tasks.a).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(done.tasks.b).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(calls).toEqual(["A", "B", "B"]);
  });

  it("rejects resuming an existing run with a different plan revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "run",
      plan,
      runAgent: async () => success("done"),
    });

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "run",
        plan: { ...plan, schemaVersion: 2 } as unknown as WorkflowPlan,
        resume: true,
        runAgent: async () => success("must not run"),
      }),
    ).rejects.toThrow("Workflow plan revision mismatch");
  });

  it("publishes terminal projections for recovered and failed runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const statuses: string[] = [];

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "run",
      plan: {
        ...plan,
        phases: [{ ...plan.phases[0], tasks: [plan.phases[0].tasks[0]] }],
      },
      runAgent: async () => success("done"),
      onProjection: (projection) => statuses.push(projection.status),
    });

    expect(statuses.at(-1)).toBe("done");
    expect(statuses.length).toBeGreaterThan(0);
  });

  it("retains the terminal error envelope after task failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "failed-run",
      plan,
      runAgent: async () => ({
        isError: true as const,
        output: "",
        usage: success("ignored").usage,
        errorMessage: "provider failed",
      }),
    });

    expect(result.status).toBe("error");
    expect(result.terminal).toEqual({
      status: "error",
      error: { code: "task_failed", message: "provider failed" },
    });
  });

  it("commits cancellation as a terminal result before returning", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const signal = new AbortController();
    signal.abort();

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "cancelled-run",
      plan,
      signal: signal.signal,
      runAgent: async () => {
        throw new Error("must not dispatch");
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.terminal).toMatchObject({ status: "cancelled" });
  });

  it("commits cancellation when an active task observes an aborted signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const controller = new AbortController();

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "cancelled-during-task",
      plan,
      signal: controller.signal,
      runAgent: async ({ signal }) => {
        controller.abort();
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) {
            reject(new Error("agent aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new Error("agent aborted")),
            { once: true },
          );
        });
        throw new Error("must not complete");
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.terminal).toMatchObject({ status: "cancelled" });
  });

  it("rejects an invalid plan before creating a durable run", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const invalidPlan = {
      ...plan,
      phases: [{ ...plan.phases[0], tasks: [{ id: "bad/id", prompt: "bad" }] }],
    } as WorkflowPlan;

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "invalid-run",
        plan: invalidPlan,
        runAgent: async () => {
          throw new Error("must not dispatch");
        },
      }),
    ).rejects.toThrow("Invalid or duplicate task id");
    await expect(store.listRunIds()).resolves.toEqual([]);
  });

  it("rejects an invalid plan before recovering an existing run", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "existing-run",
      plan,
      runAgent: async () => success("done"),
    });

    const invalidPlan = {
      ...plan,
      phases: [{ ...plan.phases[0], tasks: [{ id: "bad/id", prompt: "bad" }] }],
    } as WorkflowPlan;
    const calls: string[] = [];

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "existing-run",
        plan: invalidPlan,
        resume: true,
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          return success("must not run");
        },
      }),
    ).rejects.toThrow("Invalid or duplicate task id");
    expect(calls).toEqual([]);
  });

  it("persists the requested resume policy in the launch snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "auto-resume-run",
      plan: {
        ...plan,
        phases: [{ ...plan.phases[0], tasks: [plan.phases[0].tasks[0]] }],
      },
      resumePolicy: "on-session-start",
      runAgent: async () => success("done"),
    });

    const record = await store.readRun("auto-resume-run");
    expect(record.launch.resumePolicy).toBe("on-session-start");
  });

  it("executes parallel siblings once and folds their usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const calls: string[] = [];

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-run",
      plan: {
        ...plan,
        phases: [
          {
            id: "parallel",
            mode: "parallel",
            tasks: [
              { id: "a", prompt: "A" },
              { id: "b", prompt: "B" },
              { id: "c", prompt: "C" },
            ],
          },
        ],
      },
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
    });

    expect(result.status).toBe("done");
    expect(calls.sort()).toEqual(["A", "B", "C"]);
    expect(result.tasks.a.status).toBe("succeeded");
    expect(result.tasks.b.status).toBe("succeeded");
    expect(result.tasks.c.status).toBe("succeeded");
    expect(result.usage).toEqual({ input: 3, output: 6 });
  });

  it("commits cancellation when a parallel task observes an aborted signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const controller = new AbortController();

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-cancelled-run",
      plan: {
        ...plan,
        phases: [
          {
            id: "parallel",
            mode: "parallel",
            tasks: [
              { id: "a", prompt: "A" },
              { id: "b", prompt: "B" },
            ],
          },
        ],
      },
      signal: controller.signal,
      runAgent: async ({ signal }) => {
        controller.abort();
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) {
            reject(new Error("agent aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new Error("agent aborted")),
            { once: true },
          );
        });
        throw new Error("must not complete");
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.terminal).toMatchObject({ status: "cancelled" });
  });
});
