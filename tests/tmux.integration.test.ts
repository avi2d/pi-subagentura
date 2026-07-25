import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  cancelInteractiveSubagent,
  interactiveSubagentRegistry,
  launchInteractiveSubagent,
  sendCommandToPane,
} from "../src/interactive-tmux";
import {
  projectLineageStore,
  resolveLineageStorePaths,
} from "../src/interactive-lineage";
import { __resetMuxInstances } from "../src/multiplexer";

const socket =
  process.env.PI_SUBAGENTURA_TMUX_SOCKET ??
  `pi-subagentura-test-${process.pid}`;

const savedEnv = {
  PATH: process.env.PATH,
  TMUX: process.env.TMUX,
  TMUX_PANE: process.env.TMUX_PANE,
  ZELLIJ_SESSION_NAME: process.env.ZELLIJ_SESSION_NAME,
  PI_SUBAGENTURA_TMUX_SOCKET: process.env.PI_SUBAGENTURA_TMUX_SOCKET,
  PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
  PI_SUBAGENTURA_AGENT_ID: process.env.PI_SUBAGENTURA_AGENT_ID,
  PI_SUBAGENTURA_ROOT_ID: process.env.PI_SUBAGENTURA_ROOT_ID,
  PI_SUBAGENTURA_DEPTH: process.env.PI_SUBAGENTURA_DEPTH,
  ZDOTDIR: process.env.ZDOTDIR,
};

let tempRoot: string;

function tmux(args: readonly string[]): string {
  return execFileSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
  });
}

function restoreEnv(name: keyof typeof savedEnv): void {
  const value = savedEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function installFakePiBin(root: string): void {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });

  const piPath = join(binDir, "pi");
  writeFileSync(
    piPath,
    `#!/usr/bin/env bash
set -euo pipefail

echo "fake pi started: $*" >> "$ARTIFACT_DIR/fake-pi.log"
echo "fake initial result" > "$ARTIFACT_DIR/output.md"
"$ARTIFACT_DIR/cli.mjs" done 0

# Stay alive like a REPL so sendCommandToPane can deliver follow-up turns.
while IFS= read -r line; do
  echo "followup: $line" >> "$ARTIFACT_DIR/followups.log"
  echo "fake followup result: $line" > "$ARTIFACT_DIR/output.md"
  "$ARTIFACT_DIR/cli.mjs" done 0
done
`,
  );
  chmodSync(piPath, 0o700);
  writeFileSync(join(root, ".zshenv"), `export PATH=${binDir}:$PATH\n`);

  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.ZDOTDIR = root;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(message);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "pi-subagentura-tmux-"));
  installFakePiBin(tempRoot);

  process.env.PI_SUBAGENTURA_TMUX_SOCKET = socket;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(tempRoot, "sessions");

  // Force the relaxed tmux path that creates a detached session. Without this,
  // running the test locally inside tmux would try to target the developer's
  // real parent pane from the isolated CI socket.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  delete process.env.ZELLIJ_SESSION_NAME;

  interactiveSubagentRegistry.clear();
  __resetMuxInstances();
});

