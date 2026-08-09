import { constants as fsConstants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  decodeDurableValue,
  encodeDurableValue,
  toDurableValue,
  type DurableValue,
} from "./workflow-durable-value";
import { WorkflowNamespaceLease } from "./workflow-lease";
import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import {
  validateWorkflowRunId,
  type WorkflowAppendReceipt,
  type WorkflowEventEnvelope,
  type WorkflowOutcomeBlobRef,
  type WorkflowOwnerIdentity,
  type WorkflowRunLaunch,
} from "./workflow-run-types";

export type WorkflowConditionalAppendResult =
  | { status: "appended"; receipt: WorkflowAppendReceipt }
  | {
      status: "conflict";
      actualLastEventOrdinal: number;
      actualRunEpoch: number;
    };

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

export interface WorkflowRunCreationReceipt {
  readonly launch: WorkflowRunLaunch;
  readonly initialEvent: WorkflowEventEnvelope<
    "run_created",
    { plan: WorkflowPlan }
  >;
}
export interface WorkflowRunCreationEvent<P = unknown> {
  type: "run_created";
  payload: P;
  runEpoch?: number;
}

export class WorkflowRunCorruptionError extends Error {
  public readonly code = "WORKFLOW_RUN_CORRUPT" as const;

  public constructor(
    public readonly runId: string,
    cause: unknown,
  ) {
    super(`Durable workflow run ${runId} is corrupt`, { cause });
    this.name = "WorkflowRunCorruptionError";
  }
}

export class WorkflowRunStorageError extends Error {
  public readonly code = "ENOSPC" as const;

  public constructor(
    public readonly runId: string,
    cause: unknown,
  ) {
    super(`Durable workflow run ${runId} could not be persisted`, { cause });
    this.name = "WorkflowRunStorageError";
  }
}

export class WorkflowRunAuthorityError extends Error {
  public readonly code = "WORKFLOW_RUN_AUTHORITY" as const;

