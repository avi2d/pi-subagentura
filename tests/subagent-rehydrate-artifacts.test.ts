/**
 * Tests for artifact-derived rehydrate behavior:
 * inject/notify cursor handling, name recovery from prompt file,
 * startedAt recovery from first event, fallback name/startedAt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  appendInteractiveState,
  artifactPath,
} from "../src/artifact";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { importFresh } from "./test-utils";
import { makeTmp } from "./subagent-rehydrate-helpers";

describe("rehydrateInteractiveSubagents", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    // Install a tmux mock so isPaneAlive returns false for fake pane IDs.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string) => {
        throw new Error("mock: child_process unavailable");
      },
    }));
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  });

  it("inject-mode orphans DO re-inject their existing terminal event on the first poll after rehydrate", async () => {
    // Behavior change: we no longer suppress re-injection here. The inject-mode path
    // fires on every NEW `done` event. On rehydrate, lastInjectedEventTs starts as
    // undefined, so the first poll will re-inject the latest terminal event. This means
    // exactly one extra inject per sub-agent on parent reload, which is acceptable —
    // it's better than silently dropping a result that completed during the reload downtime.
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "inject-orphan";
    const artDir = join(cwd, id);
    appendInteractiveState(cwd, {
      id,
      paneId: "%77",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
      notifyOnComplete: "inject",
    });
    // Add a done event to the artifact (what an orphan-with-completed-work looks like).
    const art = artifactPath(cwd, id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated).toBeDefined();
    // lastInjectedEventTs should remain undefined — we no longer suppress re-injection.
    expect(rehydrated?.lastInjectedEventTs).toBeUndefined();
  });

  it("notify-mode orphans leave lastInjectedEventTs undefined (inject path is irrelevant)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "notify-orphan";
    const artDir = join(cwd, id);
    appendInteractiveState(cwd, {
      id,
      paneId: "%88",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
      notifyOnComplete: "notify",
    });
    mod.rehydrateInteractiveSubagents(cwd);
    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated?.lastInjectedEventTs).toBeUndefined();
  });

  it("recovers name from prompt file and startedAt from first event", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "recover-me";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });

    // Create a prompt file: the label before "-prompt.md" becomes the name
    writeFileSync(join(artDir, "my-agent-prompt.md"), "task content", {
      mode: 0o600,
    });

    // Persist state entry (name not in persisted state — recovered from prompt file)
    appendInteractiveState(cwd, {
      id,
      paneId: "%99",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
      eventByteCursor: 0,
      sessionByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      lifecycle: { startedAt: 1000 },
    });

    // Event history remains available without being reparsed during rehydrate.
    const art = artifactPath(cwd, id);
    appendEvent(art, { ts: 1000, type: "started", status: "running" });
    appendEvent(art, { ts: 2000, type: "done", status: "done", exitCode: 0 });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.name).toBe("my-agent"); // from prompt file label
    expect(rehydrated?.startedAt).toBe(1000);
  });

  it("falls back to id for name and 0 for startedAt when artifacts are missing", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "fallback-id";

    // Persist state with no artifact files (dir won't exist)
    appendInteractiveState(cwd, {
      id,
      paneId: "%99",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/sess.jsonl",
    });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.name).toBe(id); // falls back to entry.id
    expect(rehydrated?.startedAt).toBe(0); // falls back to 0
  });
});
