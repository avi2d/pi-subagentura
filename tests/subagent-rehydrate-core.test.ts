/**
 * Tests for rehydrateInteractiveSubagents core behavior:
 * missing state, registry population, attach/focus commands,
 * idempotency, runtime cursors, alive/terminal counts, unreachable cwd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  appendInteractiveState,
  artifactPath,
} from "../src/artifact";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { importFresh } from "./test-utils";
import { makeTmp, makeState } from "./subagent-rehydrate-helpers";

describe("rehydrateInteractiveSubagents", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    // Install a tmux mock so isPaneAlive returns false for fake pane IDs.
    // Without this, tmux 3.6b treats unknown pane IDs as "alive" (succeeds with empty output),
    // making the alive/terminal counts environment-dependent.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string) => {
        // Only handle display-message used by isPaneAlive; throw for all others
        // (new-window, etc.) so they don't accidentally succeed.
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

  it("returns { total: 0 } when the state file is missing", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const result = mod.rehydrateInteractiveSubagents(cwd);
    expect(result).toEqual({ total: 0, alive: 0, terminal: 0 });
  });

  it("populates the registry from a state.json with one entry", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      triggerTurnOnComplete: true,
    });

    const result = mod.rehydrateInteractiveSubagents(cwd);

    expect(result.total).toBe(1);
    const rehydrated = interactiveSubagentRegistry.get("abc12345");
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.paneId).toBe("%42");
    expect(rehydrated?.mux).toBe("tmux");
    expect(rehydrated?.parentSessionId).toBe("pi");
    expect(rehydrated?.triggerTurnOnComplete).toBe(true);
  });

  it("rebuilds attach and focus commands on rehydrate", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") {
          if (
            args.includes("#{session_name}\t#{window_index}\t#{pane_index}")
          ) {
            return "demo\t1\t0\n";
          }
          return Buffer.from("%42");
        }
        return "";
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = mod.interactiveSubagentRegistry.get("abc12345");
    expect(rehydrated?.attachCommand).toContain("tmux attach");
    expect(rehydrated?.selectPaneCommand).toContain("tmux select-window");
  });

  it("is a no-op when the registry already has the id (idempotent)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });

    // Pre-populate the registry with a different (older) state.
    const older: InteractiveSubagentState = { ...state, paneId: "%OLD" };
    interactiveSubagentRegistry.set("abc12345", older);

    mod.rehydrateInteractiveSubagents(cwd);

    const after = interactiveSubagentRegistry.get("abc12345");
    expect(after?.paneId).toBe("%OLD");
  });

  it("resets all runtime cursors on rehydrate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get("abc12345")!;
    expect(rehydrated.lastDeliveredEventTs).toBe(0);
    expect(rehydrated.lastDeliveredSessionByte).toBe(0);
    expect(rehydrated.lastInjectedEventTs).toBeUndefined();
    expect(rehydrated.lastSnapshotEventTs).toBeUndefined();
    expect(rehydrated.injected).toBeUndefined();
    expect(rehydrated.autoDoneForTurnAt).toBeUndefined();
  });

  it("counts alive vs terminal in the return value", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // Two entries: alive1 (no events, pane not alive → unknown), done1 (done event,
    // pane not alive → exited). We can predict exact counts here because the test
    // runs in a tmux environment and isPaneAlive returns false for fake pane IDs.
    const cwdA = cwd;
    const cwdB = cwd;
    for (const id of ["alive1", "done1"]) {
      appendInteractiveState(cwdA, {
        id,
        paneId: "%" + id,
        mux: "tmux",
        artifactDir: join(cwdB, id),
        sessionFile: "/tmp/sess.jsonl",
      });
    }
    const art1 = artifactPath(cwdB, "done1");
    appendEvent(art1, { ts: 1, type: "started", status: "running" });
    appendEvent(art1, { ts: 2, type: "done", status: "done", exitCode: 0 });

    const result = mod.rehydrateInteractiveSubagents(cwdA);

    expect(result.total).toBe(2);
    // alive1 has no events → status=unknown (not counted); done1 has done event → status=exited (terminal)
    expect(result.alive).toBe(0);
    expect(result.terminal).toBe(1);
    expect(interactiveSubagentRegistry.get("alive1")?.status).toBe("unknown");
    expect(interactiveSubagentRegistry.get("done1")?.status).toBe("exited");
  });

  it("does not throw when ctx.cwd is unreachable (best-effort recovery)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    expect(() =>
      mod.rehydrateInteractiveSubagents(
        "/nonexistent/path/that/does/not/exist",
      ),
    ).not.toThrow();
    expect(() =>
      mod.rehydrateInteractiveSubagents(
        "/nonexistent/path/that/does/not/exist",
      ),
    ).not.toThrow();
  });
});
