import { constants as fsConstants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

export interface WorkflowNamespaceLeaseRecord {
  schemaVersion: 1;
  ownerId: string;
  leaseToken: string;
  epoch: number;
  acquiredAt: number;
  processId: number;
  processStartTime: number;
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

interface FileIdentity {
  dev: number;
  ino: number;
}

interface OpenDirectory {
  file: FileHandle;
  identity: FileIdentity;
}

interface WorkflowInterlockRecord {
  schemaVersion: 1;
  ownerId: string;
  leaseToken: string;
  lockToken: string;
  acquiredAt: number;
  processId: number;
  processStartTime: number;
}

interface WorkflowNamespaceEpochRecord {
  schemaVersion: 1;
  epoch: number;
}

export class WorkflowNamespaceAuthorityError extends Error {
  public readonly code = "WORKFLOW_NAMESPACE_AUTHORITY" as const;

  public constructor(message: string) {
    super(message);
    this.name = "WorkflowNamespaceAuthorityError";
  }
}

const SAFE_NAMESPACE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MAX_ID_BYTES = 256;
const MAX_EPOCH_BYTES = 1024;
const MAX_LEASE_BYTES = 4096;
const MAX_INTERLOCK_BYTES = 4096;
const activeInterlocks = new Set<string>();
const PROCESS_START_TIME = Math.floor(Date.now() - process.uptime() * 1000);

/**
 * Exclusive process-writer authority for one durable workflow namespace.
 *
 * Lease replacement is permitted only when the prior process can be proved
 * dead (or the current PID has a different process-start identity). Invalid or
 * ambiguous evidence fails closed. Every mutation is additionally protected by
 * a create-only filesystem interlock, closing check/mutate races.
 */
export class WorkflowNamespaceLease {
  private readonly namespacePath: string;
  private readonly leasePath: string;
  private readonly epochPath: string;
  private readonly interlockPath: string;
  private readonly now: () => number;
  private readonly processId: number;
  private readonly processStartTime: number;
  private epoch = 0;
  private held = false;
  private interlockDepth = 0;
  private interlockFile?: FileHandle;
  private interlockIdentity?: FileIdentity;
  private interlockDirectory?: OpenDirectory;
  private interlockRootDirectory?: OpenDirectory;

  public constructor(private readonly options: WorkflowNamespaceLeaseOptions) {
    assertBoundedId(options.ownerId, "owner ID");
    assertBoundedId(options.leaseToken, "lease token");
    if (!SAFE_NAMESPACE.test(options.namespace)) {
      throw new Error("Invalid workflow namespace lease name");
    }
    if (!options.rootDir || Buffer.byteLength(options.rootDir, "utf8") > 4096) {
      throw new Error("Invalid workflow namespace lease root");
    }
    if (
      options.staleAfterMs !== undefined &&
      (!Number.isSafeInteger(options.staleAfterMs) || options.staleAfterMs <= 0)
    ) {
      throw new Error("Invalid workflow namespace lease timeout");
    }
    this.processId = options.processId ?? process.pid;
    this.processStartTime =
      options.processStartTime ?? currentProcessStartTime();
    if (!Number.isSafeInteger(this.processId) || this.processId <= 0) {
      throw new Error("Invalid workflow namespace lease process ID");
    }
    if (
      !Number.isSafeInteger(this.processStartTime) ||
      this.processStartTime < 0
    ) {
      throw new Error("Invalid workflow namespace lease process start time");
    }
    this.now = options.now ?? Date.now;
    this.namespacePath = join(options.rootDir, options.namespace);
    this.leasePath = join(this.namespacePath, "namespace.lease");
    this.epochPath = join(this.namespacePath, "namespace.epoch");
    this.interlockPath = join(this.namespacePath, "namespace.interlock");
  }

  public get leaseEpoch(): number {
    return this.epoch;
  }

  public get isHeld(): boolean {
    return this.held;
  }

  public belongsTo(ownerId: string, leaseToken: string): boolean {
    return (
      this.options.ownerId === ownerId && this.options.leaseToken === leaseToken
    );
  }

  public async acquire(): Promise<WorkflowNamespaceLeaseRecord> {
    if (this.held) {
      await this.assertHeld();
      const record = await this.readLease();
      if (!record) throw new Error("Workflow namespace lease disappeared");
      return record;
    }

    await this.ensureNamespaceDirectory();
    return this.withInterlock(async () => {
      const first = this.makeLeaseRecord((await this.readEpoch()) + 1);
      try {
        await this.writeLeaseExclusive(first);
        await this.persistEpoch(first.epoch);
        this.epoch = first.epoch;
        this.held = true;
        return first;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const current = await this.readLease();
      if (!current) {
        throw new Error(
          "Workflow namespace lease evidence is invalid or ambiguous",
        );
      }

      if (
        current.ownerId === this.options.ownerId &&
        current.leaseToken === this.options.leaseToken &&
        current.processId === this.processId &&
        current.processStartTime === this.processStartTime
      ) {
        await this.persistEpoch(current.epoch);
        this.epoch = current.epoch;
        this.held = true;
        return current;
      }

      if (!isProvablyDead(current.processId, current.processStartTime)) {
        throw new Error(
          "Workflow namespace lease is held by a live or ambiguous process",
        );
      }

      const replacement = this.makeLeaseRecord(
        Math.max(current.epoch, await this.readEpoch()) + 1,
      );
      await this.persistEpoch(replacement.epoch);
      await removeVerifiedFile(this.leasePath);
      await this.withNamespaceDirectory(async (directory) => {
        await directory.file.sync();
      });
      try {
        await this.writeLeaseExclusive(replacement);
      } catch (error) {
        throw new Error("Workflow namespace lease takeover raced", {
          cause: error,
        });
      }
      this.epoch = replacement.epoch;
      this.held = true;
      return replacement;
    });
  }

  public async release(): Promise<void> {
    if (!this.held) return;
    await this.withInterlock(async () => {
      const current = await this.readLease();
      if (
        current?.ownerId === this.options.ownerId &&
        current.leaseToken === this.options.leaseToken &&
        current.epoch === this.epoch &&
        current.processId === this.processId &&
        current.processStartTime === this.processStartTime
      ) {
        await this.persistEpoch(current.epoch);
        await removeVerifiedFile(this.leasePath);
        await this.withNamespaceDirectory(async (directory) => {
          await directory.file.sync();
        });
      }
      this.held = false;
    });
  }

  public async assertHeld(): Promise<void> {
    if (this.interlockDepth > 0) {
      await this.assertHeldUnlocked();
      return;
    }
    await this.withInterlock(() => this.assertHeldUnlocked());
  }

  /** Run a filesystem mutation while this exact lease record is interlocked. */
  public async withAuthority<T>(operation: () => Promise<T>): Promise<T> {
    await this.enterInterlock();
    try {
      await this.assertHeldUnlocked();
      return await operation();
    } finally {
      await this.leaveInterlock();
    }
  }

  private async assertHeldUnlocked(): Promise<void> {
    const current = await this.readLease();
    if (
      !this.held ||
      !current ||
      current.ownerId !== this.options.ownerId ||
      current.leaseToken !== this.options.leaseToken ||
      current.epoch !== this.epoch ||
      current.processId !== this.processId ||
      current.processStartTime !== this.processStartTime
    ) {
      this.held = false;
      throw new Error("Workflow namespace lease is not held");
    }
  }

  private makeLeaseRecord(epoch: number): WorkflowNamespaceLeaseRecord {
    const acquiredAt = this.now();
    if (
      !isPositiveSafeInteger(epoch) ||
      !isNonnegativeSafeInteger(acquiredAt)
    ) {
      throw new Error("Invalid workflow namespace lease record");
    }
    return {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      leaseToken: this.options.leaseToken,
      epoch,
      acquiredAt,
      processId: this.processId,
      processStartTime: this.processStartTime,
    };
  }

  private makeInterlockRecord(): WorkflowInterlockRecord {
    return {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      leaseToken: this.options.leaseToken,
      lockToken: randomUUID(),
      acquiredAt: this.now(),
      processId: this.processId,
      processStartTime: this.processStartTime,
    };
  }

  private async ensureNamespaceDirectory(): Promise<void> {
    await mkdir(this.options.rootDir, { recursive: true, mode: 0o700 });
    const root = await openVerifiedDirectory(this.options.rootDir);
    try {
      const namespace = await openOrCreateDirectory(
        root,
        this.options.rootDir,
        this.namespacePath,
      );
      await namespace.file.close();
    } finally {
      await root.file.close();
    }
  }

  private async withInterlock<T>(operation: () => Promise<T>): Promise<T> {
    await this.enterInterlock();
    try {
      return await operation();
    } finally {
      await this.leaveInterlock();
    }
  }

  private async enterInterlock(): Promise<void> {
    if (this.interlockDepth > 0) {
      this.interlockDepth++;
      return;
    }
    if (activeInterlocks.has(this.interlockPath)) {
      throw new Error("Workflow namespace lease interlock is held");
    }

    const rootDirectory = await openVerifiedDirectory(this.options.rootDir);
    let directory: OpenDirectory;
    try {
      await assertDirectoryDescriptorAndTarget(
        rootDirectory.file,
        this.options.rootDir,
        rootDirectory.identity,
      );
      directory = await openVerifiedDirectory(this.namespacePath);
      await assertDirectoryDescriptorAndTarget(
        rootDirectory.file,
        this.options.rootDir,
        rootDirectory.identity,
      );
    } catch (error) {
      await rootDirectory.file.close();
      throw error;
    }
    let retainedDirectory = false;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let file: FileHandle | undefined;
        try {
          await assertDirectoryDescriptorAndTarget(
            rootDirectory.file,
            this.options.rootDir,
            rootDirectory.identity,
          );
          await assertDirectoryDescriptorAndTarget(
            directory.file,
            this.namespacePath,
            directory.identity,
          );
          file = await open(
            this.interlockPath,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_NOFOLLOW,
            0o600,
          );
          await assertDirectoryDescriptorAndTarget(
            directory.file,
            this.namespacePath,
            directory.identity,
          );
          await assertDirectoryDescriptorAndTarget(
            rootDirectory.file,
            this.options.rootDir,
            rootDirectory.identity,
          );
          activeInterlocks.add(this.interlockPath);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === "EEXIST" &&
            attempt === 0 &&
            (await recoverStaleInterlock(
              this.interlockPath,
              directory,
              this.namespacePath,
            ))
          ) {
            continue;
          }
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error("Workflow namespace lease interlock is held", {
              cause: error,
            });
          }
          throw error;
        }
        if (!file) {
          throw new Error("Workflow namespace interlock file was not opened");
        }

        try {
          const stats = await file.stat();
          assertRegularFileStats(this.interlockPath, stats);
          const identity = fileIdentity(stats);
          const bytes = Buffer.from(
            `${JSON.stringify(this.makeInterlockRecord())}\n`,
            "utf8",
          );
          await writeFully(file, bytes);
          await file.sync();
          await assertDescriptorAndTarget(file, this.interlockPath, identity);
          await assertDirectoryDescriptorAndTarget(
            directory.file,
            this.namespacePath,
            directory.identity,
          );
          await assertDirectoryDescriptorAndTarget(
            rootDirectory.file,
            this.options.rootDir,
            rootDirectory.identity,
          );
          this.interlockFile = file;
          this.interlockIdentity = identity;
          this.interlockDirectory = directory;
          this.interlockRootDirectory = rootDirectory;
          this.interlockDepth = 1;
          retainedDirectory = true;
          return;
        } catch (error) {
          activeInterlocks.delete(this.interlockPath);
          await file.close();
          try {
            await removeVerifiedFile(this.interlockPath);
            await directory.file.sync();
            await assertDirectoryDescriptorAndTarget(
              directory.file,
              this.namespacePath,
              directory.identity,
            );
            await assertDirectoryDescriptorAndTarget(
              rootDirectory.file,
              this.options.rootDir,
              rootDirectory.identity,
            );
          } catch (cleanupError) {
            throw new Error("Failed to clean workflow namespace interlock", {
              cause: new AggregateError([error, cleanupError]),
            });
          }
          throw error;
        }
      }
      throw new Error("Workflow namespace lease interlock acquisition failed");
    } finally {
      if (!retainedDirectory) {
        try {
          await directory.file.close();
        } finally {
          await rootDirectory.file.close();
        }
      }
    }
  }

  private async leaveInterlock(): Promise<void> {
    if (this.interlockDepth === 0) return;
    this.interlockDepth--;
    if (this.interlockDepth > 0) return;
    const file = this.interlockFile;
    const identity = this.interlockIdentity;
    const directory = this.interlockDirectory;
    const rootDirectory = this.interlockRootDirectory;
    this.interlockFile = undefined;
    this.interlockIdentity = undefined;
    this.interlockDirectory = undefined;
    this.interlockRootDirectory = undefined;
    try {
      if (!file || !identity || !directory || !rootDirectory) {
        throw new Error("Workflow namespace lease interlock state is missing");
      }
      await assertDescriptorAndTarget(file, this.interlockPath, identity);
      await assertDirectoryDescriptorAndTarget(
        directory.file,
        this.namespacePath,
        directory.identity,
      );
      await assertDirectoryDescriptorAndTarget(
        rootDirectory.file,
        this.options.rootDir,
        rootDirectory.identity,
      );
      await rm(this.interlockPath, { force: false });
      await directory.file.sync();
      await assertDirectoryDescriptorAndTarget(
        directory.file,
        this.namespacePath,
        directory.identity,
      );
      await assertDirectoryDescriptorAndTarget(
        rootDirectory.file,
        this.options.rootDir,
        rootDirectory.identity,
      );
    } finally {
      activeInterlocks.delete(this.interlockPath);
      await file?.close();
      try {
        await directory?.file.close();
      } finally {
        await rootDirectory?.file.close();
      }
    }
  }

  private async withNamespaceDirectory<T>(
    operation: (directory: OpenDirectory) => Promise<T>,
  ): Promise<T> {
    const retained = this.interlockDirectory;
    const retainedRoot = this.interlockRootDirectory;
    if (Boolean(retained) !== Boolean(retainedRoot)) {
      throw new WorkflowNamespaceAuthorityError(
        "Workflow namespace directory authority is incomplete",
      );
    }
    const root =
      retainedRoot ?? (await openVerifiedDirectory(this.options.rootDir));
    let directory = retained;
    try {
      await assertDirectoryDescriptorAndTarget(
        root.file,
        this.options.rootDir,
        root.identity,
      );
      directory ??= await openVerifiedDirectory(this.namespacePath);
      await assertDirectoryDescriptorAndTarget(
        root.file,
        this.options.rootDir,
        root.identity,
      );
      await assertDirectoryDescriptorAndTarget(
        directory.file,
        this.namespacePath,
        directory.identity,
      );
      return await operation(directory);
    } finally {
      try {
        if (directory) {
          await assertDirectoryDescriptorAndTarget(
            directory.file,
            this.namespacePath,
            directory.identity,
          );
        }
        await assertDirectoryDescriptorAndTarget(
          root.file,
          this.options.rootDir,
          root.identity,
        );
      } finally {
        if (!retained) {
          try {
            await directory?.file.close();
          } finally {
            await root.file.close();
          }
        }
      }
    }
  }

  private async writeLeaseExclusive(
    record: WorkflowNamespaceLeaseRecord,
  ): Promise<void> {
    await this.withNamespaceDirectory(async (directory) => {
      const file = await open(
        this.leasePath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stats = await file.stat();
        assertRegularFileStats(this.leasePath, stats);
        const identity = fileIdentity(stats);
        await writeFully(
          file,
          Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
        );
        await file.sync();
        await assertDescriptorAndTarget(file, this.leasePath, identity);
      } finally {
        await file.close();
      }
      await directory.file.sync();
    });
  }

  private async readEpoch(): Promise<number> {
    return this.withNamespaceDirectory(async () => {
      let file: FileHandle | undefined;
      try {
        file = await openVerifiedFile(
          this.epochPath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const bytes = await readBoundedFile(
          file,
          this.epochPath,
          MAX_EPOCH_BYTES,
        );
        const parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown;
        if (
          !isPlainRecord(parsed) ||
          !hasExactKeys(parsed, ["schemaVersion", "epoch"]) ||
          parsed.schemaVersion !== 1 ||
          !isPositiveSafeInteger(parsed.epoch)
        ) {
          throw new Error("Invalid workflow namespace epoch record");
        }
        return parsed.epoch;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw new Error("Workflow namespace epoch is corrupt", {
          cause: error,
        });
      } finally {
        await file?.close();
      }
    });
  }

  private async persistEpoch(epoch: number): Promise<void> {
    if (!isPositiveSafeInteger(epoch)) {
      throw new Error("Invalid workflow namespace epoch");
    }
    const current = await this.readEpoch();
    if (current >= epoch) return;
    await this.withNamespaceDirectory(async (directory) => {
      const temporaryPath = `${this.epochPath}.${randomUUID()}.tmp`;
      const file = await open(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stats = await file.stat();
        assertRegularFileStats(temporaryPath, stats);
        const identity = fileIdentity(stats);
        const record: WorkflowNamespaceEpochRecord = {
          schemaVersion: 1,
          epoch,
        };
        await writeFully(
          file,
          Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
        );
        await file.sync();
        await assertDescriptorAndTarget(file, temporaryPath, identity);
        await rename(temporaryPath, this.epochPath);
        await assertDescriptorAndTarget(file, this.epochPath, identity);
        await directory.file.sync();
      } finally {
        await file.close();
      }
    });
    if ((await this.readEpoch()) !== epoch) {
      throw new Error("Workflow namespace epoch publication failed");
    }
  }

  private async readLease(): Promise<WorkflowNamespaceLeaseRecord | undefined> {
    return this.withNamespaceDirectory(async () => {
      let file: FileHandle | undefined;
      try {
        file = await openVerifiedFile(
          this.leasePath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const bytes = await readBoundedFile(
          file,
          this.leasePath,
          MAX_LEASE_BYTES,
        );
        const parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        return validateLeaseRecord(parsed) ? parsed : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw new Error("Workflow namespace lease is corrupt", {
          cause: error,
        });
      } finally {
        await file?.close();
      }
    });
  }
}

async function recoverStaleInterlock(
  path: string,
  directory: OpenDirectory,
  directoryPath: string,
): Promise<boolean> {
  let file: FileHandle | undefined;
  try {
    await assertDirectoryDescriptorAndTarget(
      directory.file,
      directoryPath,
      directory.identity,
    );
    file = await openVerifiedFile(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const bytes = await readBoundedFile(file, path, MAX_INTERLOCK_BYTES);
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (!validateInterlockRecord(parsed)) {
      throw new Error("Workflow namespace interlock is corrupt");
    }
    if (!isProvablyDead(parsed.processId, parsed.processStartTime))
      return false;
    await assertDescriptorAndTarget(file, path);
    await assertDirectoryDescriptorAndTarget(
      directory.file,
      directoryPath,
      directory.identity,
    );
    await rm(path, { force: false });
    await directory.file.sync();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  } finally {
    await file?.close();
    await assertDirectoryDescriptorAndTarget(
      directory.file,
      directoryPath,
      directory.identity,
    );
  }
}

function validateLeaseRecord(
  value: unknown,
): value is WorkflowNamespaceLeaseRecord {
  if (!isPlainRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "ownerId",
      "leaseToken",
      "epoch",
      "acquiredAt",
      "processId",
      "processStartTime",
    ])
  )
    return false;
  return (
    value.schemaVersion === 1 &&
    isBoundedId(value.ownerId) &&
    isBoundedId(value.leaseToken) &&
    isNonnegativeSafeInteger(value.acquiredAt) &&
    isPositiveSafeInteger(value.epoch) &&
    isPositiveSafeInteger(value.processId) &&
    isNonnegativeSafeInteger(value.processStartTime)
  );
}

