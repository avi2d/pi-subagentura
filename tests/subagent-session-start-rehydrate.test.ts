/**
 * Tests for session_start integration with the rehydrate logic.
 * The session_start handler repopulates the in-memory registry
 * from the on-disk state file on specific reasons (startup, reload,
 * resume) and filters by parentSessionId.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { appendInteractiveState } from "../src/artifact";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { importFresh } from "./test-utils";
import { makeTmp } from "./subagent-rehydrate-helpers";

describe("session_start rehydrate integration", () => {
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
    const mod = (
      await importFresh<typeof import("../src/subagent")>("../src/subagent")
    ).default;
    mod(api as any);
    let startHandler: ((event: any, ctx: any) => void) | undefined;
    for (const [event, handler] of (api.on as any).mock.calls) {
      if (event === "session_start") startHandler = handler;
    }
    return { api, startHandler };
  }

  it("session_start handler repopulates the registry from the on-disk state file", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      windowName: "demo",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    expect(startHandler).toBeTypeOf("function");
    startHandler!(
      { type: "session_start", reason: "reload" },
      {
        cwd,
      },
    );

    expect(interactiveSubagentRegistry.has("abc12345")).toBe(true);
  });

  it("session_start handler survives a missing state file (empty registry)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { startHandler } = await setupExtension();
    expect(() =>
      startHandler!(
        { type: "session_start", reason: "startup" },
        {
          cwd: "/nonexistent",
        },
      ),
    ).not.toThrow();
    expect(interactiveSubagentRegistry.size).toBe(0);
  });

  it("session_start does NOT rehydrate on startup when session ID doesn't match", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // Entry from a different (old) session
    appendInteractiveState(cwd, {
      id: "from-old-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-old-session"),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "session-old",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "startup" } as any, {
      cwd,
      sessionManager: { getSessionId: () => "session-new" },
    });

    // Registry should be empty - different session, no match
    expect(interactiveSubagentRegistry.size).toBe(0);
  });

  it("session_start DOES rehydrate on startup when session ID matches (--session / -r)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-same-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-same-session"),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "session-mine",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "startup" } as any, {
      cwd,
      sessionManager: { getSessionId: () => "session-mine" },
    });

    // Registry should have the entry - matching session after restart with --session
    expect(interactiveSubagentRegistry.size).toBe(1);
    expect(interactiveSubagentRegistry.has("from-same-session")).toBe(true);
  });

  it("session_start filters by parentSessionId on reload", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // Entry from a DIFFERENT session
    appendInteractiveState(cwd, {
      id: "other-session-agent",
      paneId: "%99",
      mux: "tmux",
      artifactDir: join(cwd, "other-session-agent"),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "session-other",
    });
    // Entry from THIS session
    appendInteractiveState(cwd, {
      id: "this-session-agent",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "this-session-agent"),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "session-current",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "reload" } as any, {
      cwd,
      sessionManager: { getSessionId: () => "session-current" },
    });

    // Only the matching entry should be rehydrated
    expect(interactiveSubagentRegistry.size).toBe(1);
    expect(interactiveSubagentRegistry.has("other-session-agent")).toBe(false);
    expect(interactiveSubagentRegistry.has("this-session-agent")).toBe(true);
  });

  it("session_start does NOT rehydrate on new (explicit new session)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-previous-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-previous-session"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "new" }, { cwd });

    // Registry should be empty - new sessions don't rehydrate old subagents
    expect(interactiveSubagentRegistry.size).toBe(0);
  });

  it("session_start does NOT rehydrate on fork (forked session)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-previous-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-previous-session"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "fork" }, { cwd });

    // Registry should be empty - forked sessions don't rehydrate old subagents
    expect(interactiveSubagentRegistry.size).toBe(0);
  });

  it("session_start DOES rehydrate on resume (resumed session)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-previous-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-previous-session"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "resume" }, { cwd });

    // Registry should have the rehydrated entry - resume preserves subagents
    expect(interactiveSubagentRegistry.size).toBe(1);
    expect(interactiveSubagentRegistry.has("from-previous-session")).toBe(true);
  });

  it("session_start DOES rehydrate on reload (reloaded session)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-previous-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-previous-session"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "reload" }, { cwd });

    // Registry should have the rehydrated entry - reload preserves subagents
    expect(interactiveSubagentRegistry.size).toBe(1);
    expect(interactiveSubagentRegistry.has("from-previous-session")).toBe(true);
  });
});