  public constructor(message: string) {
    super(message);
    this.name = "WorkflowRunAuthorityError";
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface OpenDirectory {
  file: FileHandle;
  identity: FileIdentity;
}

interface OpenRunAuthority {
  runsDirectory: OpenDirectory;
  runDirectory: OpenDirectory;
  runsPath: string;
  runPath: string;
}

interface ParsedJournal {
  events: WorkflowEventEnvelope[];
  completeBytes: number;
  tornTailBytes: number;
}

interface ReadRunResult {
  record: WorkflowRunRecord;
  completeBytes: number;
  tornTailBytes: number;
}

const CREATION_PREFIX = ".creating-";
const WRITING_PREFIX = ".writing-";
const RUN_EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OWNER_PATH_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_LAUNCH_BYTES = 64 * 1024;
const MAX_OUTCOME_BYTES = 256 * 1024;

/** Owner-scoped, lease-fenced authoritative NDJSON run store. */
export class WorkflowRunStore {
  private static readonly leases = new Map<string, WorkflowNamespaceLease>();
  private static readonly locks = new Map<string, Promise<void>>();
  private readonly root: string;
  private revoked = false;

  public static async releaseAllLeases(owner?: {
    ownerId: string;
    leaseToken: string;
  }): Promise<void> {
    for (const [key, lease] of [...WorkflowRunStore.leases]) {
      if (owner && !lease.belongsTo(owner.ownerId, owner.leaseToken)) continue;
      await lease.release();
      if (WorkflowRunStore.leases.get(key) === lease) {
        WorkflowRunStore.leases.delete(key);
      }
    }
  }

  public constructor(private readonly options: WorkflowRunStoreOptions) {
    if (!options.rootDir || Buffer.byteLength(options.rootDir, "utf8") > 4096) {
      throw new Error("Invalid workflow store root directory");
    }
    validateOwnerRecord(options.owner);
    this.root = workflowRunStoreRoot(options.rootDir, options.owner);
  }

  public async getLeaseEpoch(): Promise<number> {
    return (await this.assertNamespaceLease()).leaseEpoch;
  }

  /**
   * Permanently prevent this store instance from using namespace authority.
   *
   * Revocation is intentionally separate from lease release so lifecycle
   * shutdown can drain all users before relinquishing the filesystem lease.
   */
  public async revoke(): Promise<void> {
    this.revoked = true;
    await this.withLock(async () => undefined);
  }
  public async release(): Promise<void> {
    const lease = WorkflowRunStore.leases.get(this.root);
    if (
      !lease ||
      !lease.belongsTo(
        this.options.owner.ownerId,
        this.options.owner.leaseToken,
      )
    ) {
      return;
    }
    await lease.release();
    if (WorkflowRunStore.leases.get(this.root) === lease) {
      WorkflowRunStore.leases.delete(this.root);
    }
  }

  /** Atomically publish launch.json and a synced run_created journal prefix. */
  public async createRunWithInitialEvent<P>(
    input: Omit<WorkflowRunLaunch, "schemaVersion" | "createdAt">,
    initialEvent: WorkflowRunCreationEvent<P>,
  ): Promise<WorkflowRunCreationReceipt> {
    const normalized = normalizeLaunchInput(input);
    validateWorkflowRunId(normalized.runId);
    assertSameLiveOwner(normalized.owner, this.options.owner);
    const creation = normalizeCreationEvent(initialEvent);
    if (normalized.planRevision !== creation.plan.schemaVersion) {
      throw new Error("Workflow launch revision does not match persisted plan");
    }
    const planDigest = createHash("sha256")
      .update(encodeDurableValue(creation.plan), "utf8")
      .digest("hex");
    if (normalized.planDigest && normalized.planDigest !== planDigest) {
      throw new Error(
        "Workflow launch plan digest does not match persisted plan",
      );
    }
    return this.withLock(async () => {
      this.assertNotRevoked();
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        const runEpoch = creation.runEpoch ?? lease.leaseEpoch;
        if (runEpoch !== lease.leaseEpoch) {
          throw new WorkflowRunAuthorityError(
            `Workflow creation epoch ${runEpoch} does not match lease epoch ${lease.leaseEpoch}`,
          );
        }
        const launch: WorkflowRunLaunch = {
          schemaVersion: 1,
          runId: normalized.runId,
          planRevision: normalized.planRevision,
          resumePolicy: "manual",
          owner: normalized.owner,
          createdAt: Date.now(),
          planDigest,
        };
        validateLaunchRecord(launch, launch.runId);
        const firstEvent: WorkflowEventEnvelope<
          "run_created",
          { plan: WorkflowPlan }
        > = {
          schemaVersion: 1,
          eventId: randomUUID(),
          eventOrdinal: 0,
          runId: launch.runId,
          runEpoch,
          type: "run_created",
          payload: { plan: creation.plan },
        };
        const launchBytes = Buffer.from(`${JSON.stringify(launch)}\n`, "utf8");
        const eventBytes = serializeEvent(firstEvent);
        if (launchBytes.length > MAX_LAUNCH_BYTES) {
          throw new Error("Workflow launch exceeds its storage bound");
        }

        await this.ensureStorageDirectories();
        const runsPath = this.runsDir();
        const runsDirectory = await openVerifiedDirectory(runsPath);
        const finalDir = this.runDir(launch.runId);
        const stagingDir = join(
          runsPath,
          `${CREATION_PREFIX}${launch.runId}-${randomUUID()}`,
        );
        let staging: OpenDirectory | undefined;
        try {
          await assertDirectoryDescriptorAndTarget(
            runsDirectory.file,
            runsPath,
            runsDirectory.identity,
          );
          if (await pathExists(finalDir)) {
            throw new Error(`Workflow run already exists: ${launch.runId}`);
          }
          await mkdir(stagingDir, { mode: 0o700 });
          await assertDirectoryDescriptorAndTarget(
            runsDirectory.file,
            runsPath,
            runsDirectory.identity,
          );
          staging = await openVerifiedDirectory(stagingDir);
          const outputsDirectory = await openOrCreateDirectory(
            staging,
            stagingDir,
            join(stagingDir, "outputs"),
          );
          await outputsDirectory.file.close();
          await writeSyncedFile(join(stagingDir, "launch.json"), launchBytes);
          await assertDirectoryDescriptorAndTarget(
            staging.file,
            stagingDir,
            staging.identity,
          );
          await writeSyncedFile(join(stagingDir, "events.ndjson"), eventBytes);
          await staging.file.sync();
          await assertDirectoryDescriptorAndTarget(
            staging.file,
            stagingDir,
            staging.identity,
          );
          await lease.assertHeld();
          await assertDirectoryDescriptorAndTarget(
            runsDirectory.file,
            runsPath,
            runsDirectory.identity,
          );
          if (await pathExists(finalDir)) {
            throw new Error(`Workflow run already exists: ${launch.runId}`);
          }
          await rename(stagingDir, finalDir);
          await assertDirectoryDescriptorAndTarget(
            staging.file,
            finalDir,
            staging.identity,
          );
          await runsDirectory.file.sync();
          await assertDirectoryDescriptorAndTarget(
            runsDirectory.file,
            runsPath,
            runsDirectory.identity,
          );
          await assertRegularFile(join(finalDir, "launch.json"));
          await assertRegularFile(join(finalDir, "events.ndjson"));
          await assertRegularDirectory(join(finalDir, "outputs"));
          await assertDirectoryDescriptorAndTarget(
            staging.file,
            finalDir,
            staging.identity,
          );
          await lease.assertHeld();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
            throw new WorkflowRunStorageError(launch.runId, error);
          }
          // Unpublished .creating-* directories remain quarantined. They are
          // never enumerated or treated as authoritative runs.
          throw error;
        } finally {
          await staging?.file.close();
          await runsDirectory.file.close();
        }
        return { launch, initialEvent: firstEvent };
      });
    });
  }

  public async append<T extends string, P>(
    runId: string,
    type: T,
    payload: P,
    runEpoch?: number,
    expectedLastEventOrdinal?: number,
  ): Promise<WorkflowAppendReceipt> {
    validateWorkflowRunId(runId);
    if (!RUN_EVENT_TYPE.test(type) || type === "run_created") {
      throw new Error("Invalid workflow event type");
    }
    try {
      return await this.withLock(async () => {
        const lease = await this.assertNamespaceLease();
        return lease.withAuthority(async () => {
          const authority = await this.openRunAuthority(runId);
          const { runPath, runDirectory: directory } = authority;
          try {
            const launch = await this.readLaunchFromDirectory(runId, authority);
            assertSameDurableOwner(launch.owner, this.options.owner);
            const eventPath = join(runPath, "events.ndjson");
            await assertDirectoryDescriptorAndTarget(
              directory.file,
              runPath,
              directory.identity,
            );
            const file = await openVerifiedFile(
              eventPath,
              fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
            );
            await assertDirectoryDescriptorAndTarget(
              directory.file,
              runPath,
              directory.identity,
            );
            try {
              const bytes = await readBoundedFile(
                file,
                eventPath,
                MAX_JOURNAL_BYTES,
              );
              const parsed = parseJournal(runId, bytes);
              assertCreationMatchesLaunch(launch, parsed.events[0]!);
              assertJournalEpochOwned(runId, parsed.events, lease.leaseEpoch);
              const actualOrdinal = parsed.events.length - 1;
              const currentEpoch = lastRunEpoch(parsed.events);
              if (
                expectedLastEventOrdinal !== undefined &&
                expectedLastEventOrdinal !== actualOrdinal
              ) {
                throw new WorkflowConditionalAppendConflict(
                  actualOrdinal,
                  currentEpoch,
                );
              }
              const nextEpoch = runEpoch ?? lease.leaseEpoch;
              if (
                !Number.isSafeInteger(nextEpoch) ||
                nextEpoch < lease.leaseEpoch
              ) {
                throw new WorkflowRunAuthorityError(
                  `Cannot append stale run epoch ${nextEpoch}; held lease epoch is ${lease.leaseEpoch}`,
                );
              }
              if (nextEpoch !== lease.leaseEpoch) {
                throw new WorkflowRunAuthorityError(
                  `Workflow run epoch ${nextEpoch} is not owned by lease epoch ${lease.leaseEpoch}`,
                );
              }
              const envelope: WorkflowEventEnvelope<T, DurableValue> = {
                schemaVersion: 1,
                eventId: randomUUID(),
                eventOrdinal: parsed.events.length,
                runId,
                runEpoch: nextEpoch,
                type,
                payload: toDurableValue(payload),
              };
              const line = serializeEvent(envelope);
              if (parsed.completeBytes + line.length > MAX_JOURNAL_BYTES) {
                throw new Error("Workflow journal exceeds its storage bound");
              }

              await this.revalidateRunAuthority(
                lease,
                authority,
                runId,
                launch,
                file,
                eventPath,
              );
              if (parsed.tornTailBytes > 0) {
                await file.truncate(parsed.completeBytes);
                await file.sync();
                await this.revalidateRunAuthority(
                  lease,
                  authority,
                  runId,
                  launch,
                  file,
                  eventPath,
                );
              }
              try {
                await writeFully(file, line, parsed.completeBytes);
                await file.sync();
              } catch (error) {
                try {
                  await assertDescriptorAndTarget(file, eventPath);
                  await file.truncate(parsed.completeBytes);
                  await file.sync();
                } catch (rollbackError) {
                  throw new Error(
                    "Failed to roll back workflow journal suffix",
                    {
                      cause: new AggregateError([error, rollbackError]),
                    },
                  );
                }
                throw error;
              }
              await this.revalidateRunAuthority(
                lease,
                authority,
                runId,
                launch,
                file,
                eventPath,
              );
              return {
                eventId: envelope.eventId,
                runId,
                startByte: parsed.completeBytes,
                endByte: parsed.completeBytes + line.length,
                eventOrdinal: envelope.eventOrdinal,
                runEpoch: envelope.runEpoch,
              };
            } finally {
              await file.close();
            }
          } finally {
            await this.closeRunAuthority(authority);
          }
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
        throw new WorkflowRunStorageError(runId, error);
      }
      throw error;
    }
  }

  public async appendIfCurrent<T extends string, P>(
    runId: string,
    expectedLastEventOrdinal: number,
    type: T,
    payload: P,
    runEpoch?: number,
  ): Promise<WorkflowConditionalAppendResult> {
    if (
      !Number.isSafeInteger(expectedLastEventOrdinal) ||
      expectedLastEventOrdinal < 0
    ) {
      throw new Error("Invalid expected workflow event ordinal");
    }
    try {
      return {
        status: "appended",
        receipt: await this.append(
          runId,
          type,
          payload,
          runEpoch,
          expectedLastEventOrdinal,
        ),
      };
    } catch (error) {
      if (error instanceof WorkflowConditionalAppendConflict) {
        return {
          status: "conflict",
          actualLastEventOrdinal: error.actualLastEventOrdinal,
          actualRunEpoch: error.actualRunEpoch,
        };
      }
      throw error;
    }
  }

  /** Persist a canonical, content-addressed outcome before its settlement event. */
  public async writeOutcomeBlob(
    runId: string,
    value: unknown,
  ): Promise<WorkflowOutcomeBlobRef> {
    validateWorkflowRunId(runId);
    const canonical = toDurableValue(value);
    const bytes = Buffer.from(encodeDurableValue(canonical), "utf8");
    if (bytes.length > MAX_OUTCOME_BYTES) {
      throw new Error("Workflow outcome exceeds its storage bound");
    }
    const ref: WorkflowOutcomeBlobRef = {
      schemaVersion: 1,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    this.assertNotRevoked();
    return this.withLock(async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        const authority = await this.openRunAuthority(runId);
        const { runPath, runDirectory } = authority;
        try {
          const launch = await this.readLaunchFromDirectory(runId, authority);
          assertSameDurableOwner(launch.owner, this.options.owner);
          const outputsPath = join(runPath, "outputs");
          await this.assertOpenRunAuthority(authority);
          const outputsDirectory = await openVerifiedDirectory(outputsPath);
          try {
            await this.assertOpenRunAuthority(authority);
            const finalPath = join(outputsPath, `${ref.digest}.json`);
            await assertDirectoryDescriptorAndTarget(
              outputsDirectory.file,
              outputsPath,
              outputsDirectory.identity,
            );
            if (await pathExists(finalPath)) {
              await readOutcomeAtPath(runId, finalPath, ref);
              await assertDirectoryDescriptorAndTarget(
                outputsDirectory.file,
                outputsPath,
                outputsDirectory.identity,
              );
              await this.assertOpenRunAuthority(authority);
              await lease.assertHeld();
              return ref;
            }
            const stagingPath = join(
              outputsPath,
              `${WRITING_PREFIX}${randomUUID()}`,
            );
            await writeSyncedFile(stagingPath, bytes);
            await assertDirectoryDescriptorAndTarget(
              outputsDirectory.file,
              outputsPath,
              outputsDirectory.identity,
            );
            const staging = await openVerifiedFile(
              stagingPath,
              fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
            );
            try {
              await lease.assertHeld();
              await assertDirectoryDescriptorAndTarget(
                outputsDirectory.file,
                outputsPath,
                outputsDirectory.identity,
              );
              if (await pathExists(finalPath)) {
                await readOutcomeAtPath(runId, finalPath, ref);
                await assertDescriptorAndTarget(staging, stagingPath);
                await rm(stagingPath, { force: false });
                await outputsDirectory.file.sync();
              } else {
                await rename(stagingPath, finalPath);
                await assertDescriptorAndTarget(staging, finalPath);
                await outputsDirectory.file.sync();
              }
              await assertDirectoryDescriptorAndTarget(
                outputsDirectory.file,
                outputsPath,
                outputsDirectory.identity,
              );
              await this.assertOpenRunAuthority(authority);
              await lease.assertHeld();
              return ref;
            } finally {
              await staging.close();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
              throw new WorkflowRunStorageError(runId, error);
            }
            throw error;
          } finally {
            await outputsDirectory.file.close();
          }
        } finally {
          await this.closeRunAuthority(authority);
        }
      });
    });
  }

  public async readOutcomeBlob(
    runId: string,
    ref: WorkflowOutcomeBlobRef,
  ): Promise<DurableValue> {
    validateWorkflowRunId(runId);
    const normalized = normalizeOutcomeRef(ref);
    this.assertNotRevoked();
    return this.withLock(async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        let authority: OpenRunAuthority | undefined;
        let outputsDirectory: OpenDirectory | undefined;
        try {
          authority = await this.openRunAuthority(runId);
          const { runPath } = authority;
          const launch = await this.readLaunchFromDirectory(runId, authority);
          assertSameDurableOwner(launch.owner, this.options.owner);
          const outputsPath = join(runPath, "outputs");
          outputsDirectory = await openVerifiedDirectory(outputsPath);
          await this.assertOpenRunAuthority(authority);
          await assertDirectoryDescriptorAndTarget(
            outputsDirectory.file,
            outputsPath,
            outputsDirectory.identity,
          );
          const value = await readOutcomeAtPath(
            runId,
            join(outputsPath, `${normalized.digest}.json`),
            normalized,
          );
          await assertDirectoryDescriptorAndTarget(
            outputsDirectory.file,
            outputsPath,
            outputsDirectory.identity,
          );
          await this.assertOpenRunAuthority(authority);
          await lease.assertHeld();
          return value;
        } catch (error) {
          if (error instanceof WorkflowRunAuthorityError) throw error;
          if (error instanceof WorkflowRunCorruptionError) throw error;
          throw new WorkflowRunCorruptionError(runId, error);
        } finally {
          try {
            await outputsDirectory?.file.close();
          } finally {
            if (authority) await this.closeRunAuthority(authority);
          }
        }
      });
    });
  }

  public async readRun(runId: string): Promise<WorkflowRunRecord> {
    validateWorkflowRunId(runId);
    this.assertNotRevoked();
    return this.withLock(async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        try {
          return (await this.readRunUnderAuthority(runId, lease)).record;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
          if (
            error instanceof WorkflowRunCorruptionError ||
            error instanceof WorkflowRunAuthorityError
          ) {
            throw error;
          }
          throw new WorkflowRunCorruptionError(runId, error);
        }
      });
    });
  }

  public async readEventLog(runId: string): Promise<WorkflowRunEventLog> {
    validateWorkflowRunId(runId);
    this.assertNotRevoked();
    return this.withLock(async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        try {
          const result = await this.readRunUnderAuthority(runId, lease);
          return {
            events: result.record.events,
            completeBytes: result.completeBytes,
            tornTailBytes: result.tornTailBytes,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
          if (
            error instanceof WorkflowRunCorruptionError ||
            error instanceof WorkflowRunAuthorityError
          ) {
            throw error;
          }
          throw new WorkflowRunCorruptionError(runId, error);
        }
      });
    });
  }

  public async listRunIds(): Promise<readonly string[]> {
    this.assertNotRevoked();
    return this.withLock(async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        const runsPath = this.runsDir();
        let runsDirectory: OpenDirectory;
        try {
          runsDirectory = await openVerifiedDirectory(runsPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
        try {
          await assertDirectoryDescriptorAndTarget(
            runsDirectory.file,
            runsPath,
            runsDirectory.identity,
          );
          const entries = await readdir(runsPath, { withFileTypes: true });
          await assertDirectoryDescriptorAndTarget(
            runsDirectory.file,
            runsPath,
            runsDirectory.identity,
          );
          const runIds: string[] = [];
          for (const entry of entries) {
            try {
              validateWorkflowRunId(entry.name);
            } catch {
              continue;
            }
            if (!entry.isDirectory()) {
              throw new WorkflowRunCorruptionError(
                entry.name,
                new Error(
                  `Workflow run path is not a directory: ${join(runsPath, entry.name)}`,
                ),
              );
            }
            const runPath = join(runsPath, entry.name);
            const runDirectory = await openVerifiedDirectory(runPath);
            await runDirectory.file.close();
            runIds.push(entry.name);
          }
          await assertDirectoryDescriptorAndTarget(
            runsDirectory.file,
            runsPath,
            runsDirectory.identity,
          );
          await lease.assertHeld();
          return runIds.sort();
        } finally {
          await runsDirectory.file.close();
        }
      });
    });
  }

  private async assertNamespaceLease(): Promise<WorkflowNamespaceLease> {
    this.assertNotRevoked();
    await this.ensureOwnerDirectories();
    let lease = WorkflowRunStore.leases.get(this.root);
    if (lease && !lease.isHeld) {
      WorkflowRunStore.leases.delete(this.root);
      lease = undefined;
    }
    if (
      lease &&
      !lease.belongsTo(
        this.options.owner.ownerId,
        this.options.owner.leaseToken,
      )
    ) {
      throw new WorkflowRunAuthorityError(
        "Workflow namespace lease is held by a different owner",
      );
    }
    if (!lease) {
      lease = new WorkflowNamespaceLease({
        rootDir: this.root,
        namespace: "namespace",
        ownerId: this.options.owner.ownerId,
        leaseToken: this.options.owner.leaseToken,
        processId: process.pid,
      });
      WorkflowRunStore.leases.set(this.root, lease);
    }
    if (!lease.isHeld) await lease.acquire();
    await lease.assertHeld();
    return lease;
  }

  private async openRunAuthority(runId: string): Promise<OpenRunAuthority> {
    const runsPath = this.runsDir();
    const runPath = this.runDir(runId);
    const runsDirectory = await openVerifiedDirectory(runsPath);
    let runDirectory: OpenDirectory | undefined;
    try {
      await assertDirectoryDescriptorAndTarget(
        runsDirectory.file,
        runsPath,
        runsDirectory.identity,
      );
      runDirectory = await openVerifiedDirectory(runPath);
      await assertDirectoryDescriptorAndTarget(
        runsDirectory.file,
        runsPath,
        runsDirectory.identity,
      );
      return { runsDirectory, runDirectory, runsPath, runPath };
    } catch (error) {
      await runDirectory?.file.close();
      await runsDirectory.file.close();
      throw error;
    }
  }

  private async assertOpenRunAuthority(
    authority: OpenRunAuthority,
  ): Promise<void> {
    await assertDirectoryDescriptorAndTarget(
      authority.runsDirectory.file,
      authority.runsPath,
      authority.runsDirectory.identity,
    );
    await assertDirectoryDescriptorAndTarget(
      authority.runDirectory.file,
      authority.runPath,
      authority.runDirectory.identity,
    );
    await assertDirectoryDescriptorAndTarget(
      authority.runsDirectory.file,
      authority.runsPath,
      authority.runsDirectory.identity,
    );
  }

  private async closeRunAuthority(authority: OpenRunAuthority): Promise<void> {
    try {
      await authority.runDirectory.file.close();
    } finally {
      await authority.runsDirectory.file.close();
    }
  }

  private async readRunUnderAuthority(
    runId: string,
    lease: WorkflowNamespaceLease,
  ): Promise<ReadRunResult> {
    const authority = await this.openRunAuthority(runId);
    try {
      const launch = await this.readLaunchFromDirectory(runId, authority);
      assertSameDurableOwner(launch.owner, this.options.owner);
      const eventPath = join(authority.runPath, "events.ndjson");
      await this.assertOpenRunAuthority(authority);
      const file = await openVerifiedFile(
        eventPath,
        fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      );
      try {
        await this.assertOpenRunAuthority(authority);
        const parsed = parseJournal(
          runId,
          await readBoundedFile(file, eventPath, MAX_JOURNAL_BYTES),
        );
        assertCreationMatchesLaunch(launch, parsed.events[0]!);
        assertJournalEpochOwned(runId, parsed.events, lease.leaseEpoch);
        const result: ReadRunResult = {
          record: { launch, events: parsed.events },
          completeBytes: parsed.completeBytes,
          tornTailBytes: parsed.tornTailBytes,
        };
        if (parsed.tornTailBytes > 0) {
          await this.revalidateRunAuthority(
            lease,
            authority,
            runId,
            launch,
            file,
            eventPath,
          );
          await file.truncate(parsed.completeBytes);
          await file.sync();
        }
        await this.revalidateRunAuthority(
          lease,
          authority,
          runId,
          launch,
          file,
          eventPath,
        );
        return result;
      } finally {
        await file.close();
      }
    } finally {
      await this.closeRunAuthority(authority);
    }
  }

  private async revalidateRunAuthority(
    lease: WorkflowNamespaceLease,
    authority: OpenRunAuthority,
    runId: string,
    launch: WorkflowRunLaunch,
    eventFile: FileHandle,
    eventPath: string,
  ): Promise<void> {
    await lease.assertHeld();
    await this.assertOpenRunAuthority(authority);
    const current = await this.readLaunchFromDirectory(runId, authority);
    if (JSON.stringify(current) !== JSON.stringify(launch)) {
      throw new WorkflowRunAuthorityError(
        "Workflow run launch authority changed",
      );
    }
    await assertDescriptorAndTarget(eventFile, eventPath);
    await this.assertOpenRunAuthority(authority);
    await lease.assertHeld();
  }

  private async readLaunchFromDirectory(
    runId: string,
    authority: OpenRunAuthority,
  ): Promise<WorkflowRunLaunch> {
    await this.assertOpenRunAuthority(authority);
    const path = join(authority.runPath, "launch.json");
    const file = await openVerifiedFile(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const bytes = await readBoundedFile(file, path, MAX_LAUNCH_BYTES);
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
      validateLaunchRecord(parsed, runId);
      await this.assertOpenRunAuthority(authority);
      return parsed;
    } finally {
      await file.close();
    }
  }

  private async ensureOwnerDirectories(): Promise<void> {
    await mkdir(this.options.rootDir, { recursive: true, mode: 0o700 });
    const configuredRoot = await openVerifiedDirectory(this.options.rootDir);
    try {
      const projectDir = join(
        this.options.rootDir,
        this.options.owner.projectKey,
      );
      const project = await openOrCreateDirectory(
        configuredRoot,
        this.options.rootDir,
        projectDir,
      );
      try {
        const ownerDirectory = await openOrCreateDirectory(
          project,
          projectDir,
          this.root,
        );
        await ownerDirectory.file.close();
      } finally {
        await project.file.close();
      }
    } finally {
      await configuredRoot.file.close();
    }
  }

  private async ensureStorageDirectories(): Promise<void> {
    await this.ensureOwnerDirectories();
    const ownerDirectory = await openVerifiedDirectory(this.root);
    try {
      const runsDirectory = await openOrCreateDirectory(
        ownerDirectory,
        this.root,
        this.runsDir(),
      );
      await runsDirectory.file.close();
    } finally {
      await ownerDirectory.file.close();
    }
  }

  private runsDir(): string {
    return join(this.root, "runs");
  }

  private runDir(runId: string): string {
    validateWorkflowRunId(runId);
    return join(this.runsDir(), runId);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = WorkflowRunStore.locks.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    WorkflowRunStore.locks.set(this.root, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (WorkflowRunStore.locks.get(this.root) === current) {
        WorkflowRunStore.locks.delete(this.root);
      }
    }
  }
  private assertNotRevoked(): void {
    if (this.revoked) {
      throw new WorkflowRunAuthorityError(
        "Workflow run store authority has been revoked",
      );
    }
  }
}

