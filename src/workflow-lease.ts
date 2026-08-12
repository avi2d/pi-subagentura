import { mkdir, open, readFile, rm, lstat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

const CURRENT_PROCESS_START_TIME = Math.floor(
  Date.now() - process.uptime() * 1000,
);

export interface WorkflowNamespaceLeaseRecord {
  schemaVersion: 1;
  ownerId: string;
  leaseToken: string;
  ownerGeneration?: number;
  epoch: number;
  acquiredAt: number;
  processId?: number;
  processStartTime?: number;
}

export interface WorkflowOwnerFence {
  ownerId: string;
  leaseToken: string;
  ownerGeneration?: number;
  leaseEpoch: number;
}

export interface WorkflowNamespaceLeaseOptions {
  rootDir: string;
  namespace: string;
  ownerId: string;
  leaseToken: string;
  ownerGeneration?: number;
  staleAfterMs?: number;
  now?: () => number;
  processId?: number;
  processStartTime?: number;
  processStartTimeForPid?: (
    processId: number,
  ) => number | undefined | Promise<number | undefined>;
}

/**
 * Exclusive writer lease for one workflow namespace.
 *
 * The lease file is intentionally ephemeral, while namespace.epoch is
 * persistent. Every successful acquisition consumes the next persisted epoch,
 * including reacquisition after a clean release. This makes a lease epoch a
 * durable fence rather than a property of the lease-file lifetime.
 */
export class WorkflowNamespaceLease {
  private readonly path: string;
  private readonly epochPath: string;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly processStartTimeForPid: (
    processId: number,
  ) => number | undefined | Promise<number | undefined>;
  private epoch = 0;
  private held = false;

  public constructor(private readonly options: WorkflowNamespaceLeaseOptions) {
    if (!options.ownerId || !options.leaseToken || !options.namespace) {
      throw new Error("Invalid workflow namespace lease identity");
    }
    if (
      options.ownerGeneration !== undefined &&
      (!Number.isSafeInteger(options.ownerGeneration) ||
        options.ownerGeneration < 0)
    ) {
      throw new Error("Invalid workflow namespace lease generation");
    }
    if (
      options.staleAfterMs !== undefined &&
      (!Number.isSafeInteger(options.staleAfterMs) || options.staleAfterMs <= 0)
    ) {
      throw new Error("Invalid workflow namespace lease timeout");
    }
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    this.processStartTimeForPid =
      options.processStartTimeForPid ??
      ((processId) =>
        processId === process.pid ? CURRENT_PROCESS_START_TIME : undefined);
    const namespaceDir = join(options.rootDir, options.namespace);
    this.path = join(namespaceDir, "namespace.lease");
    this.epochPath = join(namespaceDir, "namespace.epoch");
  }

  public get leaseEpoch(): number {
    return this.epoch;
  }

  public get isHeld(): boolean {
    return this.held;
  }

  public get activeOwnerFence(): WorkflowOwnerFence | undefined {
    if (!this.held) return undefined;
    return {
      ownerId: this.options.ownerId,
      leaseToken: this.options.leaseToken,
      ...(this.options.ownerGeneration === undefined
        ? {}
        : { ownerGeneration: this.options.ownerGeneration }),
      leaseEpoch: this.epoch,
    };
  }

  public belongsTo(
    ownerId: string,
    leaseToken: string,
    ownerGeneration?: number,
  ): boolean {
    return (
      this.options.ownerId === ownerId &&
      this.options.leaseToken === leaseToken &&
      (ownerGeneration === undefined ||
        this.options.ownerGeneration === undefined ||
        this.options.ownerGeneration === ownerGeneration)
    );
  }

  public async acquire(): Promise<WorkflowNamespaceLeaseRecord> {
    if (this.held) {
      await this.assertHeld();
      const current = await this.read();
      if (!current) throw new Error("Workflow namespace lease is not held");
      return current;
    }
    await mkdir(join(this.options.rootDir, this.options.namespace), {
      recursive: true,
      mode: 0o700,
    });

    // Read before consuming an epoch so a normal contention failure does not
    // needlessly skip the current owner epoch.
    const existing = await this.read();
    if (existing) {
      const sameOwner =
        existing.ownerId === this.options.ownerId &&
        existing.leaseToken === this.options.leaseToken &&
        (this.options.ownerGeneration === undefined ||
          existing.ownerGeneration === undefined ||
          existing.ownerGeneration === this.options.ownerGeneration);
      if (sameOwner) {
        this.epoch = existing.epoch;
        this.held = true;
        return existing;
      }
      if (this.now() - existing.acquiredAt < this.staleAfterMs) {
        throw new Error("Workflow namespace lease is held");
      }
      await this.assertTakeoverIdentity(existing);
      const persistedEpoch = await this.readPersistedEpoch();
      const replacementEpoch = Math.max(persistedEpoch + 1, existing.epoch + 1);
      const replacement = this.record(replacementEpoch);
      // Persist the counter before removing the stale file. A crash between
      // these operations can leave a gap, but can never repeat an epoch.
      await this.persistEpoch(replacement.epoch);
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

    const record = this.record((await this.readPersistedEpoch()) + 1);
    await this.persistEpoch(record.epoch);
    try {
      await this.writeExclusive(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await this.read();
      if (!current) {
        throw new Error("Workflow namespace lease evidence is ambiguous");
      }
      const sameOwner =
        current.ownerId === this.options.ownerId &&
        current.leaseToken === this.options.leaseToken &&
        (this.options.ownerGeneration === undefined ||
          current.ownerGeneration === undefined ||
          current.ownerGeneration === this.options.ownerGeneration);
      if (sameOwner) {
        this.epoch = current.epoch;
        this.held = true;
        return current;
      }
      if (this.now() - current.acquiredAt < this.staleAfterMs) {
        throw new Error("Workflow namespace lease is held");
      }
      await this.assertTakeoverIdentity(current);
      const persistedEpoch = await this.readPersistedEpoch();
      const replacement = this.record(
        Math.max(persistedEpoch + 1, current.epoch + 1),
      );
      await this.persistEpoch(replacement.epoch);
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
    // Do not reset epoch: callers retain the fence that must be rejected after
    // reacquisition, and the persisted counter remains authoritative.
    this.held = false;
  }

  public async assertHeld(): Promise<void> {
    const current = await this.read();
    if (
      !this.held ||
      !current ||
      current.ownerId !== this.options.ownerId ||
      current.leaseToken !== this.options.leaseToken ||
      current.epoch !== this.epoch ||
      (this.options.ownerGeneration !== undefined &&
        current.ownerGeneration !== this.options.ownerGeneration)
    ) {
      throw new Error("Workflow namespace lease is not held");
    }
    const persistedEpoch = await this.readPersistedEpoch();
    if (persistedEpoch !== this.epoch) {
      throw new Error("Workflow namespace lease epoch changed");
    }
  }

  private record(epoch: number): WorkflowNamespaceLeaseRecord {
    return {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      leaseToken: this.options.leaseToken,
      ...(this.options.ownerGeneration === undefined
        ? {}
        : { ownerGeneration: this.options.ownerGeneration }),
      epoch,
      acquiredAt: this.now(),
      processId: this.options.processId ?? process.pid,
      processStartTime:
        this.options.processStartTime ?? CURRENT_PROCESS_START_TIME,
    };
  }

  private async assertTakeoverIdentity(
    current: WorkflowNamespaceLeaseRecord,
  ): Promise<void> {
    const processId = current.processId;
    const processStartTime = current.processStartTime;
    if (
      typeof processId !== "number" ||
      !Number.isSafeInteger(processId) ||
      processId <= 0 ||
      typeof processStartTime !== "number" ||
      !Number.isSafeInteger(processStartTime) ||
      processStartTime <= 0
    ) {
      throw new Error("Workflow namespace lease process identity is ambiguous");
    }
    if (!isProcessAlive(processId)) return;
    const observedStart = await this.processStartTimeForPid(processId);
    if (observedStart === undefined) {
      throw new Error("Workflow namespace lease process identity is ambiguous");
    }
    if (observedStart === processStartTime) {
      throw new Error("Workflow namespace lease is held by a live process");
    }
    // A live PID with a different verified start time is a reused PID and the
    // stale lease can be replaced safely.
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

  private async readPersistedEpoch(): Promise<number> {
    try {
      const info = await lstat(this.epochPath);
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error("Workflow namespace epoch path is not regular");
      }
      const text = await readFile(this.epochPath, "utf8");
      const epoch = Number(text.trim());
      if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new Error("Workflow namespace epoch is corrupt");
      }
      return epoch;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      if (error instanceof Error && error.message.includes("epoch"))
        throw error;
      throw new Error("Workflow namespace epoch is corrupt", { cause: error });
    }
  }

  private async persistEpoch(epoch: number): Promise<void> {
    if (!Number.isSafeInteger(epoch) || epoch <= 0) {
      throw new Error("Workflow namespace epoch is corrupt");
    }
    const file = await open(
      this.epochPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(`${epoch}\n`, "utf8");
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
        parsed.epoch <= 0 ||
        !Number.isSafeInteger(parsed.acquiredAt) ||
        (parsed.processId !== undefined &&
          (!Number.isSafeInteger(parsed.processId) || parsed.processId <= 0)) ||
        (parsed.processStartTime !== undefined &&
          (!Number.isSafeInteger(parsed.processStartTime) ||
            parsed.processStartTime <= 0)) ||
        (parsed.ownerGeneration !== undefined &&
          (!Number.isSafeInteger(parsed.ownerGeneration) ||
            parsed.ownerGeneration < 0))
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
