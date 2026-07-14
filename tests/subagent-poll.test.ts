/**
 * The artifact-driven poller fires pointer notifications for new events on
 * interactive sub-agents. Tests reset the global pi ref + registry, then write
 * events directly to the artifact dir to drive the poller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  appendCompletionEvent,
  appendInteractiveState,
  artifactPath,
  eventLogEndOffset,
  loadInteractiveStates,
  readEventRecords,
  writeOutput,
} from "../src/artifact";
import { importFresh } from "./test-utils";
function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-poll-"));
}

function makeState(): {
  id: string;
  artifactDir: string;
  state: import("../src/interactive-tmux").InteractiveSubagentState;
} {
  const id = "id-" + Math.random().toString(36).slice(2, 8);
  const artifactDir = join(makeTmp(), id);
  const state: import("../src/interactive-tmux").InteractiveSubagentState = {
    id,
    name: "Test",
    task: "t",
    paneId: "%99",
    sessionFile: "/tmp/sess.jsonl",
    cwd: "/tmp",
    startedAt: Date.now(),
    mux: "tmux",
    status: "running",
    attachCommand: "tmux attach -t sess",
    selectPaneCommand: "tmux select-pane -t '%99'",
    launchScriptFile: "/tmp/launch.sh",
    artifactDir,
  };
  return { id, artifactDir, state };
}

function installDeliverySpies() {
  const sendMessage = vi.fn();
  (globalThis as any).__piSubagenturaUi = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  };
  return sendMessage;
}

describe("pollArtifactChanges", () => {
  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    g.__piSubagenturaParentStreaming = false;
  });

  afterEach(() => {
    (globalThis as any).__piSubagenturaParentStreaming = false;
    vi.doUnmock("node:child_process");
  });

  it("does nothing when registry is empty", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("acknowledges parent cancellation before killing the pane without injecting it", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const interactive = await import("../src/interactive-tmux");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    state.notifyOnComplete = "inject";
    state.triggerTurnOnComplete = true;
    state.cwd = join(artifactDir, "..");
    state.parentSessionId = "pi";
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "active-turn.json"),
      JSON.stringify({ turnId: "cancel-turn", startedAt: Date.now() }),
    );
    let completionsAtKill = 0;
    let persistedIntentsAtKill = 0;
    let persistedReceiptsAtKill = 0;
    appendInteractiveState(state.cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
      parentSessionId: "pi",
    });
    multiplexer.__setTmuxMultiplexer({
      isPaneAlive: () => true,
      killPane: () => {
        completionsAtKill = readFileSync(
          join(artifactDir, "events.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(
            (event) =>
              event.type === "completion" &&
              event.outcome === "cancelled" &&
              event.turnId === "cancel-turn",
          ).length;
        const persisted = loadInteractiveStates(state.cwd)?.states[state.id];
        persistedIntentsAtKill = persisted?.pendingDeliveries.length ?? 0;
        persistedReceiptsAtKill = persisted?.deliveryReceipts.length ?? 0;
      },
    } as any);
    interactive.interactiveSubagentRegistry.set(state.id, state);
    (globalThis as any).__piSubagenturaParentStreaming = true;

    interactive.cancelInteractiveSubagent(state.id);
    expect(completionsAtKill).toBe(1);
    expect(persistedIntentsAtKill).toBe(0);
    expect(persistedReceiptsAtKill).toBe(1);

    (globalThis as any).__piSubagenturaParentStreaming = false;
    const sendMessage = vi.fn();
    mod.pollArtifactChanges({ sendMessage } as any);
    mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.pendingDeliveries).toEqual([]);
    expect(state.deliveryReceipts).toHaveLength(1);
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("creates a distinct process cancellation after the active turn completed", async () => {
    const interactive = await import("../src/interactive-tmux");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "active-turn.json"),
      JSON.stringify({ turnId: "completed-turn", startedAt: Date.now() }),
    );
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendCompletionEvent(art, {
      turnId: "completed-turn",
      outcome: "done",
      source: "explicit",
    });
    multiplexer.__setTmuxMultiplexer({
      isPaneAlive: () => true,
      killPane: vi.fn(),
    } as any);
    interactive.interactiveSubagentRegistry.set(state.id, state);

    interactive.cancelInteractiveSubagent(state.id);

    const completions = readFileSync(art.statusFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "completion");
    expect(completions).toHaveLength(2);
    expect(completions[1]).toMatchObject({
      outcome: "cancelled",
      source: "parent",
    });
    expect(completions[1].turnId).toMatch(/^process-cancel-/);
    expect(state.pendingDeliveries).toEqual([]);
    expect(state.deliveryReceipts).toHaveLength(1);
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("fires a pointer notification on done. Started is silent.", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);

    // Only done fires. started is silent (widget shows it).
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0][0];
    expect(call.customType).toBe("subagent-notify");
    expect(call.content).toContain("done");
    // Pointer format: paths, not a tool-call hint.
    expect(call.content).toContain("Output:");
    expect(call.content).toContain("Activity log:");
    expect(call.content).not.toContain("read_subagent_artifact");
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });

  it("does NOT fire on tool_activity/started", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, {
      ts: 2,
      type: "tool_activity",
      status: "running",
      tool: "bash",
      summary: "rg TODO src/",
    });

    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);

    // Both are silent (started → TUI widget row; tool_activity → TUI widget only).
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });

  it("delivers unacknowledged error and cancellation events normally", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, {
      ts: 2,
      type: "error",
      status: "error",
      message: "boom",
    });
    appendEvent(art, { ts: 3, type: "cancelled", status: "cancelled" });

    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain("error");
    expect(sendMessage.mock.calls[0][0].content).toContain("cancelled");
  });

  it("is at-most-once per event (cursor advances)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);
    // Only done fires (started is silent).
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Second poll: no new events, no new notifications.
    sendMessage.mockClear();
    mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delivers only events after eventByteCursor (backlog catch-up)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    // Simulate a sub-agent that finished while the parent was down — events
    // were already on disk before this poller started.
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    appendEvent(art, { ts: 3, type: "cancelled", status: "cancelled" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    state.eventByteCursor = readEventRecords(art)[0].endOffset;

    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);

    // Should deliver done + cancelled, not started.
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
    expect(sendMessage.mock.calls[0][0].content).toContain("cancelled");
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });

  it("marks the sub-agent as idle when a done event is seen and the pane is still alive (follow-up support)", async () => {
    // The child is between turns, REPL is open, ready for the next prompt.
    // Force the pane to look alive by mocking tmux display-message to succeed.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("idle");
    // exitCode is NOT set on idle — child is still around.
    expect(state.exitCode).toBeUndefined();
  });

  it("marks the sub-agent as exited when a done event is seen but the pane is gone", async () => {
    // Default tmux mock: display-message throws → isTmuxPaneAlive → false → exited.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("can't find pane: %99");
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("exited");
    expect(state.exitCode).toBe(0);
  });

  it("marks the sub-agent as cancelled when a cancelled event is seen", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });

    mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("cancelled");
  });

  it("delivers durable completion backlog even when state is already cancelled", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    state.status = "cancelled";
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });

    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("retries an unknown pane and notifies when done arrives later", async () => {
    vi.resetModules();
    let paneProbeCount = 0;
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") {
          paneProbeCount++;
          if (paneProbeCount === 1) {
            throw new Error("pane not ready yet");
          }
          return Buffer.from("#99");
        }
        return "";
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });

    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);
    expect(state.status).toBe("unknown");

    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    mod.pollArtifactChanges({ sendMessage } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
  });

  it("keeps processing 'idle' sub-agents — the follow-up case", async () => {
    // After the child finishes a turn, status becomes 'idle'. The poll loop must keep running for
    // it so a second `done` event (from a follow-up turn) re-fires the pointer notification.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    state.status = "idle"; // simulate "already between turns"
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    state.eventByteCursor = eventLogEndOffset(art);
    appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 }); // follow-up turn

    const sendMessage = installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage } as any);

    // The new done event (ts=3) is delivered as a pointer notification.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });

  // Inject-mode tests: when a sub-agent is spawned with notifyOnComplete:
  // "inject" and finishes with a completion, the broker sends one attributed
  // custom message. Legacy events remain pointer-only.
  describe("inject mode for interactive sub-agents", () => {
    beforeEach(() => {
      (globalThis as any).__piSubagenturaInjectCount = 0;
    });

    it("sends one pointer-only custom message for a legacy inject completion", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "the sub-agent's final answer");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][0].content).not.toContain(
        "the sub-agent's final answer",
      );
      expect(sendMessage.mock.calls[0][0].content).toContain("Output:");
      expect(sendMessage.mock.calls[0][1]).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(state.pendingDeliveries?.[0]?.state).toBe("dispatchAttempted");
    });

    it("uses attributed sendMessage when state.notifyOnComplete is unset (default: inject)", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "should not be injected");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      // Legacy completions are pointer-only even when the delivery mode is inject.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(state.lastInjectedEventTs).toBeUndefined();
    });

    it("does NOT call sendUserMessage when state.notifyOnComplete === 'notify' (explicit)", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "notify";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "should not be injected");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("adds triggerTurn to notify-mode pointer notifications when requested", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "notify";
      state.triggerTurnOnComplete = true;
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("triggers the single inject envelope when triggerTurnOnComplete is set", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      state.triggerTurnOnComplete = true;
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "final answer");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toEqual({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("does trigger the pointer notification for inject-mode errors when requested", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      state.triggerTurnOnComplete = true;
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, {
        ts: 2,
        type: "error",
        status: "error",
        message: "boom",
      });

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("is at-most-once: a second poll does not redispatch the delivery intent", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "the answer");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();

      // Second poll: no new events (cursor advanced), inject is gated by state.injected.
      sendMessage.mockClear();
      sendUserMessage.mockClear();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("dispatches pointer-only envelopes for legacy follow-up completions", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      // Turn 1: child finishes, writes output v1, calls done.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][0].content).not.toContain("answer v1");
      expect(sendMessage.mock.calls[0][0].content).toContain("Output:");
      expect(sendUserMessage).not.toHaveBeenCalled();

      // Turn 2: parent sent a follow-up, child processed it, wrote output v2, called done again.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2");

      sendMessage.mockClear();
      sendUserMessage.mockClear();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][0].content).not.toContain("answer v2");
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("does not call sendUserMessage when output.md is missing", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      // Intentionally NOT writing output.md

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].content).toContain(
        "(no immutable output available)",
      );
    });

    it("does not snapshot mutable output.md for legacy completions", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      // Turn 1.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      // Turn 2.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      const v1Path = join(art.dir, "output-1.md");
      const v2Path = join(art.dir, "output-2.md");
      expect(existsSync(v1Path)).toBe(false);
      expect(existsSync(v2Path)).toBe(false);
    });

    it("does not snapshot legacy output when notifyOnComplete is unset", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      // notifyOnComplete left undefined.
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(existsSync(join(art.dir, "output-1.md"))).toBe(false);
    });

    it("never creates legacy snapshots while mutable output changes", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      // notifyOnComplete left undefined (default inject).
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      // Turn 1 completes with mutable legacy output.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);
      expect(existsSync(join(art.dir, "output-1.md"))).toBe(false);

      // Follow-up turn: the child overwrites output.md but its done event has NOT landed yet
      // (last event is still the turn-1 done@ts2). A poll lands in this window.
      writeOutput(art, "answer v2 in progress");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(existsSync(join(art.dir, "output-1.md"))).toBe(false);

      // A second legacy completion remains pointer-only.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2 final");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);
      expect(existsSync(join(art.dir, "output-1.md"))).toBe(false);
      expect(existsSync(join(art.dir, "output-2.md"))).toBe(false);
    });
  });

  // ── Bug B regression tests (stale footer/widget for closed sub-agents) ──
  // When a sub-agent is "exited" (terminal, pane dead) the for-loop at line
  // ~518 of subagent.ts must still tail-read the session log (for user-role
  // revival), but it must NOT contribute to the `runningCount` footer or
  // the `widgetRows` list. `idle` sub-agents (between turns, REPL open) are
  // still live and DO contribute to the running count.
  describe("footer/widget (Bug B)", () => {
    it("AC-B1: counts running + idle as 'running'; excludes exited from both footer and widget", async () => {
      // Mock display-message to branch on paneId:
      //   running-pane and idle-pane → alive (return success)
      //   exited-pane              → dead (throw)
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") {
            const paneId = args[3];
            if (paneId === "%exited-pane") throw new Error("pane dead");
            return Buffer.from("#99");
          }
          return "";
        },
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");

      // Running sub-agent: no events in artifact; pane alive.
      const running = makeState().state;
      running.id = "running-1";
      running.paneId = "%running-pane";
      mod.interactiveSubagentRegistry.set(running.id, running);

      // Idle sub-agent: done event, pane alive. artifactDir must be set so the
      // poller reads from the same dir where we write the events.
      const idle = makeState().state;
      idle.id = "idle-1";
      idle.paneId = "%idle-pane";
      idle.lastDeliveredEventTs = 2;
      idle.artifactDir = join(idle.artifactDir, "..", idle.id);
      mod.interactiveSubagentRegistry.set(idle.id, idle);
      const idleArt = artifactPath(join(idle.artifactDir, ".."), idle.id);
      appendEvent(idleArt, { ts: 1, type: "started", status: "running" });
      appendEvent(idleArt, {
        ts: 2,
        type: "done",
        status: "done",
        exitCode: 0,
      });

      // Exited sub-agent: done event, pane dead.
      const exited = makeState().state;
      exited.id = "exited-1";
      exited.paneId = "%exited-pane";
      exited.lastDeliveredEventTs = 2;
      exited.artifactDir = join(exited.artifactDir, "..", exited.id);
      mod.interactiveSubagentRegistry.set(exited.id, exited);
      const exitedArt = artifactPath(join(exited.artifactDir, ".."), exited.id);
      appendEvent(exitedArt, { ts: 1, type: "started", status: "running" });
      appendEvent(exitedArt, {
        ts: 2,
        type: "done",
        status: "done",
        exitCode: 0,
      });

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 2 sub-agents running",
      );
      expect(setWidget).toHaveBeenCalledWith(
        "subagentura-activity",
        expect.any(Array),
        { placement: "belowEditor" },
      );
      const widgetArgs = setWidget.mock.calls[0];
      expect(widgetArgs[1].length).toBe(2);

      expect(exited.status).toBe("exited");
      expect(idle.status).toBe("idle");
      expect(running.status).toBe("running");

      delete (globalThis as any).__piSubagenturaUi;
    });

    it("AC-B2: clears footer and widget when all sub-agents are exited", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "-lc") return Buffer.from("");
          throw new Error("pane dead");
        },
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");

      const exited1 = makeState().state;
      exited1.id = "exited-1";
      exited1.lastDeliveredEventTs = 2;
      exited1.artifactDir = join(exited1.artifactDir, "..", exited1.id);
      mod.interactiveSubagentRegistry.set(exited1.id, exited1);
      const exited1Art = artifactPath(
        join(exited1.artifactDir, ".."),
        exited1.id,
      );
      appendEvent(exited1Art, { ts: 1, type: "started", status: "running" });
      appendEvent(exited1Art, {
        ts: 2,
        type: "done",
        status: "done",
        exitCode: 0,
      });

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith("subagentura-running", undefined);
      expect(setWidget).toHaveBeenCalledWith(
        "subagentura-activity",
        undefined,
        { placement: "belowEditor" },
      );

      expect(exited1.status).toBe("exited");

      delete (globalThis as any).__piSubagenturaUi;
    });

    it("AC-B3: all-running registry shows correct count (regression guard)", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");

      const a = makeState().state;
      a.id = "a";
      mod.interactiveSubagentRegistry.set(a.id, a);
      const b = makeState().state;
      b.id = "b";
      mod.interactiveSubagentRegistry.set(b.id, b);

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 2 sub-agents running",
      );
      const widgetArgs = setWidget.mock.calls[0];
      expect(widgetArgs[1].length).toBe(2);

      delete (globalThis as any).__piSubagenturaUi;
    });
  });
});

describe("pollArtifactChanges — terminal cleanup of state.json", () => {
  const SESSION = "019e500a-bae9-783a-869a-ac7c106b4ab7";

  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaSessionManager = undefined;
  });

  function makePersistedState(): {
    id: string;
    cwd: string;
    state: import("../src/interactive-tmux").InteractiveSubagentState;
  } {
    const cwd = makeTmp();
    const id = "id-" + Math.random().toString(36).slice(2, 8);
    const state: import("../src/interactive-tmux").InteractiveSubagentState = {
      id,
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: "/tmp/sess.jsonl",
      cwd,
      startedAt: Date.now(),
      mux: "tmux",
      status: "running",
      attachCommand: "tmux attach -t sess",
      selectPaneCommand: "tmux select-pane -t '%99'",
      launchScriptFile: "/tmp/launch.sh",
      artifactDir: join(cwd, id),
      parentSessionId: "pi",
    };
    appendInteractiveState(cwd, {
      id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });
    return { id, cwd, state };
  }

  it("keeps terminal state until the custom-message receipt is visible", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("can't find pane: %99");
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(loaded?.states[id].pendingDeliveries).toEqual([
      expect.objectContaining({ state: "dispatchAttempted" }),
    ]);
  });

  it("reconciles same-session inject receipt before terminal cleanup", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("can't find pane: %99");
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    state.notifyOnComplete = "inject";
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });
    const entries: unknown[] = [];
    (globalThis as any).__piSubagenturaSessionManager = {
      getEntries: () => entries,
    };
    mod.pollArtifactChanges({
      sendMessage: vi.fn((message) => {
        entries.push({ type: "custom_message", details: message.details });
      }),
    } as any);

    expect(state.pendingDeliveries).toEqual([]);
    expect(loadInteractiveStates(cwd)?.states[id]).toBeUndefined();
  });

  it("keeps the state.json entry after delivering a done event when the pane is alive", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(state.status).toBe("idle");
  });

  it("keeps a live pane idle after a v2 error completion", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      version: 2,
      eventId: "error-completion",
      turnId: "turn-error",
      ts: 1,
      type: "completion",
      status: "error",
      outcome: "error",
      source: "agent_end",
      errorMessage: "provider failed",
    });

    installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(state.status).toBe("idle");
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();
  });

  it("removes state after process_exited even if pane liveness reports true", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      version: 2,
      eventId: "process-exit",
      turnId: "turn-error",
      ts: 1,
      type: "process_exited",
      status: "error",
      exitCode: 1,
    });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(state.status).toBe("exited");
    expect(loadInteractiveStates(cwd)?.states[id]).toBeUndefined();
  });

  it("keeps error state until the custom-message receipt is visible", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      ts: 1,
      type: "error",
      status: "error",
      message: "boom",
    });

    installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(loaded?.states[id].pendingDeliveries).toEqual([
      expect.objectContaining({ state: "dispatchAttempted", status: "error" }),
    ]);
  });

  it("keeps cancelled state until the custom-message receipt is visible", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });

    installDeliverySpies();
    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(loaded?.states[id].pendingDeliveries).toEqual([
      expect.objectContaining({
        state: "dispatchAttempted",
        status: "cancelled",
      }),
    ]);
  });

  it("keeps the state.json entry and cursor when notification delivery fails", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      ts: 1,
      type: "error",
      status: "error",
      message: "boom",
    });

    (globalThis as any).__piSubagenturaUi = {
      notify: vi.fn(() => {
        throw new Error("stale pi");
      }),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(state.eventByteCursor).toBeGreaterThan(0);
    expect(state.pendingDeliveries).toHaveLength(1);
  });

  it("does NOT remove the state.json entry on tool_activity events (only terminals)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      ts: 1,
      type: "tool_activity",
      status: "running",
      tool: "bash",
      summary: "ls",
    });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
  });

  it("does NOT throw if state has no parentSessionId (no-op guard)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "id-" + Math.random().toString(36).slice(2, 8);
    const state: import("../src/interactive-tmux").InteractiveSubagentState = {
      id,
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: "/tmp/sess.jsonl",
      cwd: "/tmp",
      startedAt: Date.now(),
      mux: "tmux",
      status: "running",
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: "/tmp/launch.sh",
      artifactDir: "/tmp/art-" + id,
    };
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath("/tmp", id);
    appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });

    expect(() =>
      mod.pollArtifactChanges({ sendMessage: vi.fn() } as any),
    ).not.toThrow();
  });

  it("advances eventByteCursor before removing the state entry", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });
});
