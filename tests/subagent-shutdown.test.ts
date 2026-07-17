/**
 * Behavioral tests for the `session_shutdown` handler registered by the
 * subagent extension. The handler added in the criticals-wip commit
 * introduced four new behaviors, none of which had any test:
 *
 *   1. `handle.unref?.()` on the global poller handle
 *   2. `clearInterval` of the poller handle in `session_shutdown`
 *   3. preserving live panes on reload/resume/quit and cancelling them otherwise
 *   4. clear of `interactiveSubagentRegistry` (the fix in this branch)
 *
 * These tests stub `setInterval` / `clearInterval` to capture the handle
 * and call args, and `vi.spyOn` the `cancelInteractiveSubagent` export
 * so we can assert which ids were cancelled without touching tmux.
 *
 * The two `AC-A*` tests at the bottom are regression tests for Bug A
 * (duplicate notification on parent session close). They exercise the
 * race between an in-flight poll tick and the shutdown handler by
 * calling `pollArtifactChanges` directly at the boundaries of the
 * shutdown sequence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as interactiveTmux from "../src/interactive-tmux";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { appendEvent, artifactPath } from "../src/artifact";
import { jobRegistry } from "../src/helpers";
import { workflowJobRegistry } from "../src/workflow";
import registerExtension, { pollArtifactChanges } from "../src/subagent";
import { __setTmuxMultiplexer } from "../src/multiplexer";

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
    mux: "tmux",
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
    registerFlag: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };

  registerExtension(api as any);

  // The extension registers two session_shutdown callbacks: a no-op early
  // one and the actual cleanup handler at the end of the default export.
  // We want the LAST one — the one that runs clearInterval, the cancel
  // loop, and the registry clear.
  let shutdownHandler:
    ((event?: { reason?: string }, ctx?: { cwd?: string }) => void) | undefined;
  for (const [event, handler] of (api.on as any).mock.calls) {
    if (event === "session_shutdown") {
      shutdownHandler = handler as (
        event?: { reason?: string },
        ctx?: { cwd?: string },
      ) => void;
    }
  }

  return { api, shutdownHandler };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("session_shutdown handler", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let cancelSpy: ReturnType<typeof vi.spyOn>;
  let cancelByStateSpy: ReturnType<typeof vi.spyOn>;
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
    workflowJobRegistry.clear();
    __setTmuxMultiplexer({
      isPaneAlive: () => true,
      isPaneAliveAsync: async () => true,
    } as any);

    // Stub the global timers. setInterval returns a fake handle with a
    // vi.fn() unref method; clearInterval is a no-op spy.
    fakeHandle = { unref: vi.fn() };
    setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(fakeHandle as any) as any;
    clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => {}) as any;

    // Spy on cancelInteractiveSubagent + cancelInteractiveSubagentByState so the
    // handler's iteration logic can be observed without touching the filesystem
    // or running tmux. The shutdown handler now uses the byState variant
    // (bypasses registry lookup) after snapshotting.
    cancelSpy = vi.spyOn(interactiveTmux, "cancelInteractiveSubagent") as any;
    cancelSpy.mockImplementation(((id: string) =>
      interactiveTmux.interactiveSubagentRegistry.get(id)) as any);
    cancelByStateSpy = vi.spyOn(
      interactiveTmux,
      "cancelInteractiveSubagentByState",
    ) as any;
    cancelByStateSpy.mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    cancelSpy.mockRestore();
    cancelByStateSpy.mockRestore();
    // The shutdown handler nulls the global handle; restore to undefined
    // so the next test starts from a clean slate.
    (globalThis as any).__piSubagenturaInteractivePollerHandle = undefined;
    vi.restoreAllMocks();
  });

  // AC-A* tests create tmp artifact dirs; declared here (before any inner
  // afterEach that references it) per AGENTS.md "declare before" rule.
  let tmpRoot: string;

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
    expect(
      (globalThis as any).__piSubagenturaInteractivePollerHandle,
    ).toBeUndefined();
  });

  it.each(["new", "fork"])(
    "kills running and idle panes for non-preserving reason %s",
    (reason) => {
      const running = makeState("run-1", "running");
      const idle = makeState("idle-1", "idle");

      const cancelled = makeState("canc-1", "cancelled");

      const exited = makeState("exit-1", "exited");

      interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
      interactiveTmux.interactiveSubagentRegistry.set(idle.id, idle);

      interactiveTmux.interactiveSubagentRegistry.set(cancelled.id, cancelled);

      interactiveTmux.interactiveSubagentRegistry.set(exited.id, exited);

      const { shutdownHandler } = setupExtension();

      shutdownHandler!({ reason });

      // The handler snapshots running states, clears the registry, then calls the

      // byState variant (which bypasses the registry lookup). The id-based

      // cancelInteractiveSubagent is NOT used by the shutdown handler anymore.

      expect(cancelByStateSpy).toHaveBeenCalledTimes(2);

      expect(cancelByStateSpy).toHaveBeenCalledWith(running);
      expect(cancelByStateSpy).toHaveBeenCalledWith(idle);

      expect(cancelSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["reload", "resume", "quit"])(
    "preserves running and idle panes for reason %s",
    (reason) => {
      const running = makeState("run-1", "running");
      const idle = makeState("idle-1", "idle");
      interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
      interactiveTmux.interactiveSubagentRegistry.set(idle.id, idle);

      const { shutdownHandler } = setupExtension();
      shutdownHandler!({ reason });

      expect(cancelByStateSpy).not.toHaveBeenCalled();
      expect(cancelSpy).not.toHaveBeenCalled();
    },
  );

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

  it("aborts, suppresses, and clears background workflows on session_shutdown", () => {
    const abort = new AbortController();
    const abortSpy = vi.spyOn(abort, "abort");
    const workflow = {
      id: "wf-shutdown",
      name: "shutdown-test",
      status: "running" as const,
      startedAt: Date.now(),
      promise: new Promise<never>(() => {}),
      abort,
      suppressCompletionNotification: false,
      snapshot: {
        agentsSpawned: 0,
        errorCount: 0,
        tokensSpent: 0,
        phases: [],
      },
    };
    workflowJobRegistry.set(workflow.id, workflow);

    const { shutdownHandler } = setupExtension();
    shutdownHandler!();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(workflow.suppressCompletionNotification).toBe(true);
    expect(workflowJobRegistry.size).toBe(0);
  });

  // ── Bug A regression tests (duplicate notification on shutdown) ──

  // The race: a poll tick dequeued from setInterval before clearInterval

  // runs can observe the in-progress cancel state. The fix (snapshot-then-clear

  // in session_shutdown) means a post-shutdown tick finds an empty registry

  // and delivers zero notifications. We capture the actual setInterval

  // callback (via the setIntervalSpy) and invoke it before AND after the

  // shutdown handler — this exercises the same code path as a real

  // in-flight tick that survived clearInterval.

  function makeArtifactState(
    id: string,
    status: InteractiveSubagentState["status"],
    artifactDir: string,
  ): InteractiveSubagentState {
    return {
      ...makeState(id, status),
      artifactDir,
    };
  }

  it("AC-A1: setInterval tick after session_shutdown delivers zero notifications (race-reproducing)", async () => {
    // Empty tmp artifact dir; no events written.

    tmpRoot = mkdtempSync(join(tmpdir(), "pi-shutdown-a1-"));

    const artifactDir = join(tmpRoot, "run-1");

    const running = makeArtifactState("run-1", "running", artifactDir);

    interactiveTmux.interactiveSubagentRegistry.set(running.id, running);

    const { api, shutdownHandler } = setupExtension();

    (globalThis as any).__piSubagenturaPiRef = api;
    const notify = vi.fn();
    (globalThis as any).__piSubagenturaUi = {
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };

    // Capture the actual setInterval callback. setupExtension() above

    // registered the poller, so setIntervalSpy.mock.calls[0][0] is the

    // production callback (`() => pollArtifactChanges(pi)`) we need to

    // invoke to exercise the real code path — not a hand-written wrapper.

    const tick = setIntervalSpy.mock.calls[0][0] as () => void;

    // 1. Pre-shutdown tick: no artifact events, no notification.

    tick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(api.sendMessage).toHaveBeenCalledTimes(0);

    // 2. Shutdown handler runs. The order of operations inside

    // session_shutdown is what we're protecting: snapshot → clear → cancel.

    // If someone re-orders to cancel → clear, the post-shutdown tick below

    // would still see an empty registry (clear runs last), so this test

    // alone would pass. The cancellation must use the byState export

    // (covered by the test at line ~166) for the shutdown handler to

    // actually kill panes after clear.

    shutdownHandler!();

    // 3. Post-shutdown tick (the in-flight one that survived clearInterval):

    //    must deliver zero notifications because the registry is empty.

    tick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(api.sendMessage).toHaveBeenCalledTimes(0);
  });

  it("AC-A2: setInterval tick after shutdown does not re-deliver a done event already in the artifact", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-shutdown-a2-"));

    const artifactDir = join(tmpRoot, "run-1");

    const running = makeArtifactState("run-1", "running", artifactDir);

    // Pre-write a done event with a fixed ts.

    const doneTs = 1000;

    const art = artifactPath(join(artifactDir, ".."), "run-1");

    appendEvent(art, { ts: doneTs, type: "done", status: "done", exitCode: 0 });

    interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
    __setTmuxMultiplexer({
      isPaneAlive: () => true,
      isPaneAliveAsync: async () => true,
    } as any);

    const { api, shutdownHandler } = setupExtension();

    (globalThis as any).__piSubagenturaPiRef = api;
    const notify = vi.fn();
    (globalThis as any).__piSubagenturaUi = {
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };

    // Capture the actual setInterval callback for the real code path.

    const tick = setIntervalSpy.mock.calls[0][0] as () => void;

    // 1. Pre-shutdown tick: the done event (cursor=0, ts=1000) is

    // delivered. Exactly one notification.

    await new Promise<void>((resolve) => setImmediate(resolve));
    await pollArtifactChanges(api as any);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledOnce();

    // 2. Shutdown handler runs.

    shutdownHandler!();

    // 3. Post-shutdown tick (in-flight race survivor): the registry is

    // empty (snapshot-before-clear), so the tick does no work. Total

    // notification count stays at 1 — no duplicate delivered.

    tick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledOnce();
    __setTmuxMultiplexer(undefined);
  });

  afterEach(() => {
    // Clean up tmp artifact dirs created by the AC-A* tests.
    if (tmpRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
});
