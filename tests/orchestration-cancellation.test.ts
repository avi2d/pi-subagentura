import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_ORCHESTRATION_DEPTH,
  getOrchestrationContext,
  maxOrchestrationDepth,
  resolveSpawnDepth,
  withOrchestrationContext,
} from "../src/orchestration-context";
import {
  abortJobTree,
  cascadeChildAborts,
  jobRegistry,
  readCancellationInfo,
  type CancellationInfo,
  type JobState,
} from "../src/helpers";

function fakeJob(overrides: Partial<JobState> & { id: string }): JobState {
  return {
    status: "running",
    liveStatus: {
      turn: 1,
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
    },
    session: { abort: vi.fn().mockResolvedValue(undefined) } as any,
    startedAt: Date.now(),
    promise: Promise.resolve({
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: false,
    }) as any,
    ...overrides,
  };
}

describe("orchestration context + depth cap", () => {
  afterEach(() => {
    delete process.env.SUBAGENTURA_MAX_ORCHESTRATION_DEPTH;
  });

  it("root spawn has no parent and sits at depth 1", () => {
    expect(getOrchestrationContext()).toBeUndefined();
    const spawn = resolveSpawnDepth();
    expect(spawn.childDepth).toBe(1);
    expect(spawn.parentJobId).toBeUndefined();
    expect(spawn.exceedsLimit).toBe(false);
  });

  it("nested spawn inherits owner and increments depth", () => {
    withOrchestrationContext(
      { ownerJobId: "job-a", depth: 1, rootSessionId: "root-1" },
      () => {
        const spawn = resolveSpawnDepth();
        expect(spawn.childDepth).toBe(2);
        expect(spawn.parentJobId).toBe("job-a");
        expect(spawn.rootSessionId).toBe("root-1");
        expect(spawn.exceedsLimit).toBe(false);
      },
    );
  });

  it("refuses a spawn that would exceed the depth cap", () => {
    withOrchestrationContext(
      { ownerJobId: "deep", depth: DEFAULT_MAX_ORCHESTRATION_DEPTH },
      () => {
        const spawn = resolveSpawnDepth();
        expect(spawn.childDepth).toBe(DEFAULT_MAX_ORCHESTRATION_DEPTH + 1);
        expect(spawn.exceedsLimit).toBe(true);
      },
    );
  });

  it("honours SUBAGENTURA_MAX_ORCHESTRATION_DEPTH override", () => {
    process.env.SUBAGENTURA_MAX_ORCHESTRATION_DEPTH = "1";
    expect(maxOrchestrationDepth()).toBe(1);
    withOrchestrationContext({ ownerJobId: "x", depth: 1 }, () => {
      expect(resolveSpawnDepth().exceedsLimit).toBe(true);
    });
  });

  it("falls back to the default for invalid overrides", () => {
    process.env.SUBAGENTURA_MAX_ORCHESTRATION_DEPTH = "not-a-number";
    expect(maxOrchestrationDepth()).toBe(DEFAULT_MAX_ORCHESTRATION_DEPTH);
  });
});

describe("readCancellationInfo", () => {
  it("returns a structured reason verbatim", () => {
    const info: CancellationInfo = {
      source: "cancel_subagent",
      initiator: "sess-1",
      reason: "user cancelled",
    };
    const c = new AbortController();
    c.abort(info);
    expect(readCancellationInfo(c.signal, "signal")).toEqual(info);
  });

  it("surfaces an Error reason message under the fallback source", () => {
    const c = new AbortController();
    c.abort(new Error("boom"));
    expect(readCancellationInfo(c.signal, "signal")).toEqual({
      source: "signal",
      reason: "boom",
    });
  });

  it("uses the fallback source when there is no reason", () => {
    expect(readCancellationInfo(undefined, "session_shutdown")).toEqual({
      source: "session_shutdown",
      reason: undefined,
    });
  });
});

describe("transitive cancellation", () => {
  beforeEach(() => jobRegistry.clear());
  afterEach(() => jobRegistry.clear());

  const info: CancellationInfo = {
    source: "cancel_subagent",
    initiator: "sess-1",
    reason: "test cancel",
  };

  it("abortJobTree aborts the target controller and marks children cancelled", () => {
    const parentAbort = new AbortController();
    const childAbort = new AbortController();
    jobRegistry.set("p", fakeJob({ id: "p", abort: parentAbort }));
    jobRegistry.set(
      "c",
      fakeJob({ id: "c", parentJobId: "p", abort: childAbort }),
    );

    const aborted = abortJobTree("p", info);

    expect(aborted).toContain("p");
    expect(aborted).toContain("c");
    expect(parentAbort.signal.aborted).toBe(true);
    expect(childAbort.signal.aborted).toBe(true);
    // The controller reason carries the structured cancellation info.
    expect(parentAbort.signal.reason).toEqual(info);
    expect(jobRegistry.get("c")!.status).toBe("cancelled");
    expect(jobRegistry.get("c")!.cancellation?.source).toBe("cancel_subagent");
  });

  it("cascades recursively through controller-less descendants", () => {
    // Sync-spawned descendants have no controller, so cascade recurses directly.
    jobRegistry.set("p", fakeJob({ id: "p" }));
    jobRegistry.set("c", fakeJob({ id: "c", parentJobId: "p" }));
    jobRegistry.set("g", fakeJob({ id: "g", parentJobId: "c" }));

    const signalled = cascadeChildAborts("p", info);

    expect(signalled).toEqual(expect.arrayContaining(["c", "g"]));
    expect(jobRegistry.get("c")!.status).toBe("cancelled");
    expect(jobRegistry.get("g")!.status).toBe("cancelled");
    expect(jobRegistry.get("c")!.session.abort as any).toHaveBeenCalled();
    expect(jobRegistry.get("g")!.session.abort as any).toHaveBeenCalled();
  });

  it("ignores unrelated and already-terminal jobs", () => {
    jobRegistry.set("p", fakeJob({ id: "p" }));
    jobRegistry.set("other", fakeJob({ id: "other" }));
    jobRegistry.set(
      "done",
      fakeJob({ id: "done", parentJobId: "p", status: "done" }),
    );

    const signalled = cascadeChildAborts("p", info);

    expect(signalled).toEqual([]);
    expect(jobRegistry.get("other")!.status).toBe("running");
    expect(jobRegistry.get("done")!.status).toBe("done");
  });
});
