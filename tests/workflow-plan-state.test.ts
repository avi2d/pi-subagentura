import { describe, expect, it } from "vitest";
import {
  createWorkflowPlanState,
  reduceWorkflowPlanState,
} from "../src/workflow-plan-state";
import type { WorkflowPlan } from "../src/workflow-plan";

const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "state",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [{ id: "task", prompt: "work" }],
    },
  ],
};

describe("workflow plan state transitions", () => {
  it("supports blocking, unblocking, and skipping pending work", () => {
    const created = createWorkflowPlanState(plan);
    const blocked = reduceWorkflowPlanState(created, {
      type: "block",
      taskId: "task",
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      tasks: { task: "blocked" },
    });

    const unblocked = reduceWorkflowPlanState(blocked, {
      type: "unblock",
      taskId: "task",
    });
    expect(unblocked).toMatchObject({
      status: "running",
      tasks: { task: "pending" },
    });

    const skipped = reduceWorkflowPlanState(unblocked, {
      type: "skip",
      taskId: "task",
    });
    expect(skipped).toMatchObject({
      status: "done",
      tasks: { task: "skipped" },
    });
  });

  it("keeps terminal task and run state immutable", () => {
    const created = createWorkflowPlanState(plan);
    const running = reduceWorkflowPlanState(created, {
      type: "start",
      taskId: "task",
      phaseId: "phase",
    });
    const done = reduceWorkflowPlanState(running, {
      type: "succeed",
      taskId: "task",
    });

    expect(reduceWorkflowPlanState(done, { type: "cancel" })).toBe(done);
    expect(() =>
      reduceWorkflowPlanState(done, {
        type: "start",
        taskId: "task",
        phaseId: "phase",
      }),
    ).toThrow("cannot start");
  });
});
