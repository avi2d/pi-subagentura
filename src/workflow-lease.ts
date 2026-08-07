import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface WorkflowNamespaceLeaseRecord {
  schemaVersion: 1;
  ownerId: string;
  leaseToken: string;
  epoch: number;
  acquiredAt: number;
  processId?: number;
  processStartTime?: number;
}

export interface WorkflowNamespaceLeaseOptions {
  rootDir: string;
  namespace: string;
  ownerId: string;
  leaseToken: string;
  staleAfterMs?: number;
  now?: () => number;
  processId?: number;
  processStartTime?: number;
}

/**
 * Exclusive writer lease for one workflow namespace.
 *
 * Acquisition is create-only. A stale lease may be replaced only when its
 * record is valid and older than the configured threshold. Invalid or
 * ambiguous lease evidence fails closed rather than being overwritten.
 */
export class WorkflowNamespaceLease {
  private readonly path: string;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private epoch = 0;
  private held = false;

  public constructor(private readonly options: WorkflowNamespaceLeaseOptions) {
    if (!options.ownerId || !options.leaseToken || !options.namespace) {
      throw new Error("Invalid workflow namespace lease identity");
    }
    if (
      options.staleAfterMs !== undefined &&
      (!Number.isSafeInteger(options.staleAfterMs) || options.staleAfterMs <= 0)
    ) {
      throw new Error("Invalid workflow namespace lease timeout");
    }
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    this.path = join(options.rootDir, options.namespace, "namespace.lease");
  }

  public get leaseEpoch(): number {
    return this.epoch;
  }

  public get isHeld(): boolean {
    return this.held;
  }

  public async acquire(): Promise<WorkflowNamespaceLeaseRecord> {
    await mkdir(join(this.options.rootDir, this.options.namespace), {
      recursive: true,
      mode: 0o700,
    });
    const record = this.record(1);
    try {
      await this.writeExclusive(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await this.read();
      if (!current || this.now() - current.acquiredAt < this.staleAfterMs) {
        throw new Error("Workflow namespace lease is held");
      }
      if (
        current.processId !== undefined &&
        isProcessAlive(current.processId)
      ) {
        if (
          current.processId === process.pid &&
          current.processStartTime !== undefined &&
          current.processStartTime !==
            Math.floor(Date.now() - process.uptime() * 1000)
        ) {
          throw new Error("Workflow namespace lease process identity changed");
        }
        throw new Error("Workflow namespace lease is held by a live process");
      }
      if (current.processId === undefined) {
        throw new Error("Workflow namespace lease identity is ambiguous");
      }
      const replacement = this.record(current.epoch + 1);
      await rm(this.path, { force: true });
      try {
        await this.writeExclusive(replacement);
      } catch (retryError) {
        throw new Error("Workflow namespace lease takeover raced", {
          cause: retryError,
        });
      }
      this.epoch = replacement.epoch;
      this.held = true;
      return replacement;
    }
    this.epoch = record.epoch;
    this.held = true;
    return record;
  }

  public async release(): Promise<void> {
    if (!this.held) return;
    const current = await this.read();
    if (
      current?.ownerId === this.options.ownerId &&
      current.leaseToken === this.options.leaseToken &&
      current.epoch === this.epoch
    ) {
      await rm(this.path, { force: true });
    }
    this.held = false;
  }

  public async assertHeld(): Promise<void> {
    const current = await this.read();
    if (
      !this.held ||
      !current ||
      current.ownerId !== this.options.ownerId ||
      current.leaseToken !== this.options.leaseToken ||
      current.epoch !== this.epoch
    ) {
      throw new Error("Workflow namespace lease is not held");
    }
  }

  private record(epoch: number): WorkflowNamespaceLeaseRecord {
    return {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      leaseToken: this.options.leaseToken,
      epoch,
      acquiredAt: this.now(),
      ...(this.options.processId === undefined
        ? {}
        : {
            processId: this.options.processId,
            ...(this.options.processStartTime === undefined
              ? {}
              : { processStartTime: this.options.processStartTime }),
          }),
    };
  }

  private async writeExclusive(
    record: WorkflowNamespaceLeaseRecord,
  ): Promise<void> {
    const file = await open(this.path, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async read(): Promise<WorkflowNamespaceLeaseRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as
        WorkflowNamespaceLeaseRecord | undefined;
      if (
        !parsed ||
        parsed.schemaVersion !== 1 ||
        typeof parsed.ownerId !== "string" ||
        typeof parsed.leaseToken !== "string" ||
        !Number.isSafeInteger(parsed.epoch) ||
        !Number.isSafeInteger(parsed.acquiredAt) ||
        (parsed.processId !== undefined &&
          (!Number.isSafeInteger(parsed.processId) || parsed.processId <= 0))
      ) {
        return undefined;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Workflow namespace lease is corrupt", { cause: error });
    }
  }
}

function isProcessAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}
