/**
 * Tests for session_shutdown state-file behavior:
 * deletion on /new, preservation on quit/reload/resume,
 * pane preservation on reload, defensive guard for missing ctx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { appendInteractiveState, loadInteractiveStates } from "../src/artifact";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { importFresh } from "./test-utils";
import { makeTmp, makeState } from "./subagent-rehydrate-helpers";

describe("session_shutdown clean-slate on /new and quit", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  });

  async function setupExtension() {
    const api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    mod.default(api as any);

    const shutdownHandlers: Array<(event: any, ctx: any) => void> = [];
    const startHandlers: Array<(event: any, ctx: any) => void> = [];
    for (const [event, handler] of (api.on as any).mock.calls) {
      if (event === "session_shutdown") shutdownHandlers.push(handler);
      if (event === "session_start") startHandlers.push(handler);
    }
    return { api, shutdownHandlers, startHandlers, mod };
  }

  it("session_shutdown with reason='new' deletes the state file", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    expect(loadInteractiveStates(cwd)).not.toBeNull();
    const { shutdownHandlers } = await setupExtension();
    const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
    heavyHandler(
      { type: "session_shutdown", reason: "new" },
      {
        cwd,
      },
    );
    expect(loadInteractiveStates(cwd)).toBeNull();
  });

  it("session_shutdown with reason='quit' KEEPS the state file (rehydrate depends on it)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    expect(loadInteractiveStates(cwd)).not.toBeNull();
    const { shutdownHandlers } = await setupExtension();
    const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
    heavyHandler(
      { type: "session_shutdown", reason: "quit" },
      {
        cwd,
      },
    );
    expect(loadInteractiveStates(cwd)).not.toBeNull();
  });

  it("rehydrates interactive subagents after quit and matching startup", async () => {
    const id = "survives-quit";
    const sessionId = "session-mine";
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id,
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: sessionId,
    });

    const { shutdownHandlers } = await setupExtension();
    const shutdownHandler = shutdownHandlers[shutdownHandlers.length - 1];
    shutdownHandler(
      { type: "session_shutdown", reason: "quit" },
      { cwd, sessionManager: { getSessionId: () => sessionId } },
    );

    expect(interactiveSubagentRegistry.has(id)).toBe(false);
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();

    const { startHandlers } = await setupExtension();
    const startHandler = startHandlers[startHandlers.length - 1];
    startHandler(
      { type: "session_start", reason: "startup" },
      { cwd, sessionManager: { getSessionId: () => sessionId } },
    );

    expect(interactiveSubagentRegistry.has(id)).toBe(true);
  });

  it("session_shutdown with reason='reload' KEEPS the state file (rehydrate depends on it)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    const { shutdownHandlers } = await setupExtension();
    const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
    heavyHandler(
      { type: "session_shutdown", reason: "reload" },
      {
        cwd,
      },
    );
    expect(loadInteractiveStates(cwd)).not.toBeNull();
  });

  it("session_shutdown with reason='resume' KEEPS the state file", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    const { shutdownHandlers } = await setupExtension();
    const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
    heavyHandler(
      { type: "session_shutdown", reason: "resume" },
      {
        cwd,
      },
    );
    expect(loadInteractiveStates(cwd)).not.toBeNull();
  });

  it("session_shutdown with reason='reload' preserves running panes for rehydrate", async () => {
    const execFileSync = vi.fn((_file: string, args: string[]) => {
      if (args[0] === "display-message") return Buffer.from("#42");
      return Buffer.from("");
    });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFileSync }));

    const { shutdownHandlers, mod } = await setupExtension();
    const state = makeState(cwd, "abc12345");
    state.parentSessionId = "pi";
    mod.interactiveSubagentRegistry.set(state.id, state);

    const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
    heavyHandler(
      { type: "session_shutdown", reason: "reload" },
      {
        cwd,
        sessionManager: { getSessionId: () => "pi" },
      },
    );

    expect(execFileSync).not.toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["kill-pane"]),
      expect.anything(),
    );
  });

  it("session_shutdown is a no-op for the state file when ctx.cwd is missing", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    const { shutdownHandlers } = await setupExtension();
    const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
    expect(() =>
      heavyHandler({ type: "session_shutdown", reason: "new" }, undefined),
    ).not.toThrow();
    // File is unchanged because ctx was undefined — defensive guard.
    expect(loadInteractiveStates(cwd)).not.toBeNull();
  });
});
