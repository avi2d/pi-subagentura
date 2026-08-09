import { appendFileSync, mkdirSync, renameSync } from "node:fs";
import {
  appendFile,
  chmod,
  chown,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowNamespaceLease } from "../src/workflow-lease";
import { recoverWorkflowRun } from "../src/workflow-recovery";
import {
  WorkflowRunAuthorityError,
  WorkflowRunCorruptionError,
  WorkflowRunStore,
  workflowRunPath,
  workflowRunStoreRoot,
} from "../src/workflow-run-store";
import type { WorkflowPlan } from "../src/workflow-plan";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

const roots: string[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease-token",
};
const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "durable-core",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [{ id: "task", prompt: "do the durable task" }],
    },
  ],
};

interface PositionalReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
}

async function makeStore(runId = "run") {
  const root = await mkdtemp(join(tmpdir(), "workflow-run-store-core-"));
  roots.push(root);
  const store = new WorkflowRunStore({ rootDir: root, owner });
  await store.createRunWithInitialEvent(
    {
      runId,
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    },
    { type: "run_created", payload: { plan } },
  );
  return { root, store, runId };
}

afterEach(async () => {
  await WorkflowRunStore.releaseAllLeases();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkflowRunStore Milestone 2 core", () => {
  it("publishes run_created before a run is listable and reopens committed appends", async () => {
    const { root, store, runId } = await makeStore();
    const epoch = await store.getLeaseEpoch();
    const appended = await store.appendIfCurrent(
      runId,
      0,
      "run_started",
      {},
      epoch,
    );

    expect(appended).toMatchObject({
      status: "appended",
      receipt: { eventOrdinal: 1, runEpoch: epoch },
    });
    const reopened = new WorkflowRunStore({ rootDir: root, owner });
    expect(await reopened.listRunIds()).toEqual([runId]);
    const record = await reopened.readRun(runId);
    expect(record.events.map((event) => event.type)).toEqual([
      "run_created",
      "run_started",
    ]);
    expect(record.events[0].payload).toEqual({ plan });
  });

  it("ignores and repairs an incomplete final NDJSON line before append", async () => {
    const { root, store, runId } = await makeStore();
    const eventPath = join(
      workflowRunPath(root, owner, runId),
      "events.ndjson",
    );
    await appendFile(eventPath, '{"schemaVersion":1,"eventId":"torn');

    const recovered = await store.readEventLog(runId);
    expect(recovered.events).toHaveLength(1);
    expect(recovered.tornTailBytes).toBeGreaterThan(0);
    const receipt = await store.append(runId, "run_started", {});
    expect(receipt).toMatchObject({ eventOrdinal: 1 });
    expect((await store.readEventLog(runId)).tornTailBytes).toBe(0);
  });

  it("returns authoritative conflict epochs and rejects unowned epoch advances", async () => {
    const { store, runId } = await makeStore();
    const epoch = await store.getLeaseEpoch();
    const conflict = await store.appendIfCurrent(
      runId,
      99,
      "run_started",
      {},
      epoch,
    );
    expect(conflict).toEqual({
      status: "conflict",
      actualLastEventOrdinal: 0,
      actualRunEpoch: epoch,
    });
    await expect(
      store.append(runId, "run_started", {}, epoch + 1),
    ).rejects.toThrow("not owned by lease epoch");
  });

  it("fails closed for a different live owner in the same durable namespace", async () => {
    const { root, runId } = await makeStore();
    const foreignOwner: WorkflowOwnerIdentity = {
      ...owner,
      ownerId: "foreign-owner",
      leaseToken: "foreign-token",
    };
    const foreign = new WorkflowRunStore({
      rootDir: root,
      owner: foreignOwner,
    });
    await expect(foreign.readRun(runId)).rejects.toThrow("different owner");
  });

  it("reopens a stable namespace with fresh live authority and a higher epoch", async () => {
    const { root, store, runId } = await makeStore();
    const firstEpoch = await store.getLeaseEpoch();
    await store.release();
    const freshOwner: WorkflowOwnerIdentity = {
      ...owner,
      ownerId: "fresh-owner",
      ownerGeneration: owner.ownerGeneration + 1,
      leaseToken: "fresh-token",
    };
    const reopened = new WorkflowRunStore({ rootDir: root, owner: freshOwner });
    const freshEpoch = await reopened.getLeaseEpoch();
    expect(freshEpoch).toBeGreaterThan(firstEpoch);
    await expect(reopened.readRun(runId)).resolves.toMatchObject({
      launch: { runId },
    });
    await expect(
      reopened.append(runId, "run_started", {}, firstEpoch),
    ).rejects.toThrow(/stale.*epoch/i);
    await expect(
      reopened.append(runId, "run_started", {}, freshEpoch),
    ).resolves.toMatchObject({ runEpoch: freshEpoch });
  });

  it("persists canonical outcome blobs and detects referenced corruption", async () => {
    const { root, store, runId } = await makeStore();
    const ref = await store.writeOutcomeBlob(runId, {
      status: "succeeded",
      result: { z: 2, a: 1 },
    });
    expect(await store.readOutcomeBlob(runId, ref)).toEqual({
      result: { a: 1, z: 2 },
      status: "succeeded",
    });

    const outcomePath = join(
      workflowRunPath(root, owner, runId),
      "outputs",
      `${ref.digest}.json`,
    );
    await writeFile(outcomePath, '{"status":"failed"}', "utf8");
    await expect(store.readOutcomeBlob(runId, ref)).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
  });

  it("ignores incomplete staging runs and rejects hard-linked authority files", async () => {
    const { root, store, runId } = await makeStore();
    const runsDir = join(workflowRunStoreRoot(root, owner), "runs");
    await mkdir(
      join(runsDir, ".creating-hidden-00000000-0000-4000-8000-000000000000"),
    );
    expect(await store.listRunIds()).toEqual([runId]);

    const launchPath = join(workflowRunPath(root, owner, runId), "launch.json");
    const originalPath = join(
      workflowRunPath(root, owner, runId),
      "launch-original.json",
    );
    await rename(launchPath, originalPath);
    await link(originalPath, launchPath);
    await expect(store.readRun(runId)).rejects.toBeInstanceOf(
      WorkflowRunAuthorityError,
    );
  });

  it("folds an uncommitted active attempt as interrupted without appending evidence", async () => {
    const { store, runId } = await makeStore();
    const epoch = await store.getLeaseEpoch();
    await store.append(runId, "run_started", {}, epoch);
    await store.append(
      runId,
      "operation_prepared",
      {
        taskId: "task",
        operationId: "task",
        phaseId: "phase",
        requestDigest: "digest",
      },
      epoch,
    );
    const claim = {
      runId,
      taskId: "task",
      operationId: "task",
      attempt: 1,
      runEpoch: epoch,
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      leaseEpoch: epoch,
      token: "attempt-token",
    };
    await store.append(
      runId,
      "attempt_started",
      { taskId: "task", operationId: "task", attempt: 1, claim },
      epoch,
    );

    const projection = await recoverWorkflowRun({ store, owner }, runId);
    expect(projection.status).toBe("interrupted");
    expect(projection.tasks.task.status).toBe("interrupted");
    expect(projection.operations.task.attempts[1].status).toBe("interrupted");
    expect(projection.usageLowerBound).toBe(true);
    expect((await store.readRun(runId)).events).toHaveLength(4);
  });

  it("rejects a complete journal from a future lease epoch", async () => {
    const { root, store, runId } = await makeStore();
    const epoch = await store.getLeaseEpoch();
    const eventPath = join(
      workflowRunPath(root, owner, runId),
      "events.ndjson",
    );
    const event = JSON.parse((await readFile(eventPath, "utf8")).trim()) as {
      runEpoch: number;
    };
    event.runEpoch = epoch + 1;
    await writeFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");

    await expect(store.readRun(runId)).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
    await expect(store.append(runId, "run_started", {})).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
  });

  it("accepts a complete journal at the held epoch and stamps new events with that exact epoch", async () => {
    const { store, runId } = await makeStore();
    const epoch = await store.getLeaseEpoch();
    await expect(store.readRun(runId)).resolves.toMatchObject({
      events: [{ runEpoch: epoch }],
    });
    await expect(store.append(runId, "run_started", {})).resolves.toMatchObject(
      {
        eventOrdinal: 1,
        runEpoch: epoch,
      },
    );
  });

  it("fails closed when the run directory is swapped after reading a complete journal", async () => {
    const { root, store, runId } = await makeStore();
    const runPath = workflowRunPath(root, owner, runId);
    const savedPath = join(
      workflowRunStoreRoot(root, owner),
      "runs",
      ".saved-run",
    );
    const originalParse = JSON.parse;
    let swapped = false;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text) => {
      const parsed = originalParse(text);
      if (!swapped && text.includes('"eventOrdinal":0')) {
        swapped = true;
        renameSync(runPath, savedPath);
        mkdirSync(runPath, { mode: 0o700 });
      }
      return parsed;
    });
    try {
      await expect(store.readRun(runId)).rejects.toBeInstanceOf(
        WorkflowRunAuthorityError,
      );
      expect(swapped).toBe(true);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("rejects an oversized physical event line padded only with whitespace", async () => {
    const { root, store, runId } = await makeStore();
    const eventPath = join(
      workflowRunPath(root, owner, runId),
      "events.ndjson",
    );
    const original = await readFile(eventPath);
    await writeFile(
      eventPath,
      Buffer.concat([
        original.subarray(0, original.length - 1),
        Buffer.alloc(512 * 1024, 0x20),
        Buffer.from("\n"),
      ]),
    );

    await expect(store.readRun(runId)).rejects.toBeInstanceOf(
      WorkflowRunCorruptionError,
    );
  });

  it("caps a file that grows after its initial descriptor stat", async () => {
    const { root, store, runId } = await makeStore();
    const launchPath = join(workflowRunPath(root, owner, runId), "launch.json");
    const probe = await open(launchPath, "r");
    const prototype = Object.getPrototypeOf(probe) as PositionalReader;
    await probe.close();
    const originalRead = prototype.read;
    let grew = false;
    const readSpy = vi
      .spyOn(prototype, "read")
      .mockImplementation(async function (
        this: PositionalReader,
        buffer,
        offset,
        length,
        position,
      ) {
        const result = await originalRead.call(
          this,
          buffer,
          offset,
          length,
          position,
        );
        if (
          !grew &&
          result.buffer
            .subarray(0, result.bytesRead)
            .includes(Buffer.from('"planDigest"'))
        ) {
          grew = true;
          appendFileSync(launchPath, Buffer.alloc(64 * 1024, 0x20));
        }
        return result;
      });
    try {
      await expect(store.readRun(runId)).rejects.toBeInstanceOf(
        WorkflowRunCorruptionError,
      );
      expect(grew).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("rejects unsafe directory and file authority modes while accepting safe reused directories", async () => {
    const unsafeDirectory = await makeStore("unsafe-directory");
    const unsafeRoot = await mkdtemp(
      join(tmpdir(), "workflow-run-store-unsafe-root-"),
    );
    roots.push(unsafeRoot);
    await chmod(unsafeRoot, 0o777);
    const rootStore = new WorkflowRunStore({
      rootDir: unsafeRoot,
      owner,
    });
    await expect(rootStore.getLeaseEpoch()).rejects.toBeInstanceOf(
      WorkflowRunAuthorityError,
    );

    const unsafeRunPath = workflowRunPath(
      unsafeDirectory.root,
      owner,
      unsafeDirectory.runId,
    );
    await chmod(unsafeRunPath, 0o770);
    await expect(
      unsafeDirectory.store.readRun(unsafeDirectory.runId),
    ).rejects.toBeInstanceOf(WorkflowRunAuthorityError);
    await chmod(unsafeRunPath, 0o755);
    await expect(
      unsafeDirectory.store.readRun(unsafeDirectory.runId),
    ).rejects.toBeInstanceOf(WorkflowRunAuthorityError);

    const unsafeFile = await makeStore("unsafe-file");
    await chmod(
      join(
        workflowRunPath(unsafeFile.root, owner, unsafeFile.runId),
        "launch.json",
      ),
      0o640,
    );
    await expect(
      unsafeFile.store.readRun(unsafeFile.runId),
    ).rejects.toBeInstanceOf(WorkflowRunAuthorityError);

    const safe = await makeStore("safe-existing");
    const ownerRoot = workflowRunStoreRoot(safe.root, owner);
    for (const path of [
      safe.root,
      join(safe.root, owner.projectKey),
      ownerRoot,
      join(ownerRoot, "namespace"),
      join(ownerRoot, "runs"),
      workflowRunPath(safe.root, owner, safe.runId),
      join(workflowRunPath(safe.root, owner, safe.runId), "outputs"),
    ]) {
      await chmod(path, 0o700);
    }
    await expect(safe.store.readRun(safe.runId)).resolves.toMatchObject({
      launch: { runId: safe.runId },
    });
  });

  it("rejects symlink substitution and a mismatched effective owner where testable", async () => {
    if (process.platform !== "win32") {
      const symlinked = await makeStore("symlinked");
      const runPath = workflowRunPath(symlinked.root, owner, symlinked.runId);
      const savedPath = `${runPath}.saved`;
      await rename(runPath, savedPath);
      await symlink(savedPath, runPath, "dir");
      await expect(
        symlinked.store.readRun(symlinked.runId),
      ).rejects.toBeInstanceOf(WorkflowRunAuthorityError);
    }

    if (typeof process.geteuid === "function" && process.geteuid() === 0) {
      const foreignFile = await makeStore("foreign-file");
      await chown(
        join(
          workflowRunPath(foreignFile.root, owner, foreignFile.runId),
          "launch.json",
        ),
        1,
        1,
      );
      await expect(
        foreignFile.store.readRun(foreignFile.runId),
      ).rejects.toBeInstanceOf(WorkflowRunAuthorityError);

      const foreignDirectory = await makeStore("foreign-directory");
      await chown(
        workflowRunPath(foreignDirectory.root, owner, foreignDirectory.runId),
        1,
        1,
      );
      await expect(
        foreignDirectory.store.readRun(foreignDirectory.runId),
      ).rejects.toBeInstanceOf(WorkflowRunAuthorityError);
    }
  });

  it("never reacquires namespace authority after store revocation", async () => {
    const { store, runId } = await makeStore();
    await store.revoke();
    await store.release();

    await expect(store.getLeaseEpoch()).rejects.toThrow(/revoked/i);
    await expect(store.readRun(runId)).rejects.toThrow(/revoked/i);
    await expect(store.append(runId, "run_started", {})).rejects.toThrow(
      /revoked/i,
    );
  });
});

describe("WorkflowNamespaceLease", () => {
  it("takes over a provably dead writer immediately and increments its epoch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-lease-core-"));
    roots.push(rootDir);
    const deadPid = 2_000_000_000;
    const first = new WorkflowNamespaceLease({
      rootDir,
      namespace: "owner",
      ownerId: "first",
      leaseToken: "first-token",
      processId: deadPid,
      processStartTime: 1,
    });
    expect((await first.acquire()).epoch).toBe(1);

    const replacement = new WorkflowNamespaceLease({
      rootDir,
      namespace: "owner",
      ownerId: "replacement",
      leaseToken: "replacement-token",
    });
    expect((await replacement.acquire()).epoch).toBe(2);
    await replacement.release();
    await first.release();
  });

  it("takes over a prior process that reused the current PID", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-lease-pid-reuse-"));
    roots.push(rootDir);
    const first = new WorkflowNamespaceLease({
      rootDir,
      namespace: "owner",
      ownerId: "prior-process",
      leaseToken: "prior-token",
      processId: process.pid,
      processStartTime: Number.MAX_SAFE_INTEGER,
    });
    expect((await first.acquire()).epoch).toBe(1);

    const replacement = new WorkflowNamespaceLease({
      rootDir,
      namespace: "owner",
      ownerId: "current-process",
      leaseToken: "current-token",
    });
    expect((await replacement.acquire()).epoch).toBe(2);
    await replacement.release();
    await first.release();
  });

  it("rejects an existing lease authority file with group access", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "workflow-lease-mode-"));
    roots.push(rootDir);
    const lease = new WorkflowNamespaceLease({
      rootDir,
      namespace: "owner",
      ownerId: "mode-owner",
      leaseToken: "mode-token",
    });
    await lease.acquire();
    const leasePath = join(rootDir, "owner", "namespace.lease");
    await chmod(leasePath, 0o640);
    try {
      await expect(lease.assertHeld()).rejects.toThrow(/corrupt|access/i);
    } finally {
      await chmod(leasePath, 0o600);
      await lease.release();
    }
  });
});
