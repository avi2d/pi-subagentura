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

  it("enumerates runs safely and reports a torn tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "z-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.createRun({
      runId: "a-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("a-run", "task_done", { ok: true });
    await appendFile(
      join(root, "project", "session", "runs", "a-run", "events.ndjson"),
      "torn",
    );

    expect(await store.listRunIds()).toEqual(["a-run", "z-run"]);
    const log = await store.readEventLog("a-run");
    expect(log.events).toHaveLength(1);
    expect(log.tornTailBytes).toBe(4);
    expect(log.completeBytes + log.tornTailBytes).toBeGreaterThan(0);
  });

  it("truncates a torn tail before appending the next event", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    const first = await store.append("run", "task_done", { ok: true });
    await appendFile(
      join(root, "project", "session", "runs", "run", "events.ndjson"),
      '{"torn":',
    );

    const second = await store.append("run", "run_done", { ok: true });
    expect(second.startByte).toBe(first.endByte);
    expect(second.eventOrdinal).toBe(1);
    expect((await store.readRun("run")).events).toHaveLength(2);
    expect((await store.readEventLog("run")).tornTailBytes).toBe(0);
  });

  it("rejects stale epochs while allowing repeated events in the current epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });

    await store.append("run", "run_started", {}, 2);
    await store.append("run", "task_started", {}, 2);
    await expect(store.append("run", "stale", {}, 1)).rejects.toThrow(
      "stale run epoch",
    );
    await store.append("run", "run_resumed", {}, 3);
    await expect(store.append("run", "stale", {}, 2)).rejects.toThrow(
      "stale run epoch",
    );
  });
});
