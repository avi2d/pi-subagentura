import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkflowProcessLaunchIntent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly epoch: number;
  readonly nonce: string;
  readonly launchMarker: string;
  readonly requestedIsolation: "process";
  readonly effectiveIsolation: "process" | "in-process";
  readonly fallbackMode: "none" | "process_unavailable";
}

export interface WorkflowProcessLaunchIntentInput {
  runId: string;
  operationId: string;
  attemptId: string;
  attemptNumber: number;
  epoch: number;
  effectiveIsolation?: "process" | "in-process";
  fallbackMode?: "none" | "process_unavailable";
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;

function assertInput(input: WorkflowProcessLaunchIntentInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string" && !ID.test(value)) {
      throw new Error(`Invalid workflow process ${name}`);
    }
  }
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new Error("Invalid workflow process attempt number");
  }
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
    throw new Error("Invalid workflow process epoch");
  }
}

export function createWorkflowProcessLaunchIntent(
  input: WorkflowProcessLaunchIntentInput,
): WorkflowProcessLaunchIntent {
  assertInput(input);
  return Object.freeze({
    schemaVersion: 1,
    runId: input.runId,
    operationId: input.operationId,
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    epoch: input.epoch,
    nonce: randomUUID(),
    launchMarker: `wf-launch-${randomUUID()}`,
    requestedIsolation: "process",
    effectiveIsolation: input.effectiveIsolation ?? "process",
    fallbackMode: input.fallbackMode ?? "none",
  });
}

export async function persistWorkflowProcessLaunchIntent(
  root: string,
  intent: WorkflowProcessLaunchIntent,
): Promise<string> {
  const dir = join(root, "process-attempts", intent.runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${intent.attemptId}.json`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(intent)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

export async function readWorkflowProcessLaunchIntent(
  path: string,
): Promise<WorkflowProcessLaunchIntent> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") {
    throw new Error("Invalid workflow process launch intent");
  }
  const intent = value as Partial<WorkflowProcessLaunchIntent>;
  if (
    intent.schemaVersion !== 1 ||
    typeof intent.runId !== "string" ||
    typeof intent.operationId !== "string" ||
    typeof intent.attemptId !== "string" ||
    typeof intent.nonce !== "string" ||
    typeof intent.launchMarker !== "string"
  ) {
    throw new Error("Invalid workflow process launch intent");
  }
  return intent as WorkflowProcessLaunchIntent;
}
