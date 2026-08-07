import { describe, expect, it } from "vitest";
import {
  createWorkflowReplayRequest,
  durableWorkflowDigest,
  replayWorkflowResponses,
  WorkflowReplayDivergedError,
} from "../src/workflow-replay";

describe("workflow durable replay", () => {
  it("canonicalizes request fields into stable digests", () => {
    const first = createWorkflowReplayRequest({
      operationId: "op-1",
      dispatchOrdinal: 1,
      prompt: { b: 2, a: 1 },
      options: { model: "m" },
      definition: { nested: true },
    });
    const second = createWorkflowReplayRequest({
      operationId: "op-1",
      dispatchOrdinal: 1,
      prompt: { a: 1, b: 2 },
      options: { model: "m" },
      definition: { nested: true },
    });
    expect(first).toEqual(second);
    expect(durableWorkflowDigest(null)).toHaveLength(64);
  });

  it("replays all response kinds in ordinal order", () => {
    const request = createWorkflowReplayRequest({
      operationId: "op-1",
      dispatchOrdinal: 1,
      prompt: "hello",
      options: {},
      definition: "definition",
    });
    const responses = [
      {
        operationId: "op-1",
        responseOrdinal: 1,
        kind: "success" as const,
        valueDigest: "a",
      },
      {
        operationId: "op-1",
        responseOrdinal: 2,
        kind: "null" as const,
        valueDigest: "b",
      },
    ];
    expect(replayWorkflowResponses([request], responses)).toEqual(responses);
  });

  it("fails boundedly on missing or unknown responses", () => {
    const request = createWorkflowReplayRequest({
      operationId: "op-1",
      dispatchOrdinal: 1,
      prompt: "hello",
      options: {},
      definition: "definition",
    });
    expect(() =>
      replayWorkflowResponses(
        [request],
        [
          {
            operationId: "op-1",
            responseOrdinal: 2,
            kind: "error",
            valueDigest: "x",
          },
        ],
      ),
    ).toThrow(WorkflowReplayDivergedError);
    expect(() =>
      replayWorkflowResponses(
        [request],
        [
          {
            operationId: "op-2",
            responseOrdinal: 1,
            kind: "error",
            valueDigest: "x",
          },
        ],
      ),
    ).toThrow("Unknown workflow replay operation");
  });
});
