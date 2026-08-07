import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

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

export async function persistWorkflowDefinitionBlob(
  root: string,
  definition: unknown,
): Promise<{ digest: string; path: string }> {
  const encoded = JSON.stringify(definition);
  const digest = durableWorkflowDigest(definition);
  const dir = join(root, "workflow-blobs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${digest}.json`);
  const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  });
  if (handle) {
    try {
      await handle.writeFile(`${encoded}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return { digest, path };
}

export async function readWorkflowDefinitionBlob(
  path: string,
  expectedDigest: string,
): Promise<unknown> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new WorkflowReplayDivergedError(
        "Workflow definition blob is not a file",
      );
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (durableWorkflowDigest(value) !== expectedDigest) {
      throw new WorkflowReplayDivergedError(
        "Workflow definition blob diverged",
      );
    }
    return value;
  } finally {
    await handle.close();
  }
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