class WorkflowConditionalAppendConflict extends Error {
  public constructor(
    public readonly actualLastEventOrdinal: number,
    public readonly actualRunEpoch: number,
  ) {
    super("Workflow journal revision conflict");
  }
}

function normalizeLaunchInput(
  input: Omit<WorkflowRunLaunch, "schemaVersion" | "createdAt">,
): Omit<WorkflowRunLaunch, "schemaVersion" | "createdAt"> {
  const record = requireRecord(toDurableValue(input), "workflow launch");
  assertExactKeys(
    record,
    ["runId", "planRevision", "resumePolicy", "owner"],
    ["planDigest"],
    "workflow launch",
  );
  if (typeof record.runId !== "string")
    throw new Error("Invalid workflow run ID");
  validateWorkflowRunId(record.runId);
  if (
    !Number.isSafeInteger(record.planRevision) ||
    (record.planRevision as number) < 0
  ) {
    throw new Error("Invalid workflow plan revision");
  }
  if (record.resumePolicy !== "manual") {
    throw new Error("Durable workflow preview requires manual resume policy");
  }
  validateOwnerRecord(record.owner);
  if (
    record.planDigest !== undefined &&
    (typeof record.planDigest !== "string" ||
      !SHA256_PATTERN.test(record.planDigest))
  ) {
    throw new Error("Invalid workflow plan digest");
  }
  return record as unknown as Omit<
    WorkflowRunLaunch,
    "schemaVersion" | "createdAt"
  >;
}