afterEach(() => {
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], {
      stdio: "ignore",
    });
  } catch {
    // The server may already be gone if a test failed before creating it.
  }

  interactiveSubagentRegistry.clear();
  __resetMuxInstances();

  restoreEnv("PATH");
  restoreEnv("TMUX");
  restoreEnv("TMUX_PANE");
  restoreEnv("ZELLIJ_SESSION_NAME");
  restoreEnv("PI_SUBAGENTURA_TMUX_SOCKET");
  restoreEnv("PI_CODING_AGENT_SESSION_DIR");
  restoreEnv("PI_SUBAGENTURA_AGENT_ID");
  restoreEnv("PI_SUBAGENTURA_ROOT_ID");
  restoreEnv("PI_SUBAGENTURA_DEPTH");
  restoreEnv("ZDOTDIR");

  rmSync(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test("launches an interactive subagent in an isolated tmux session", async () => {
  const cwd = mkdtempSync(join(tempRoot, "workspace-"));

  const state = launchInteractiveSubagent({
    name: "CI tmux child",
    task: "do fake work",
    cwd,
    muxPreference: "tmux",
    background: true,
    notifyOnComplete: "notify",
  });

  expect(state.mux).toBe("tmux");
  expect(state.paneId).toMatch(/^%/);
  expect(state.attachCommand).toContain(`tmux -L '${socket}' attach`);

  await waitFor(() => {
    const eventsFile = join(state.artifactDir, "events.ndjson");
    return (
      existsSync(join(state.artifactDir, "output.md")) &&
      existsSync(eventsFile) &&
      readFileSync(eventsFile, "utf8").includes('"type":"completion"')
    );
  }, "timed out waiting for fake pi to finish initial turn");

  expect(readFileSync(join(state.artifactDir, "output.md"), "utf8")).toContain(
    "fake initial result",
  );

  const events = readFileSync(join(state.artifactDir, "events.ndjson"), "utf8");
  expect(events).toContain('"type":"started"');
  expect(events).toContain('"type":"completion"');
  expect(events).toContain('"outcome":"done"');
});

test("sends a follow-up message into the same tmux pane", async () => {
  const cwd = mkdtempSync(join(tempRoot, "workspace-"));

  const state = launchInteractiveSubagent({
    name: "Followup child",
    task: "initial",
    cwd,
    muxPreference: "tmux",
    background: true,
  });

  await waitFor(
    () => existsSync(join(state.artifactDir, "output.md")),
    "timed out waiting for fake pi to start",
  );

  sendCommandToPane(state, "second message");

  await waitFor(
    () =>
      existsSync(join(state.artifactDir, "followups.log")) &&
      readFileSync(join(state.artifactDir, "followups.log"), "utf8").includes(
        "second message",
      ),
    "timed out waiting for follow-up to reach fake pi",
  );
});

test("cancel writes the cancellation marker and kills the tmux pane", async () => {
  const cwd = mkdtempSync(join(tempRoot, "workspace-"));

  const state = launchInteractiveSubagent({
    name: "Cancel child",
    task: "long work",
    cwd,
    muxPreference: "tmux",
    background: true,
  });

  const cancelled = cancelInteractiveSubagent(state.id);

  expect(cancelled?.status).toBe("cancelled");
  expect(existsSync(join(state.artifactDir, ".cancelled"))).toBe(true);
});

test("launches and projects a recursive child hierarchy across cwd values", async () => {
  const childCwd = mkdtempSync(join(tempRoot, "child-workspace-"));
  const grandchildCwd = mkdtempSync(join(tempRoot, "grandchild-workspace-"));
  const rootId = "tmux-recursive-root";
  process.env.PI_SUBAGENTURA_ROOT_ID = rootId;
  delete process.env.PI_SUBAGENTURA_AGENT_ID;
  delete process.env.PI_SUBAGENTURA_DEPTH;

  const child = launchInteractiveSubagent({
    name: "Recursive child",
    task: "spawn a nested child",
    cwd: childCwd,
    parentSessionId: "root-owner",
    muxPreference: "tmux",
    background: true,
  });
  process.env.PI_SUBAGENTURA_AGENT_ID = child.id;
  process.env.PI_SUBAGENTURA_DEPTH = "1";
  const grandchild = launchInteractiveSubagent({
    name: "Recursive grandchild",
    task: "nested fake work",
    cwd: grandchildCwd,
    parentSessionId: "child-owner",
    muxPreference: "tmux",
    background: true,
  });

  const paths = await resolveLineageStorePaths(
    process.env.PI_CODING_AGENT_SESSION_DIR!,
    rootId,
  );
  const projection = await projectLineageStore(
    paths.nodesDir,
    basename(paths.treeDir),
    () => false,
  );

  expect(projection.roots.map((node) => node.manifest.agentId)).toEqual([
    child.id,
  ]);
  expect(projection.roots[0]?.manifest.cwd).toBe(childCwd);
  expect(
    projection.roots[0]?.children.map((node) => node.manifest.agentId),
  ).toEqual([grandchild.id]);
  expect(projection.roots[0]?.children[0]?.manifest.cwd).toBe(grandchildCwd);

  cancelInteractiveSubagent(grandchild.id);
  cancelInteractiveSubagent(child.id);
});