function validateInterlockRecord(
  value: unknown,
): value is WorkflowInterlockRecord {
  if (!isPlainRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "ownerId",
      "leaseToken",
      "lockToken",
      "acquiredAt",
      "processId",
      "processStartTime",
    ])
  )
    return false;
  return (
    value.schemaVersion === 1 &&
    isBoundedId(value.ownerId) &&
    isBoundedId(value.leaseToken) &&
    typeof value.lockToken === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.lockToken) &&
    isNonnegativeSafeInteger(value.acquiredAt) &&
    isPositiveSafeInteger(value.processId) &&
    isNonnegativeSafeInteger(value.processStartTime)
  );
}

function isProvablyDead(processId: number, processStartTime: number): boolean {
  if (
    processId === process.pid &&
    processStartTime !== currentProcessStartTime()
  ) {
    return true;
  }
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}

function currentProcessStartTime(): number {
  return PROCESS_START_TIME;
}

function assertBoundedId(value: string, label: string): void {
  if (!isBoundedId(value))
    throw new Error(`Invalid workflow namespace ${label}`);
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function fileIdentity(info: Pick<Stats, "dev" | "ino">): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularDirectoryStats(path: string, info: Stats): void {
  if (!info.isDirectory()) {
    throw new WorkflowNamespaceAuthorityError(
      `Workflow storage authority is not a directory: ${path}`,
    );
  }
  assertEffectiveOwner(path, info);
  if ((info.mode & 0o077) !== 0) {
    throw new WorkflowNamespaceAuthorityError(
      `Workflow storage directory grants group or other access: ${path}`,
    );
  }
}

function assertRegularFileStats(path: string, info: Stats): void {
  if (!info.isFile() || info.nlink !== 1) {
    throw new WorkflowNamespaceAuthorityError(
      `Workflow storage authority is not a regular single-link file: ${path}`,
    );
  }
  assertEffectiveOwner(path, info);
  if ((info.mode & 0o077) !== 0) {
    throw new WorkflowNamespaceAuthorityError(
      `Workflow storage file grants group or other access: ${path}`,
    );
  }
}

function assertEffectiveOwner(path: string, info: Stats): void {
  if (typeof process.geteuid === "function" && info.uid !== process.geteuid()) {
    throw new WorkflowNamespaceAuthorityError(
      `Workflow storage authority has an unexpected owner: ${path}`,
    );
  }
}

async function openVerifiedFile(path: string, flags: number) {
  const before = await lstat(path);
  assertRegularFileStats(path, before);
  const identity = fileIdentity(before);
  let file: FileHandle | undefined;
  try {
    file = await open(path, flags, 0o600);
    await assertDescriptorAndTarget(file, path, identity);
    return file;
  } catch (error) {
    await file?.close();
    throw error;
  }
}

async function openVerifiedDirectory(path: string): Promise<OpenDirectory> {
  const before = await lstat(path);
  assertRegularDirectoryStats(path, before);
  const identity = fileIdentity(before);
  let file: FileHandle | undefined;
  try {
    file = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    await assertDirectoryDescriptorAndTarget(file, path, identity);
    return { file, identity };
  } catch (error) {
    await file?.close();
    throw error;
  }
}

async function openOrCreateDirectory(
  parent: OpenDirectory,
  parentPath: string,
  path: string,
): Promise<OpenDirectory> {
  await assertDirectoryDescriptorAndTarget(
    parent.file,
    parentPath,
    parent.identity,
  );
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directory = await openVerifiedDirectory(path);
  try {
    await assertDirectoryDescriptorAndTarget(
      parent.file,
      parentPath,
      parent.identity,
    );
    if (created) await parent.file.sync();
    await assertDirectoryDescriptorAndTarget(
      parent.file,
      parentPath,
      parent.identity,
    );
    return directory;
  } catch (error) {
    await directory.file.close();
    throw error;
  }
}

async function readBoundedFile(
  file: FileHandle,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const before = await file.stat();
  assertRegularFileStats(path, before);
  if (before.size < 0 || before.size > maxBytes) {
    throw new Error("Workflow namespace authority file exceeds its size bound");
  }
  const identity = fileIdentity(before);
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maxBytes) {
    const requested = Math.min(4096, maxBytes + 1 - position);
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await file.read(chunk, 0, requested, position);
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead < 0 ||
      bytesRead > requested
    ) {
      throw new Error("Workflow namespace authority returned an invalid read");
    }
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
    if (position > maxBytes) {
      throw new Error(
        "Workflow namespace authority file exceeds its size bound",
      );
    }
  }
  const after = await file.stat();
  assertRegularFileStats(path, after);
  if (
    !sameFileIdentity(identity, fileIdentity(after)) ||
    before.size !== after.size ||
    after.size !== position ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new WorkflowNamespaceAuthorityError(
      `Workflow namespace authority file changed while being read: ${path}`,
    );
  }
  await assertDescriptorAndTarget(file, path, identity);
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0]!;
  return Buffer.concat(chunks, position);
}

