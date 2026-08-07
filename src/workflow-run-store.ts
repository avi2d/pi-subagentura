import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  WorkflowAppendReceipt,
  WorkflowEventEnvelope,
  WorkflowOwnerIdentity,
  WorkflowRunLaunch,
} from "./workflow-run-types";

export interface WorkflowRunStoreOptions {
  rootDir: string;
  owner: WorkflowOwnerIdentity;
}

export interface WorkflowRunRecord {
  launch: WorkflowRunLaunch;
  events: WorkflowEventEnvelope[];
}

export interface WorkflowRunEventLog {
  readonly events: readonly WorkflowEventEnvelope[];
  readonly completeBytes: number;
  readonly tornTailBytes: number;
}

function safePart(value: string, label: string): string {
  if (
    !value ||
    value.length > 200 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`Invalid workflow ${label}`);
  }
  return value;
}

export class WorkflowRunStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: WorkflowRunStoreOptions) {
    this.root = join(
      options.rootDir,
      safePart(options.owner.projectKey, "project key"),
      safePart(options.owner.piSessionId, "session id"),
    );
  }

  async createRun(
    input: Omit<WorkflowRunLaunch, "schemaVersion" | "createdAt">,
  ): Promise<WorkflowRunLaunch> {
    const launch: WorkflowRunLaunch = {
      ...input,
      schemaVersion: 1,
      createdAt: Date.now(),
    };
    const dir = this.runDir(launch.runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "launch.json");
    try {
      await stat(path);
      throw new Error(`Workflow run already exists: ${launch.runId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(path, `${JSON.stringify(launch)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(join(dir, "events.ndjson"), "", {
      mode: 0o600,
      flag: "wx",
    });
    return launch;
  }

  async append<T extends string, P>(
    runId: string,
    type: T,
    payload: P,
    runEpoch = 0,
  ): Promise<WorkflowAppendReceipt> {
    const dir = this.runDir(runId);
    const event: WorkflowEventEnvelope<T, P> = {
      schemaVersion: 1,
      eventId: randomUUID(),
      runId,
      runEpoch,
      type,
      payload,
    };
    const line = `${JSON.stringify(event)}\n`;
    return this.withLock(runId, async () => {
      const launch = JSON.parse(
        await readFile(join(dir, "launch.json"), "utf8"),
      ) as WorkflowRunLaunch;
      assertSameOwner(launch.owner, this.options.owner);
      const path = join(dir, "events.ndjson");
      const before = await readFile(path);
      const completeBytes = lastCompleteLineBytes(before);
      const currentEpoch = lastCompleteRunEpoch(before);
      if (runEpoch < currentEpoch) {
        throw new Error(
          `Cannot append stale run epoch ${runEpoch}; current epoch is ${currentEpoch}`,
        );
      }
      const file = await open(path, "r+", 0o600);
      try {
        // A crashed writer may leave a partial final line. Remove it before
        // publishing the next event so the authoritative log stays valid.
        await file.truncate(completeBytes);
        await file.write(line, completeBytes, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      return {
        eventId: event.eventId,
        runId,
        startByte: completeBytes,
        endByte: completeBytes + Buffer.byteLength(line),
        eventOrdinal: countCompleteLines(before.subarray(0, completeBytes)),
      };
    });
  }

  async readRun(runId: string): Promise<WorkflowRunRecord> {
    const launch = JSON.parse(
      await readFile(join(this.runDir(runId), "launch.json"), "utf8"),
    ) as WorkflowRunLaunch;
    const bytes = await readFile(join(this.runDir(runId), "events.ndjson"));
    const events: WorkflowEventEnvelope[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) break;
      const line = bytes.subarray(offset, newline).toString("utf8");
      if (line) events.push(JSON.parse(line) as WorkflowEventEnvelope);
      offset = newline + 1;
    }
    return { launch, events };
  }

  async listRunIds(): Promise<readonly string[]> {
    const runsDir = join(this.root, "runs");
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((runId) => {
        try {
          safePart(runId, "run id");
          return true;
        } catch {
          /* Ignore malformed paths rather than exposing traversal candidates. */
          return false;
        }
      })
      .sort();
  }

  async readEventLog(runId: string): Promise<WorkflowRunEventLog> {
    const path = join(this.runDir(runId), "events.ndjson");
    const bytes = await readFile(path);
    const completeBytes = bytes.lastIndexOf(0x0a) + 1;
    return {
      events: (await this.readRun(runId)).events,
      completeBytes,
      tornTailBytes: bytes.length - completeBytes,
    };
  }

  private runDir(runId: string): string {
    return join(this.root, "runs", safePart(runId, "run id"));
  }

  private async withLock<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.locks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(runId, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(runId) === current) this.locks.delete(runId);
    }
  }
}

function assertSameOwner(
  left: WorkflowOwnerIdentity,
  right: WorkflowOwnerIdentity,
): void {
  if (
    left.projectKey !== right.projectKey ||
    left.cwd !== right.cwd ||
    left.piSessionId !== right.piSessionId ||
    left.ownerId !== right.ownerId ||
    left.ownerGeneration !== right.ownerGeneration ||
    left.leaseToken !== right.leaseToken
  ) {
    throw new Error("Workflow run belongs to a different owner or session.");
  }
}

function countCompleteLines(bytes: Buffer): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count++;
  return count;
}

function lastCompleteLineBytes(bytes: Buffer): number {
  return bytes.lastIndexOf(0x0a) + 1;
}

function lastCompleteRunEpoch(bytes: Buffer): number {
  let offset = 0;
  let epoch = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) break;
    const line = bytes.subarray(offset, newline).toString("utf8");
    if (line) {
      const event = JSON.parse(line) as Partial<WorkflowEventEnvelope>;
      if (
        typeof event.runEpoch === "number" &&
        Number.isFinite(event.runEpoch)
      ) {
        epoch = Math.max(epoch, event.runEpoch);
      }
    }
    offset = newline + 1;
  }
  return epoch;
}

export function workflowRunStoreRoot(
  rootDir: string,
  owner: WorkflowOwnerIdentity,
): string {
  return join(
    rootDir,
    safePart(owner.projectKey, "project key"),
    safePart(owner.piSessionId, "session id"),
  );
}

export function workflowRunPath(
  rootDir: string,
  owner: WorkflowOwnerIdentity,
  runId: string,
): string {
  return dirname(
    join(
      workflowRunStoreRoot(rootDir, owner),
      "runs",
      safePart(runId, "run id"),
      "events.ndjson",
    ),
  );
}
