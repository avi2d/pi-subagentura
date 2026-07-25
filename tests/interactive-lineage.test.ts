import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LINEAGE_SCHEMA_VERSION,
  cancelLineageSubtreeBestEffort,
  hashLineageRoot,
  projectLineageStore,
  projectManifests,
  readLineageManifest,
  resolveLineageStorePaths,
  safeContainedPath,
  validateLineageManifest,
  writeLineageManifestAtomic,
  type LineageManifest,
} from "../src/interactive-lineage";

const tempDirs: string[] = [];
const rootId = "root-session-1";
const rootHash = hashLineageRoot(rootId);

function manifest(
  agentId: string,
  overrides: Partial<LineageManifest> = {},
): LineageManifest {
  return {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    agentId,
    rootId,
    rootHash,
    ownerSessionId: `owner-${agentId}`,
    name: `agent ${agentId}`,
    taskPreview: `task ${agentId}`,
    startedAt: `2026-07-25T10:00:${agentId.replace(/\D/g, "").padStart(2, "0")}Z`,
    cwd: `/work/${agentId}`,
    pane: {
      backend: "zellij",
      paneId: `pane-${agentId}`,
      muxSession: "mux-session",
      windowName: "tab-a",
    },
    artifactDir: `/artifacts/${agentId}`,
    childSessionFile: `/sessions/${agentId}.jsonl`,
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lineage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("interactive lineage manifests", () => {
  it("validates bounded manifests and rejects unsafe IDs, unknown keys, and invalid root hashes", () => {
    const valid = validateLineageManifest(manifest("agent-1"));

    expect(valid.agentId).toBe("agent-1");
    expect(valid.pane.muxSession).toBe("mux-session");

    expect(() => validateLineageManifest({ ...manifest("../escape") })).toThrow(
      /unsafe characters/,
    );
    expect(() =>
      validateLineageManifest({ ...manifest("agent-2"), extra: true }),
    ).toThrow(/unknown key extra/);
    expect(() =>
      validateLineageManifest({
        ...manifest("agent-2"),
        rootHash: "0".repeat(64),
      }),
    ).toThrow(/rootHash does not match/);
    expect(() =>
      validateLineageManifest(
        manifest("agent-2", { taskPreview: "x".repeat(20) }),
        {
          maxTaskPreviewBytes: 8,
        },
      ),
    ).toThrow(/taskPreview exceeds byte limit/);
  });

  it("writes atomically and leaves no manifest or temp file when validation fails", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");

    const filePath = await writeLineageManifestAtomic(
      nodesDir,
      manifest("agent-1"),
    );
    await expect(readLineageManifest(filePath)).resolves.toMatchObject({
      agentId: "agent-1",
    });

    await expect(
      writeLineageManifestAtomic(
        nodesDir,
        manifest("agent-2", { taskPreview: "x".repeat(64) }),
        {
          maxManifestBytes: 80,
        },
      ),
    ).rejects.toThrow(/exceeds byte limit/);

    const entries = await fs.readdir(nodesDir);
    expect(entries).toEqual(["agent-1.json"]);
  });
});

describe("interactive lineage path safety", () => {
  it("hashes root IDs deterministically and stores by hash-safe path", async () => {
    const dir = await tempDir();
    const paths = await resolveLineageStorePaths(dir, "root/with/slashes");
    const expectedHash = hashLineageRoot("root/with/slashes");

    expect(hashLineageRoot("root/with/slashes")).toBe(expectedHash);
    expect(path.basename(paths.treeDir)).toBe(expectedHash);
    expect(paths.nodesDir).toBe(path.join(paths.treeDir, "nodes"));
  });

  it("rejects traversal and symlink components when resolving contained paths", async () => {
    const dir = await tempDir();
    const inside = path.join(dir, "inside");
    await fs.mkdir(inside);
    await fs.writeFile(path.join(inside, "file.txt"), "ok");

    await expect(
      safeContainedPath(dir, path.join(inside, "file.txt")),
    ).resolves.toBe(path.join(inside, "file.txt"));
    await expect(
      safeContainedPath(dir, path.join(dir, "..", "outside")),
    ).rejects.toThrow(/escapes lineage root/);

    const outside = await tempDir();
    const link = path.join(dir, "link");
    await fs.symlink(outside, link);
    await expect(
      safeContainedPath(dir, path.join(link, "file.txt")),
    ).rejects.toThrow(/symlink/);
  });
});

describe("interactive lineage projection", () => {
  it("projects deterministically while marking orphan and stale nodes non-actionable", async () => {
    const projection = await projectManifests(
      [
        manifest("child-2", { parentAgentId: "root" }),
        manifest("root"),
        manifest("orphan", { parentAgentId: "missing" }),
        manifest("child-1", { parentAgentId: "root" }),
      ],
      rootHash,
      (candidate) => candidate.agentId === "child-2",
    );

    expect(projection.roots.map((node) => node.manifest.agentId)).toEqual([
      "root",
      "orphan",
    ]);
    expect(
      projection.roots[0]?.children.map((node) => node.manifest.agentId),
    ).toEqual(["child-1", "child-2"]);
    expect(
      projection.nonActionable.map((node) => [
        node.manifest.agentId,
        node.reasons,
      ]),
    ).toEqual([
      ["orphan", ["orphan"]],
      ["child-2", ["stale"]],
    ]);
    expect(projection.issues.map((issue) => issue.kind)).toEqual([
      "orphan",
      "stale",
    ]);
  });

  it("does not hang on cycles and places cyclic nodes in a non-actionable bucket", async () => {
    const projection = await projectManifests(
      [
        manifest("a", { parentAgentId: "c" }),
        manifest("b", { parentAgentId: "a" }),
        manifest("c", { parentAgentId: "b" }),
      ],
      rootHash,
    );

    expect(projection.roots).toEqual([]);
    expect(
      projection.nonActionable.map((node) => node.manifest.agentId),
    ).toEqual(["a", "b", "c"]);
    expect(projection.issues.every((issue) => issue.kind === "cycle")).toBe(
      true,
    );
  });

  it("reports malformed files and enforces node, depth, and projection byte caps", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await fs.mkdir(nodesDir);
    await writeLineageManifestAtomic(nodesDir, manifest("root"));
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("child-1", { parentAgentId: "root" }),
    );
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("child-2", { parentAgentId: "child-1" }),
    );
    await fs.writeFile(path.join(nodesDir, "z-bad.json"), "not json");

    const projection = await projectLineageStore(
      nodesDir,
      rootHash,
      () => false,
      {
        maxDepth: 1,
        maxNodes: 4,
        maxProjectionBytes: 10_000,
      },
    );

    expect(projection.truncated).toBe(true);
    expect(projection.issues.map((issue) => issue.kind)).toContain("malformed");
    expect(projection.issues.map((issue) => issue.kind)).toContain("truncated");
  });

  it("enforces the projection byte cap", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await writeLineageManifestAtomic(nodesDir, manifest("root"));
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("child-1", { parentAgentId: "root" }),
    );

    const projection = await projectLineageStore(
      nodesDir,
      rootHash,
      () => false,
      {
        maxProjectionBytes: 100,
      },
    );

    expect(projection.truncated).toBe(true);
    expect(
      projection.issues.some(
        (issue) => issue.reason === "projection byte cap reached",
      ),
    ).toBe(true);
  });
});

