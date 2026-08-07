import { createHash } from "node:crypto";

export type WorkflowReplayResponseKind =
  "success" | "null" | "error" | "cancelled" | "schema_retry";

export interface WorkflowReplayRequest {
  readonly operationId: string;
  readonly dispatchOrdinal: number;
  readonly promptDigest: string;
  readonly optionsDigest: string;
  readonly definitionDigest: string;
}

export interface WorkflowReplayResponse {
  readonly operationId: string;
  readonly responseOrdinal: number;
  readonly kind: WorkflowReplayResponseKind;
  readonly valueDigest: string;
  readonly payload?: unknown;
}

export class WorkflowReplayDivergedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowReplayDivergedError";
  }
}

export function durableWorkflowDigest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        typeof item === "object" && item !== null
          ? Object.keys(item)
              .sort()
              .reduce<Record<string, unknown>>((out, key) => {
                out[key] = item[key];
                return out;
              }, {})
          : item,
      ),
    )
    .digest("hex");
}

export function createWorkflowReplayRequest(input: {
  operationId: string;
  dispatchOrdinal: number;
  prompt: unknown;
  options: unknown;
  definition: unknown;
}): WorkflowReplayRequest {
  if (
    !Number.isSafeInteger(input.dispatchOrdinal) ||
    input.dispatchOrdinal < 1
  ) {
    throw new Error("Invalid workflow replay dispatch ordinal");
  }
  return {
    operationId: input.operationId,
    dispatchOrdinal: input.dispatchOrdinal,
    promptDigest: durableWorkflowDigest(input.prompt),
    optionsDigest: durableWorkflowDigest(input.options),
    definitionDigest: durableWorkflowDigest(input.definition),
  };
}

export function replayWorkflowResponses(
  expected: readonly WorkflowReplayRequest[],
  actual: readonly WorkflowReplayResponse[],
): readonly WorkflowReplayResponse[] {
  let nextOrdinal = 1;
  for (const response of actual) {
    if (response.responseOrdinal !== nextOrdinal) {
      throw new WorkflowReplayDivergedError(
        "Missing workflow replay response ordinal",
      );
    }
    const request = expected.find(
      (item) => item.operationId === response.operationId,
    );
    if (!request) {
      throw new WorkflowReplayDivergedError(
        "Unknown workflow replay operation",
      );
    }
    if (!response.valueDigest) {
      throw new WorkflowReplayDivergedError("Invalid workflow replay response");
    }
    nextOrdinal++;
  }
  return actual;
}
