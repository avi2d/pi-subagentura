import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { DurableWorkflowController } from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

const fixture = fileURLToPath(
  new URL("./fixtures/workflow-durable-crash-child.cjs", import.meta.url),
);
const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
let compiledDir: string;

const replacementOwner: WorkflowOwnerIdentity = {
  projectKey: "crash-project",
  cwd: "/crash/repo",
  piSessionId: "crash-session",
  ownerId: "replacement-owner",
  ownerGeneration: 2,
  leaseToken: "replacement-lease",
};

function success(output: string): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      cost: 0.25,
      turns: 1,
    },
    model: "test/model",
  };
}

async function transpileRuntimeGraph(
  outputDir: string,
  entries: readonly string[],
): Promise<void> {
  await writeFile(join(outputDir, "package.json"), '{"type":"module"}\n');
  const configPath = join(outputDir, "tsconfig.json");
  await writeFile(
    configPath,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        rootDir: sourceDir,
        outDir: outputDir,
        noEmit: false,
        skipLibCheck: true,
        strict: true,
        types: ["node"],
      },
      files: entries.map((entry) => join(sourceDir, entry)),
    }),
  );
  execFileSync(
    process.execPath,
    [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", configPath],
    { cwd: repoRoot, stdio: "pipe" },
  );
  for (const asset of await readdir(sourceDir)) {
    if (!asset.endsWith(".mjs")) continue;
    await writeFile(
      join(outputDir, asset),
      await readFile(join(sourceDir, asset)),
    );
  }
  const emitted = await readdir(outputDir, {
    recursive: true,
    encoding: "utf8",
  });
  for (const relativePath of emitted) {
    if (!relativePath.endsWith(".js")) continue;
    const outputPath = join(outputDir, relativePath);
    const output = (await readFile(outputPath, "utf8")).replace(
      /(from\s+|import\s*\(\s*|import\s+)(["'])(\.\/[^"']+)\2/g,
      (full, prefix: string, quote: string, specifier: string) =>
        specifier.endsWith(".js") || specifier.endsWith(".mjs")
          ? full
          : `${prefix}${quote}${specifier}.js${quote}`,
    );
    await writeFile(outputPath, output);
  }
}

function startCrashChild(
  rootDir: string,
  crashPoint: "attempt-started" | "provider-returned",
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [fixture, compiledDir, rootDir, crashPoint],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForPoint(
  child: ChildProcessWithoutNullStreams,
  expectedPoint: string,
): Promise<void> {
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const {
    promise,
    resolve: resolvePoint,
    reject,
  } = Promise.withResolvers<void>();
  lines.on("line", (line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("point" in parsed) ||
        parsed.point !== expectedPoint
      ) {
        return;
      }
      lines.close();
      resolvePoint();
    } catch (error) {
      lines.close();
      reject(error);
    }
  });
  child.once("exit", (code, signal) => {
    lines.close();
    reject(
      new Error(
        `Crash child exited before ${expectedPoint}: ${code ?? signal}; ${stderr}`,
      ),
    );
  });
  child.once("error", reject);
  return promise;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  const { promise, resolve: resolveExit } = Promise.withResolvers<void>();
  child.once("exit", () => resolveExit());
  return promise;
}

beforeAll(async () => {
  compiledDir = await mkdtemp(join(repoRoot, ".workflow-durable-compiled-"));
  await transpileRuntimeGraph(compiledDir, [
    "workflow-durable-plan-runner.ts",
    "workflow-run-store.ts",
  ]);
});

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(waitForExit));
  await WorkflowRunStore.releaseAllLeases(replacementOwner);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await rm(compiledDir, { recursive: true, force: true });
});

describe("Milestone 2 subprocess crash recovery", () => {
  it.each(["attempt-started", "provider-returned"] as const)(
    "kills a real parent at %s and retries only uncommitted task B",
    async (crashPoint) => {
      const root = await mkdtemp(join(tmpdir(), "workflow-durable-crash-"));
      roots.push(root);
      const child = startCrashChild(root, crashPoint);
      await waitForPoint(child, crashPoint);
      child.kill("SIGKILL");
      await waitForExit(child);

      const reopenedStore = new WorkflowRunStore({
        rootDir: root,
        owner: replacementOwner,
      });
      const firstController = new DurableWorkflowController({
        store: reopenedStore,
        owner: replacementOwner,
      });
      const interrupted = await firstController.getStatus("crash-run");
      expect(interrupted).toMatchObject({
        owner: {
          projectKey: "crash-project",
          piSessionId: "crash-session",
          ownerId: "crash-owner",
          ownerGeneration: 1,
          leaseToken: "crash-lease",
        },
        status: "interrupted",
        tasks: {
          "task-a": { status: "succeeded", attempt: 1 },
          "task-b": { status: "interrupted", attempt: 1 },
        },
        usage: {
          input: 3,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 6,
          costUsd: 0.25,
          turns: 1,
        },
        usageLowerBound: true,
      });
      const coldPrefix = (await reopenedStore.readRun("crash-run")).events.map(
        (event) => event.eventId,
      );
      await firstController.getStatus("crash-run");
      const unchangedPrefix = await reopenedStore.readRun("crash-run");
      expect(unchangedPrefix.events.map((event) => event.eventId)).toEqual(
        coldPrefix,
      );
      expect(unchangedPrefix.events.at(-1)?.type).toBe("attempt_started");

      const calls: string[] = [];
      expect(calls).toEqual([]);
      const leaseEpoch = await reopenedStore.getLeaseEpoch();
      const completed = await firstController.resume("crash-run", {
        expectedRevision: interrupted!.revision,
        expectedRunEpoch: interrupted!.runEpoch,
        ownerGeneration: replacementOwner.ownerGeneration,
        leaseEpoch,
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          return success(`resumed:${prompt}`);
        },
      });

      expect(calls).toEqual(["B"]);
      expect(completed).toMatchObject({
        status: "done",
        tasks: {
          "task-a": { status: "succeeded", attempt: 1 },
          "task-b": { status: "succeeded", attempt: 2 },
        },
        operations: {
          "task-b": {
            attempts: {
              2: {
                claim: {
                  ownerId: replacementOwner.ownerId,
                  ownerGeneration: replacementOwner.ownerGeneration,
                  leaseEpoch,
                },
              },
            },
          },
        },
        usage: {
          input: 6,
          output: 4,
          cacheRead: 2,
          cacheWrite: 0,
          totalTokens: 12,
          costUsd: 0.5,
          turns: 2,
        },
      });
      expect(completed).not.toHaveProperty("delivery");

      const secondController = new DurableWorkflowController({
        store: new WorkflowRunStore({ rootDir: root, owner: replacementOwner }),
        owner: replacementOwner,
      });
      await expect(
        secondController.getResult("crash-run"),
      ).resolves.toMatchObject({
        status: "done",
      });
      const thirdController = new DurableWorkflowController({
        store: new WorkflowRunStore({ rootDir: root, owner: replacementOwner }),
        owner: replacementOwner,
      });
      await expect(
        thirdController.getResult("crash-run"),
      ).resolves.toMatchObject({
        status: "done",
      });
      const record = await reopenedStore.readRun("crash-run");
      expect(
        record.events.some((event) => event.type.startsWith("delivery_")),
      ).toBe(false);
      expect(
        record.events.filter((event) => event.type === "run_result"),
      ).toHaveLength(1);
    },
  );
});