describe("interactive lineage cancellation", () => {
  it("cancels deepest-first and continues after failures", async () => {
    const projection = await projectManifests(
      [
        manifest("root"),
        manifest("child-1", { parentAgentId: "root" }),
        manifest("child-2", { parentAgentId: "root" }),
        manifest("grandchild", { parentAgentId: "child-1" }),
      ],
      rootHash,
      (candidate) => candidate.agentId === "child-2",
    );
    const root = projection.roots[0];
    expect(root).toBeDefined();
    const calls: string[] = [];

    const result = await cancelLineageSubtreeBestEffort(root!, {
      isStale: (node) => {
        calls.push(`stale:${node.manifest.agentId}`);
        return node.manifest.agentId === "child-2";
      },
      isTerminal: (node) => {
        calls.push(`terminal:${node.manifest.agentId}`);
        return node.manifest.agentId === "child-1";
      },
      cancel: (node) => {
        calls.push(`cancel:${node.manifest.agentId}`);
        if (node.manifest.agentId === "grandchild") {
          throw new Error("close failed");
        }
      },
    });

    expect(result.attempted.map((item) => [item.agentId, item.status])).toEqual(
      [
        ["grandchild", "failed"],
        ["child-1", "already-terminal"],
        ["child-2", "stale"],
        ["root", "cancelled"],
      ],
    );
    expect(calls).toEqual([
      "stale:grandchild",
      "terminal:grandchild",
      "cancel:grandchild",
      "stale:child-1",
      "terminal:child-1",
      "stale:root",
      "terminal:root",
      "cancel:root",
    ]);
    expect(result.failed).toMatchObject([
      { agentId: "grandchild", status: "failed" },
    ]);
    expect(result.cancelled).toEqual(["root"]);
  });
});
