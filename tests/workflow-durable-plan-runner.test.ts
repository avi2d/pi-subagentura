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
});
