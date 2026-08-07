import { mkdtemp, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("WorkflowRunStore", () => {
  it("uses byte offsets and complete-line ordinals for unicode events", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });

    const first = await store.append("run", "task_started", { prompt: "é" });
    const second = await store.append("run", "task_done", { ok: true });
    expect(first.eventOrdinal).toBe(0);
    expect(second.eventOrdinal).toBe(1);
    expect(second.startByte).toBe(first.endByte);
    expect(second.startByte).toBeGreaterThan(
      JSON.stringify({ prompt: "é" }).length,
    );
  });

  it("ignores an incomplete final line during recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "task_done", { ok: true });
    await appendFile(
      join(root, "project", "session", "runs", "run", "events.ndjson"),
      '{"torn":',
    );

    const record = await store.readRun("run");
    expect(record.events).toHaveLength(1);
  });
});