async function assertDescriptorAndTarget(
  file: FileHandle,
  path: string,
  expected?: FileIdentity,
): Promise<void> {
  const descriptor = await file.stat();
  const target = await lstat(path);
  assertRegularFileStats(path, descriptor);
  assertRegularFileStats(path, target);
  const actual = fileIdentity(target);
  const opened = fileIdentity(descriptor);
  if (
    (expected && !sameFileIdentity(actual, expected)) ||
    !sameFileIdentity(opened, actual)
  ) {
    throw new WorkflowNamespaceAuthorityError(
      `Workflow storage file authority changed: ${path}`,
    );
  }
}

async function assertDirectoryDescriptorAndTarget(
  file: FileHandle,
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const descriptor = await file.stat();
  const target = await lstat(path);
  assertRegularDirectoryStats(path, descriptor);
  assertRegularDirectoryStats(path, target);
  const actual = fileIdentity(target);
  const opened = fileIdentity(descriptor);
  if (
    !sameFileIdentity(actual, expected) ||
    !sameFileIdentity(opened, actual)
  ) {
    throw new WorkflowNamespaceAuthorityError(
      `Workflow storage directory authority changed: ${path}`,
    );
  }
}

async function removeVerifiedFile(path: string): Promise<void> {
  const file = await openVerifiedFile(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const identity = fileIdentity(await file.stat());
    await assertDescriptorAndTarget(file, path, identity);
    await rm(path, { force: false });
  } finally {
    await file.close();
  }
}

async function writeFully(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error("Workflow namespace lease short write");
    }
    offset += bytesWritten;
  }
}