function normalizeCreationEvent(input: WorkflowRunCreationEvent<unknown>): {
  plan: WorkflowPlan;
  runEpoch?: number;
} {
  const record = requireRecord(
    toDurableValue(input),
    "workflow creation event",
  );
  assertExactKeys(
    record,
    ["type", "payload"],
    ["runEpoch"],
    "workflow creation event",
  );
  if (record.type !== "run_created") {
    throw new Error("The initial workflow event must be run_created");
  }
  if (
    record.runEpoch !== undefined &&
    (!Number.isSafeInteger(record.runEpoch) || (record.runEpoch as number) < 1)
  ) {
    throw new Error("Invalid initial workflow run epoch");
  }
  const payload = requireRecord(record.payload, "run_created payload");
  assertExactKeys(payload, ["plan"], [], "run_created payload");
  validateWorkflowPlan(payload.plan);
  return {
    plan: payload.plan,
    ...(record.runEpoch === undefined
      ? {}
      : { runEpoch: record.runEpoch as number }),
  };
}

function normalizeOutcomeRef(
  ref: WorkflowOutcomeBlobRef,
): WorkflowOutcomeBlobRef {
  const record = requireRecord(
    toDurableValue(ref),
    "workflow outcome reference",
  );
  assertExactKeys(
    record,
    ["schemaVersion", "digest", "bytes"],
    [],
    "workflow outcome reference",
  );
  if (
    record.schemaVersion !== 1 ||
    typeof record.digest !== "string" ||
    !SHA256_PATTERN.test(record.digest) ||
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) <= 0 ||
    (record.bytes as number) > MAX_OUTCOME_BYTES
  ) {
    throw new Error("Invalid workflow outcome reference");
  }
  return record as unknown as WorkflowOutcomeBlobRef;
}

