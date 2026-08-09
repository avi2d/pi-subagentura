import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const fixture = fileURLToPath(
  new URL("./fixtures/workflow-lease-child.mjs", import.meta.url),
);
const leaseSource = fileURLToPath(
  new URL("../src/workflow-lease.ts", import.meta.url),
);
const compiler = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);
const roots: string[] = [];

type ChildResult = {
  ok: boolean;
  record?: { epoch: number; ownerId: string; processId?: number };
  error?: string;
};

function startChild(
  rootDir: string,
  ownerId: string,
  leaseToken: string,
  now: number,
  modulePath: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      fixture,
      "hold",
      rootDir,
      "project",
      ownerId,
      leaseToken,
      "10",
      String(now),
      modulePath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

function firstResult(
  child: ChildProcessWithoutNullStreams,
): Promise<ChildResult> {
  const reader = createInterface({ input: child.stdout });
  let received = false;
  return new Promise((resolve, reject) => {
    const onLine = (line: string): void => {
      received = true;
      reader.close();
      try {
        resolve(JSON.parse(line) as ChildResult);
      } catch (error) {
        reject(error);
      }
    };
    reader.once("line", onLine);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && !received) {
        reject(new Error(`lease child exited before result: ${code}`));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkflowNamespaceLease cross-process fencing", () => {
  it("allows one initial child acquire and fences takeover to epoch two after death", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-lease-child-"));
    roots.push(root);
    const compilation = spawnSync(
      process.execPath,
      [
        compiler,
        leaseSource,
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "--outDir",
        join(root, "compiled"),
        "--skipLibCheck",
        "--declaration",
        "false",
      ],
      { encoding: "utf8" },
    );
    expect(compilation.status, compilation.stderr).toBe(0);
    const modulePath = join(root, "compiled", "workflow-lease.js");
    const first = startChild(root, "child-one", "token-one", 100, modulePath);
    const second = startChild(root, "child-two", "token-two", 100, modulePath);
    const [firstOutcome, secondOutcome] = await Promise.all([
      firstResult(first),
      firstResult(second),
    ]);

    expect([firstOutcome.ok, secondOutcome.ok].filter(Boolean)).toHaveLength(1);
    expect(
      [firstOutcome.ok, secondOutcome.ok].filter((value) => !value),
    ).toHaveLength(1);
    const winner = firstOutcome.ok ? first : second;
    const loser = firstOutcome.ok ? second : first;
    expect(
      firstOutcome.ok ? firstOutcome.record : secondOutcome.record,
    ).toMatchObject({ epoch: 1 });
    await waitForExit(loser);
    winner.kill("SIGKILL");
    await waitForExit(winner);

    const takeover = spawn(
      process.execPath,
      [
        fixture,
        "acquire",
        root,
        "project",
        "replacement",
        "token-replacement",
        "10",
        "111",
        modulePath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const takeoverResult = await firstResult(takeover);
    await waitForExit(takeover);
    if (!takeoverResult.ok) throw new Error(takeoverResult.error);
    expect(takeoverResult).toMatchObject({
      ok: true,
      record: { epoch: 2, ownerId: "replacement" },
    });
  });
});
