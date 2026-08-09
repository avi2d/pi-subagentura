import { describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  createWorkflowDispatcher,
  type WorkflowDispatcher,
} from "../src/workflow-dispatcher";

const result: SubagentResult = {
  isError: false,
  output: "ok",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
  },
};

function run(
  dispatcher: WorkflowDispatcher,
  prompt: string,
  isolation: "in-process" | "process",
  runner: Parameters<WorkflowDispatcher["run"]>[1],
  signal?: AbortSignal,
) {
  return dispatcher.run({ prompt, isolation, signal }, runner);
}

describe("workflow dispatcher", () => {
  it("uses separate FIFO capacity lanes and removes an aborted waiter", async () => {
    const dispatcher = createWorkflowDispatcher({
      inProcessCapacity: 1,
      processCapacity: 1,
    });
    const releases = new Map<string, () => void>();
    const calls: string[] = [];
    const runner = vi.fn(async ({ prompt }): Promise<SubagentResult> => {
      calls.push(prompt);
      const gate = Promise.withResolvers<void>();
      releases.set(prompt, gate.resolve);
      await gate.promise;
      return result;
    });
    const queuedAbort = new AbortController();

    const first = run(dispatcher, "first", "in-process", runner);
    const aborted = run(
      dispatcher,
      "aborted",
      "in-process",
      runner,
      queuedAbort.signal,
    );
    const third = run(dispatcher, "third", "in-process", runner);
    const processRun = run(dispatcher, "process", "process", runner);
    await vi.waitFor(() => expect(calls).toEqual(["first", "process"]));

    queuedAbort.abort(new Error("cancel queued"));
    await expect(aborted).rejects.toThrow("cancel queued");
    releases.get("first")?.();
    await vi.waitFor(() =>
      expect(calls).toEqual(["first", "process", "third"]),
    );
    expect(runner).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "aborted" }),
    );

    releases.get("third")?.();
    releases.get("process")?.();
    await Promise.all([first, third, processRun]);
  });

  it("releases capacity when the raw runner throws", async () => {
    const dispatcher = createWorkflowDispatcher({
      inProcessCapacity: 1,
      processCapacity: 1,
    });
    const runner = vi
      .fn<Parameters<WorkflowDispatcher["run"]>[1]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(result);

    await expect(run(dispatcher, "bad", "in-process", runner)).rejects.toThrow(
      "boom",
    );
    await expect(run(dispatcher, "next", "in-process", runner)).resolves.toBe(
      result,
    );
  });
});