function validateLaunchRecord(
  value: unknown,
  runId: string,
): asserts value is WorkflowRunLaunch {
  const record = requireRecord(value, "workflow launch record");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "runId",
      "planRevision",
      "resumePolicy",
      "owner",
      "createdAt",
      "planDigest",
    ],
    [],
    "workflow launch record",
  );
  if (
    record.schemaVersion !== 1 ||
    record.runId !== runId ||
    !Number.isSafeInteger(record.planRevision) ||
    (record.planRevision as number) < 0 ||
    record.resumePolicy !== "manual" ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) < 0 ||
    typeof record.planDigest !== "string" ||
    !SHA256_PATTERN.test(record.planDigest)
  ) {
    throw new Error("Invalid workflow launch record");
  }
  validateWorkflowRunId(runId);
  validateOwnerRecord(record.owner);
}

function validateOwnerRecord(
  value: unknown,
): asserts value is WorkflowOwnerIdentity {
  const owner = requireRecord(value, "workflow owner");
  assertExactKeys(
    owner,
    [
      "projectKey",
      "cwd",
      "piSessionId",
      "ownerId",
      "ownerGeneration",
      "leaseToken",
    ],
    [],
    "workflow owner",
  );
  if (
    typeof owner.projectKey !== "string" ||
    !SAFE_OWNER_PATH_KEY.test(owner.projectKey) ||
    typeof owner.piSessionId !== "string" ||
    !SAFE_OWNER_PATH_KEY.test(owner.piSessionId) ||
    typeof owner.cwd !== "string" ||
    !isAbsolute(owner.cwd) ||
    Buffer.byteLength(owner.cwd, "utf8") > 4096
  ) {
    throw new Error("Invalid workflow owner durable identity");
  }
  for (const key of ["ownerId", "leaseToken"] as const) {
    const field = owner[key];
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      Buffer.byteLength(field, "utf8") > 256
    ) {
      throw new Error(`Invalid workflow owner ${key}`);
    }
  }
  if (
    !Number.isSafeInteger(owner.ownerGeneration) ||
    (owner.ownerGeneration as number) < 0
  ) {
    throw new Error("Invalid workflow owner generation");
  }
}

