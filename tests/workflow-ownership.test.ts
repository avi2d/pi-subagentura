import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_WORKFLOW_JOBS,
  cleanupWorkflowJobsForOwner,
  getWorkflowJobForActiveSession,
  getWorkflowJobForOwner,
  getRunningWorkflowCount,
  retryPendingWorkflowNotifications,
  startWorkflowJob,
  workflowJobBelongsToOwner,
  workflowJobRegistry,
  workflowJobsForOwner,
  type WorkflowJobState,
} from "../src/workflow";
import {
  setActiveSessionRefs,
  type ActiveSessionContextToken,
  type SessionContextRef,
} from "../src/session-context";

function owner(id: number, generation: number): ActiveSessionContextToken {
  return { id, generation };
}

function context(id: number, generation: number): SessionContextRef {
  return { id, generation, pi: {} as any };
}

function makeJob(
  id: string,
  status: WorkflowJobState["status"],
  ownerRef: ActiveSessionContextToken,
): WorkflowJobState {
  return {
    id,
    name: id,
    status,
    startedAt: Date.now(),
    promise: Promise.resolve({
      meta: { name: id, description: "test" },
      result: id,
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        turns: 0,
        totalTokens: 0,
      },
      phases: [],
    }),
    abort: new AbortController(),
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      phases: [],
    },
    parentSessionOwner: ownerRef,
  };
}

describe("workflow parent session ownership", () => {
  beforeEach(() => {
    workflowJobRegistry.clear();
    setActiveSessionRefs(undefined);
  });

  it("requires exact {id,generation}, treats wrong owners as missing, and cleans up only the owning lifecycle", () => {
    const sameIdGeneration1 = owner(7, 1);
    const sameIdGeneration2 = owner(7, 2);
    const otherIdGeneration1 = owner(8, 1);
    const owned = makeJob("owned", "running", sameIdGeneration1);
    const wrongGeneration = makeJob(
      "wrong-generation",
      "running",
      sameIdGeneration2,
    );
    const wrongId = makeJob("wrong-id", "running", otherIdGeneration1);
    workflowJobRegistry.set(owned.id, owned);
    workflowJobRegistry.set(wrongGeneration.id, wrongGeneration);
    workflowJobRegistry.set(wrongId.id, wrongId);

    setActiveSessionRefs(context(7, 1));

    expect(getWorkflowJobForActiveSession("owned")).toBe(owned);
    expect(getWorkflowJobForActiveSession("wrong-generation")).toBeUndefined();
    expect(getWorkflowJobForActiveSession("wrong-id")).toBeUndefined();
    expect(workflowJobBelongsToOwner(owned, sameIdGeneration1)).toBe(true);
    expect(workflowJobBelongsToOwner(wrongGeneration, sameIdGeneration1)).toBe(
      false,
    );
    expect(workflowJobBelongsToOwner(wrongId, sameIdGeneration1)).toBe(false);

    cleanupWorkflowJobsForOwner(sameIdGeneration1);

    expect(workflowJobRegistry.has("owned")).toBe(false);
    expect(workflowJobRegistry.get("wrong-generation")).toBe(wrongGeneration);
    expect(workflowJobRegistry.get("wrong-id")).toBe(wrongId);
  });

  it("keeps the registry cap global but evicts only terminal jobs owned by the active parent", () => {
    const activeOwner = owner(1, 1);
    const otherOwner = owner(2, 1);
    for (let i = 0; i < MAX_WORKFLOW_JOBS - 1; i++) {
      workflowJobRegistry.set(
        `running-${i}`,
        makeJob(`running-${i}`, "running", activeOwner),
      );
    }
    const otherTerminal = makeJob("other-terminal", "done", otherOwner);
    workflowJobRegistry.set(otherTerminal.id, otherTerminal);
    setActiveSessionRefs(context(1, 1));

    expect(() =>
      startWorkflowJob(
        "active",
        `export const meta = { name: "active", description: "d" };\nreturn "ok";`,
        { runAgent: async () => ({ isError: false, output: "ok" }) as any },
      ),
    ).toThrow(/100 workflow jobs already running/);
    expect(workflowJobRegistry.get("other-terminal")).toBe(otherTerminal);

    workflowJobRegistry.delete("running-0");
    const activeTerminal = makeJob("active-terminal", "done", activeOwner);
    workflowJobRegistry.set(activeTerminal.id, activeTerminal);

    const started = startWorkflowJob(
      "active",
      `export const meta = { name: "active", description: "d" };\nreturn "ok";`,
      { runAgent: async () => ({ isError: false, output: "ok" }) as any },
    );

    expect(workflowJobRegistry.has("active-terminal")).toBe(false);
    expect(workflowJobRegistry.get("other-terminal")).toBe(otherTerminal);
    expect(started.parentSessionOwner).toEqual(activeOwner);
  });

  it("suppresses late completion notifications after the parent generation changes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const onComplete = vi.fn();
    setActiveSessionRefs(context(3, 1));
    const job = startWorkflowJob(
      "late-owner",
      `export const meta = { name: "late-owner", description: "d" };\nreturn await agent("x");`,
      {
        runAgent: async () => {
          await gate;
          return { isError: false, output: "ok" } as any;
        },
      },
      undefined,
      onComplete,
    );

    setActiveSessionRefs(context(3, 2));
    release();
    await job.promise;
    retryPendingWorkflowNotifications();

    expect(onComplete).not.toHaveBeenCalled();
    expect(job.completionNotificationDelivered).toBe(false);
  });

  it("lets captured A helpers access A while B is active, and blocks B from A", () => {
    const ownerA = owner(10, 1);
    const ownerB = owner(20, 1);
    const jobA = makeJob("job-a", "running", ownerA);
    const jobB = makeJob("job-b", "running", ownerB);
    workflowJobRegistry.set(jobA.id, jobA);
    workflowJobRegistry.set(jobB.id, jobB);

    setActiveSessionRefs(context(20, 1));

    expect(getWorkflowJobForActiveSession("job-a")).toBeUndefined();
    expect(getWorkflowJobForOwner("job-a", ownerA)).toBe(jobA);
    expect(getWorkflowJobForOwner("job-a", ownerB)).toBeUndefined();
    expect(workflowJobsForOwner(ownerA)).toEqual([jobA]);
    expect(workflowJobsForOwner(ownerB)).toEqual([jobB]);
    expect(getRunningWorkflowCount(ownerA)).toBe(1);
    expect(getRunningWorkflowCount(ownerB)).toBe(1);

    cleanupWorkflowJobsForOwner(ownerB);

    expect(workflowJobRegistry.get("job-a")).toBe(jobA);
    expect(workflowJobRegistry.has("job-b")).toBe(false);
  });

  it("captures explicit start owner instead of the mutable active owner", () => {
    const ownerA = owner(30, 1);
    const ownerB = owner(40, 1);
    setActiveSessionRefs(context(40, 1));

    const started = startWorkflowJob(
      "owned-by-a",
      `export const meta = { name: "owned-by-a", description: "d" };\nreturn "ok";`,
      { runAgent: async () => ({ isError: false, output: "ok" }) as any },
      undefined,
      undefined,
      ownerA,
    );

    expect(started.parentSessionOwner).toEqual(ownerA);
    expect(getWorkflowJobForActiveSession(started.id)).toBeUndefined();
    expect(getWorkflowJobForOwner(started.id, ownerA)).toBe(started);
    expect(getWorkflowJobForOwner(started.id, ownerB)).toBeUndefined();
  });
});
