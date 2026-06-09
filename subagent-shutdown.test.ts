/**
 * Behavioral tests for the `session_shutdown` handler registered by the
 * subagent extension. The handler added in the criticals-wip commit
 * introduced four new behaviors, none of which had any test:
 *
 *   1. `handle.unref?.()` on the global poller handle
 *   2. `clearInterval` of the poller handle in `session_shutdown`
 *   3. iteration over `interactiveSubagentRegistry`, calling
 *      `cancelInteractiveSubagent` only for `running` states
 *   4. clear of `interactiveSubagentRegistry` (the fix in this branch)
 *
 * These tests stub `setInterval` / `clearInterval` to capture the handle
 * and call args, and `vi.spyOn` the `cancelInteractiveSubagent` export
 * so we can assert which ids were cancelled without touching tmux.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as interactiveTmux from "./interactive-tmux";
import type { InteractiveSubagentState } from "./interactive-tmux";
import { jobRegistry } from "./helpers";
import registerExtension from "./subagent";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeState(
  id: string,
  status: InteractiveSubagentState["status"],
): InteractiveSubagentState {
  return {
    id,
    name: "test-" + id,
    task: "test",
    paneId: "%" + id,
    sessionFile: "/tmp/sess-" + id + ".jsonl",
    cwd: "/tmp",
    startedAt: Date.now(),
    status,
    attachCommand: "tmux attach -t " + id,
    selectPaneCommand: "tmux select-pane -t '%" + id + "'",
    launchScriptFile: "/tmp/launch-" + id + ".sh",
    artifactDir: "/tmp/art-" + id,
  };
}

/** Build a minimal ExtensionAPI mock and find the session_shutdown callback. */
function setupExtension() {
  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };

  registerExtension(api as any);

  // The extension registers two session_shutdown callbacks: a no-op early
  // one and the actual cleanup handler at the end of the default export.
  // We want the LAST one — the one that runs clearInterval, the cancel
  // loop, and the registry clear.
  let shutdownHandler: (() => void) | undefined;
  for (const [event, handler] of (api.on as any).mock.calls) {
    if (event === "session_shutdown") {
      shutdownHandler = handler as () => void;
    }
  }


  return { api, shutdownHandler };
}


// ── Tests ─────────────────────────────────────────────────────────────

describe("session_shutdown handler", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let cancelSpy: ReturnType<typeof vi.spyOn>;
  let fakeHandle: { unref: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    // Reset global poller / registry / ref state so the default export's
    // `if (!g.__piSubagenturaInteractivePollerHandle)` branch is taken
    // (so we observe a fresh setInterval call in the unref test).
    const g = globalThis as any;
    g.__piSubagenturaInteractivePollerHandle = undefined;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
    jobRegistry.clear();

    // Stub the global timers. setInterval returns a fake handle with a
    // vi.fn() unref method; clearInterval is a no-op spy.
    fakeHandle = { unref: vi.fn() };
    setIntervalSpy = (vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(fakeHandle as any)) as any;
    clearIntervalSpy = (vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => {})) as any;

    // Spy on cancelInteractiveSubagent so the handler's iteration logic
    // can be observed without touching the filesystem or running tmux.
    cancelSpy = vi.spyOn(interactiveTmux, "cancelInteractiveSubagent") as any;
    cancelSpy.mockImplementation(((id: string) =>
      interactiveTmux.interactiveSubagentRegistry.get(id)) as any);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    cancelSpy.mockRestore();
    // The shutdown handler nulls the global handle; restore to undefined
    // so the next test starts from a clean slate.
    (globalThis as any).__piSubagenturaInteractivePollerHandle = undefined;
    vi.restoreAllMocks();
  });

  it("unrefs the poller handle on extension registration", () => {
    setupExtension();

    // setInterval is gated on the global handle being undefined, so the
    // default export called our spy and got fakeHandle back. The very
    // next line in subagent.ts is `handle.unref?.()`.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(fakeHandle.unref).toHaveBeenCalledTimes(1);
  });

  it("clearIntervals the poller in session_shutdown", () => {
    // Pre-seed the global handle so the default export's if-guard skips
    // the setInterval call and the handler sees the pre-seeded handle.
    const handle = { unref: vi.fn() };
    (globalThis as any).__piSubagenturaInteractivePollerHandle = handle;

    const { shutdownHandler } = setupExtension();
    expect(shutdownHandler).toBeTypeOf("function");

    shutdownHandler!();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
    // The handler also nulls the global after clearing, so a re-invocation
    // would be a no-op (defensive: no double-clear).
    expect((globalThis as any).__piSubagenturaInteractivePollerHandle).toBeUndefined();
  });

  it("calls cancelInteractiveSubagent for running states but not non-running", () => {
    const running = makeState("run-1", "running");
    const cancelled = makeState("canc-1", "cancelled");
    const exited = makeState("exit-1", "exited");
    interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
    interactiveTmux.interactiveSubagentRegistry.set(cancelled.id, cancelled);
    interactiveTmux.interactiveSubagentRegistry.set(exited.id, exited);

    const { shutdownHandler } = setupExtension();
    shutdownHandler!();

    // The handler iterates values() and filters on status === "running".
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith("run-1");
    expect(cancelSpy).not.toHaveBeenCalledWith("canc-1");
    expect(cancelSpy).not.toHaveBeenCalledWith("exit-1");
  });

  it("clears interactiveSubagentRegistry in session_shutdown", () => {
    // Pre-populate with both running and non-running states. The cancel
    // loop is mocked, so it does NOT remove entries — the explicit
    // `interactiveSubagentRegistry.clear()` is what empties the map.
    const running = makeState("run-1", "running");
    const exited = makeState("exit-1", "exited");
    interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
    interactiveTmux.interactiveSubagentRegistry.set(exited.id, exited);

    const { shutdownHandler } = setupExtension();
    expect(interactiveTmux.interactiveSubagentRegistry.size).toBe(2);

    shutdownHandler!();

    expect(interactiveTmux.interactiveSubagentRegistry.size).toBe(0);
  });
});