function assertSameLiveOwner(
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
    throw new WorkflowRunAuthorityError(
      "Workflow run belongs to a different owner or session.",
    );
  }
}

function assertSameDurableOwner(
  left: WorkflowOwnerIdentity,
  right: WorkflowOwnerIdentity,
): void {
  if (
    left.projectKey !== right.projectKey ||
    left.cwd !== right.cwd ||
    left.piSessionId !== right.piSessionId
  ) {
    throw new WorkflowRunAuthorityError(
      "Workflow run belongs to a different durable namespace.",
    );
  }
}

function assertCreationMatchesLaunch(
  launch: WorkflowRunLaunch,
  event: WorkflowEventEnvelope,
): void {
  const payload = requireRecord(event.payload, "run_created payload");
  const plan = payload.plan;
  validateWorkflowPlan(plan);
  const digest = createHash("sha256")
    .update(encodeDurableValue(plan), "utf8")
    .digest("hex");
  if (
    plan.schemaVersion !== launch.planRevision ||
    digest !== launch.planDigest
  ) {
    throw new Error("Workflow launch does not match its run_created plan");
  }
}

function parseJournal(runId: string, bytes: Buffer): ParsedJournal {
  assertPhysicalEventLineBounds(bytes);
  const lastNewline = bytes.lastIndexOf(0x0a);
  const completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  const tornTailBytes = bytes.length - completeBytes;
  const events: WorkflowEventEnvelope[] = [];
  let priorEpoch = 0;
  if (completeBytes > 0) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, completeBytes),
    );
    const lines = text.split("\n");
    lines.pop();
    for (let ordinal = 0; ordinal < lines.length; ordinal++) {
      if (!lines[ordinal]) {
        throw new Error("Workflow journal contains an empty complete line");
      }
      const event = JSON.parse(lines[ordinal]) as unknown;
      validateEventRecord(event, runId, ordinal);
      if (event.runEpoch < priorEpoch) {
        throw new Error("Workflow journal run epoch regressed");
      }
      priorEpoch = event.runEpoch;
      events.push(event);
    }
  }
  if (events.length === 0 || events[0].type !== "run_created") {
    throw new Error("Workflow journal has no committed run_created event");
  }
  return { events, completeBytes, tornTailBytes };
}

