import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enumerateRecoverableWorkflowRuns,
  recoverWorkflowRun,
} from "../src/workflow-recovery";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

const dirs: string[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease",
};

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workflow recovery projection", () => {
  it("folds committed task history without rerunning work", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "run_created", {});
    await store.append("run", "task_started", {
      taskId: "a",
      attempt: 1,
      phaseId: "p",
    });
    await store.append("run", "task_succeeded", {
      taskId: "a",
      attempt: 1,
      result: "ok",
    });
    await store.append("run", "run_interrupted", {});

    const projection = await recoverWorkflowRun({ store, owner }, "run");
    expect(projection.status).toBe("interrupted");
    expect(projection.tasks.a).toEqual({
      id: "a",
      status: "succeeded",
      attempt: 1,
      result: "ok",
    });
    expect(projection.lastEventOrdinal).toBe(3);
  });

  it("rejects another owner and enumerates only matching runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    const other = { ...owner, leaseToken: "other" };
    const otherStore = new WorkflowRunStore({ rootDir: root, owner: other });
    await otherStore.createRun({
      runId: "other",
      planRevision: 1,
      resumePolicy: "manual",
      owner: other,
    });

    expect(
      (await enumerateRecoverableWorkflowRuns({ store, owner })).map(
        (run) => run.runId,
      ),
    ).toEqual(["run"]);
    await expect(
      recoverWorkflowRun({ store, owner: other }, "run"),
    ).rejects.toThrow("different owner");
  });
});