function validateEventRecord(
  value: unknown,
  runId: string,
  ordinal: number,
): asserts value is WorkflowEventEnvelope {
  const event = requireRecord(value, "workflow event");
  assertExactKeys(
    event,
    [
      "schemaVersion",
      "eventId",
      "eventOrdinal",
      "runId",
      "runEpoch",
      "type",
      "payload",
    ],
    [],
    "workflow event",
  );
  if (
    event.schemaVersion !== 1 ||
    typeof event.eventId !== "string" ||
    !UUID_PATTERN.test(event.eventId) ||
    event.eventOrdinal !== ordinal ||
    event.runId !== runId ||
    !Number.isSafeInteger(event.runEpoch) ||
    (event.runEpoch as number) < 1 ||
    typeof event.type !== "string" ||
    !RUN_EVENT_TYPE.test(event.type) ||
    (ordinal === 0) !== (event.type === "run_created")
  ) {
    throw new Error(`Invalid workflow event at ordinal ${ordinal}`);
  }
  const canonicalPayload = toDurableValue(event.payload);
  if (JSON.stringify(canonicalPayload) !== JSON.stringify(event.payload)) {
    throw new Error("Workflow event payload is not canonical");
  }
  if (event.type === "run_created") {
    const payload = requireRecord(event.payload, "run_created payload");
    assertExactKeys(payload, ["plan"], [], "run_created payload");
    validateWorkflowPlan(payload.plan);
  }
}

function serializeEvent(event: WorkflowEventEnvelope): Buffer {
  const bytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      eventId: event.eventId,
      eventOrdinal: event.eventOrdinal,
      runId: event.runId,
      runEpoch: event.runEpoch,
      type: event.type,
      payload: toDurableValue(event.payload),
    })}\n`,
    "utf8",
  );
  if (bytes.length > MAX_EVENT_BYTES) {
    throw new Error("Workflow event exceeds its storage bound");
  }
  return bytes;
}

function lastRunEpoch(events: readonly WorkflowEventEnvelope[]): number {
  return events.at(-1)?.runEpoch ?? 0;
}

function assertJournalEpochOwned(
  runId: string,
  events: readonly WorkflowEventEnvelope[],
  leaseEpoch: number,
): void {
  const journalEpoch = lastRunEpoch(events);
  if (journalEpoch > leaseEpoch) {
    throw new WorkflowRunCorruptionError(
      runId,
      new WorkflowRunAuthorityError(
        `Workflow journal epoch ${journalEpoch} exceeds held lease epoch ${leaseEpoch}`,
      ),
    );
  }
}

function assertPhysicalEventLineBounds(bytes: Buffer): void {
  let lineBytes = 0;
  for (const byte of bytes) {
    lineBytes++;
    if (lineBytes > MAX_EVENT_BYTES) {
      throw new Error(
        "Workflow journal contains an oversized physical event line",
      );
    }
    if (byte === 0x0a) lineBytes = 0;
  }
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, DurableValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, DurableValue>;
}

function assertExactKeys(
  value: Record<string, DurableValue>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed: Record<string, true> = {};
  for (const key of required) {
    allowed[key] = true;
    if (!Object.hasOwn(value, key))
      throw new Error(`${label} is missing ${key}`);
  }
  for (const key of optional) allowed[key] = true;
  for (const key of Object.keys(value)) {
    if (!allowed[key]) throw new Error(`${label} has unknown field ${key}`);
  }
}

async function readOutcomeAtPath(
  runId: string,
  path: string,
  ref: WorkflowOutcomeBlobRef,
): Promise<DurableValue> {
  const file = await openVerifiedFile(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const bytes = await readBoundedFile(file, path, MAX_OUTCOME_BYTES);
    if (bytes.length !== ref.bytes) {
      throw new WorkflowRunCorruptionError(
        runId,
        new Error("Workflow outcome size does not match its reference"),
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== ref.digest) {
      throw new WorkflowRunCorruptionError(
        runId,
        new Error("Workflow outcome digest does not match its reference"),
      );
    }
    try {
      const encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = decodeDurableValue(encoded);
      if (encodeDurableValue(value) !== encoded) {
        throw new Error("Workflow outcome blob is not canonically encoded");
      }
      return value;
    } catch (error) {
      throw new WorkflowRunCorruptionError(runId, error);
    }
  } finally {
    await file.close();
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
    throw new Error("Workflow storage file exceeds its bounded size");
  }
  const identity = fileIdentity(before);
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maxBytes) {
    const requested = Math.min(64 * 1024, maxBytes + 1 - position);
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await file.read(chunk, 0, requested, position);
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead < 0 ||
      bytesRead > requested
    ) {
      throw new Error("Workflow storage returned an invalid read length");
    }
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
    if (position > maxBytes) {
      throw new Error("Workflow storage file exceeds its bounded size");
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
    throw new WorkflowRunAuthorityError(
      `Workflow storage file changed while being read: ${path}`,
    );
  }
  await assertDescriptorAndTarget(file, path, identity);
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0]!;
  return Buffer.concat(chunks, position);
}

async function writeSyncedFile(path: string, bytes: Buffer): Promise<void> {
  const file = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stats = await file.stat();
    assertRegularFileStats(path, stats);
    const identity = fileIdentity(stats);
    await writeFully(file, bytes, 0);
    await file.sync();
    await assertDescriptorAndTarget(file, path, identity);
  } finally {
    await file.close();
  }
}

async function writeFully(
  file: FileHandle,
  bytes: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error("Workflow storage short write");
    }
    offset += bytesWritten;
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

async function assertRegularFile(path: string): Promise<void> {
  assertRegularFileStats(path, await lstat(path));
}

function assertRegularFileStats(path: string, stats: Stats): void {
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new WorkflowRunAuthorityError(
      `Workflow storage authority is not a regular single-link file: ${path}`,
    );
  }
  assertEffectiveOwner(path, stats);
  if ((stats.mode & 0o077) !== 0) {
    throw new WorkflowRunAuthorityError(
      `Workflow storage file grants group or other access: ${path}`,
    );
  }
}

async function assertRegularDirectory(path: string): Promise<void> {
  assertRegularDirectoryStats(path, await lstat(path));
}

function assertRegularDirectoryStats(path: string, stats: Stats): void {
  if (!stats.isDirectory()) {
    throw new WorkflowRunAuthorityError(
      `Workflow storage authority is not a directory: ${path}`,
    );
  }
  assertEffectiveOwner(path, stats);
  if ((stats.mode & 0o077) !== 0) {
    throw new WorkflowRunAuthorityError(
      `Workflow storage directory grants group or other access: ${path}`,
    );
  }
}

function assertEffectiveOwner(path: string, stats: Stats): void {
  if (
    typeof process.geteuid === "function" &&
    stats.uid !== process.geteuid()
  ) {
    throw new WorkflowRunAuthorityError(
      `Workflow storage authority has an unexpected owner: ${path}`,
    );
  }
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
  const opened = fileIdentity(descriptor);
  const actual = fileIdentity(target);
  if (
    (expected && !sameFileIdentity(expected, actual)) ||
    !sameFileIdentity(opened, actual)
  ) {
    throw new WorkflowRunAuthorityError(
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
  const opened = fileIdentity(descriptor);
  const actual = fileIdentity(target);
  if (
    !sameFileIdentity(expected, actual) ||
    !sameFileIdentity(opened, actual)
  ) {
    throw new WorkflowRunAuthorityError(
      `Workflow storage directory authority changed: ${path}`,
    );
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(stats: Pick<Stats, "dev" | "ino">): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function workflowRunStoreRoot(
  rootDir: string,
  owner: WorkflowOwnerIdentity,
): string {
  if (!isAbsolute(rootDir) || Buffer.byteLength(rootDir, "utf8") > 4096) {
    throw new Error("Invalid workflow store root directory");
  }
  validateOwnerRecord(owner);
  return join(rootDir, owner.projectKey, owner.piSessionId);
}

export function workflowRunPath(
  rootDir: string,
  owner: WorkflowOwnerIdentity,
  runId: string,
): string {
  validateWorkflowRunId(runId);
  return join(workflowRunStoreRoot(rootDir, owner), "runs", runId);
}
