import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InteractiveSupervisorComponent,
  formatSupervisorSummary,
  showInteractiveSupervisor,
} from "../src/interactive-supervisor-ui";
import {
  captureInteractiveSubagent,
  focusInteractiveSubagent,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import { registerInteractiveSupervisor } from "../src/interactive-supervisor-registration";

const tempDirs: string[] = [];
const savedTmux = process.env.TMUX;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "interactive-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

function state(
  id: string,
  overrides: Partial<InteractiveSubagentState> = {},
): InteractiveSubagentState {
  return {
    id,
    name: `agent-${id}`,
    task: `inspect ${id}`,
    paneId: `%${id}`,
    mux: "tmux",
    sessionFile: `/sessions/${id}.jsonl`,
    cwd: "/repo",
    startedAt: Date.now() - 5_000,
    status: "running",
    attachCommand: `tmux attach -t ${id}`,
    selectPaneCommand: `tmux select-pane -t %${id}`,
    launchScriptFile: `/artifacts/${id}/launch.sh`,
    artifactDir: `/artifacts/${id}`,
    ...overrides,
  };
}

afterEach(() => {
  interactiveSubagentRegistry.clear();
  __resetMuxInstances();
  vi.useRealTimers();
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("interactive supervisor", () => {
  it("renders bounded summaries and activity", () => {
    const item = state("abcdef12", {
      name: "reader",
      lastToolSummary: "reading a very long and important source file",
    });
    interactiveSubagentRegistry.set(item.id, item);
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
    });

    const lines = component.render(72);

    expect(lines.some((line) => line.includes("abcdef12"))).toBe(true);
    expect(lines.some((line) => line.includes("reading"))).toBe(true);
    expect(lines.every((line) => line.length <= 72)).toBe(true);
    expect(formatSupervisorSummary(item, Date.now())).toContain("tmux");
  });

  it("navigates, expands, refreshes, and closes without cancelling", () => {
    interactiveSubagentRegistry.set("one", state("one"));
    interactiveSubagentRegistry.set("two", state("two"));
    const done = vi.fn();
    const cancel = vi.fn();
    const requestRender = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done,
      cancel,
      requestRender,
    });

    component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(100).join("\n")).toContain("Task: inspect two");
    component.handleInput("r");
    expect(requestRender).toHaveBeenCalled();
    component.handleInput("q");

    expect(done).toHaveBeenCalledWith({ kind: "close" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("shows bounded lifecycle events and artifact output in details", () => {
    const artifactDir = join(tempDir(), "artifact");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "events.ndjson"),
      [
        JSON.stringify({ type: "turn_started", turnId: "turn-1" }),
        JSON.stringify({ type: "tool_activity", name: "read" }),
        JSON.stringify({ type: "completion", outcome: "done" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(artifactDir, "output.md"),
      "Completed the recursive artifact inspection.\n",
    );
    const item = state("details", {
      artifactDir,
      lifecycle: {
        currentTurnId: "turn-1",
        completionOutcome: "done",
        processStatus: "done",
      },
    });
    interactiveSubagentRegistry.set(item.id, item);
    const component = new InteractiveSupervisorComponent({ done: vi.fn() });

    component.handleInput("\r");
    const rendered = component.render(160).join("\n");

    expect(rendered).toContain(
      "Lifecycle: turn=turn-1 · completion=done · process=done",
    );
    expect(rendered).toContain(
      "Recent events: turn_started → tool_activity(read) → completion(done)",
    );
    expect(rendered).toContain(
      "Output preview: Completed the recursive artifact inspection.",
    );
  });

  it("prefers focus inside tmux while preserving attach elsewhere", () => {
    const renderDetails = (item: InteractiveSubagentState): string => {
      interactiveSubagentRegistry.clear();
      interactiveSubagentRegistry.set(item.id, item);
      const component = new InteractiveSupervisorComponent({ done: vi.fn() });
      component.handleInput("\r");
      return component.render(160).join("\n");
    };

    process.env.TMUX = "/tmp/tmux.sock,1,0";
    const insideTmux = renderDetails(state("inside-tmux"));
    expect(insideTmux).not.toContain("Attach: tmux attach");
    expect(insideTmux).toContain("Focus: tmux select-pane");

    delete process.env.TMUX;
    const outsideTmux = renderDetails(state("outside-tmux"));
    expect(outsideTmux).toContain("Attach: tmux attach");
    expect(outsideTmux).toContain("Focus: tmux select-pane");

    process.env.TMUX = "/tmp/tmux.sock,1,0";
    const zellij = renderDetails(
      state("zellij", {
        mux: "zellij",
        attachCommand: "zellij attach child-session",
        selectPaneCommand: "zellij action focus-pane --pane-id 42",
      }),
    );
    expect(zellij).toContain("Attach: zellij attach child-session");
    expect(zellij).toContain("Focus: zellij action focus-pane");
  });

  it("uses the direct cancellation path only for x", () => {
    interactiveSubagentRegistry.set("one", state("one"));
    const done = vi.fn();
    const cancel = vi
      .fn()
      .mockReturnValue(state("one", { status: "cancelled" }));
    const component = new InteractiveSupervisorComponent({ done, cancel });

    component.handleInput("x");

    expect(cancel).toHaveBeenCalledWith("one");
    expect(done).not.toHaveBeenCalled();
  });

  it("handles the toggle shortcut while focused and disposes its timer", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const requestRender = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done,
      requestRender,
      refreshIntervalMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);
    expect(requestRender).toHaveBeenCalled();
    component.handleInput("\u001b[97;7u");
    expect(done).toHaveBeenCalledWith({ kind: "close" });

    component.dispose();
    requestRender.mockClear();
    vi.advanceTimersByTime(2_000);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("reports a clear fallback outside Pi TUI sessions", async () => {
    const notify = vi.fn();

    await showInteractiveSupervisor({ notify } as never);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("only available in Pi TUI sessions"),
      "info",
    );
  });

  it("routes focus and bounded capture through the creating mux", async () => {
    const focusPane = vi.fn().mockResolvedValue(undefined);
    const capturePane = vi.fn().mockResolvedValue({
      output: "recent output",
      truncated: false,
    });
    __setTmuxMultiplexer({ focusPane, capturePane } as never);
    const item = state("mux-route", {
      paneId: "%42",
      windowName: "agent-window",
      muxSession: "agent-session",
    });

    await focusInteractiveSubagent(item);
    const capture = await captureInteractiveSubagent(item, {
      maxBytes: 1024,
      maxLines: 20,
    });

    const paneRef = {
      paneId: "%42",
      windowName: "agent-window",
      session: "agent-session",
    };
    expect(focusPane).toHaveBeenCalledWith(paneRef);
    expect(capturePane).toHaveBeenCalledWith(paneRef, {
      maxBytes: 1024,
      maxLines: 20,
    });
    expect(capture.output).toBe("recent output");
  });

  it("renders recursive depth, blocks unsafe nodes, and dispatches native view", async () => {
    const root = state("root");
    const child = state("child");
    const notify = vi.fn();
    const cancelSubtree = vi.fn();
    const nativeView = vi.fn().mockResolvedValue(undefined);
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      notify,
      cancelSubtree,
      nativeView,
      items: () => [
        { state: root, depth: 0, actionable: true },
        {
          state: child,
          depth: 1,
          actionable: false,
          reasons: ["stale"],
        },
      ],
    });

    const lines = component.render(120);
    expect(
      lines.some((line) => line.includes("  ○") && line.includes("child")),
    ).toBe(true);
    component.handleInput("j");
    component.handleInput("X");
    expect(cancelSubtree).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "This lineage subtree is not safe to cancel.",
      "warning",
    );

    component.handleInput("k");
    component.handleInput("n");
    await vi.waitFor(() => expect(nativeView).toHaveBeenCalledWith(root));
  });

  it("requires confirmation before the registered subtree action runs", async () => {
    const root = state("root");
    interactiveSubagentRegistry.set(root.id, root);
    let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    registerInteractiveSupervisor({
      registerCommand: (
        _name: string,
        command: { handler: typeof commandHandler },
      ) => {
        commandHandler = command.handler;
      },
      registerShortcut: vi.fn(),
    } as never);
    const confirm = vi.fn().mockResolvedValue(false);
    const custom = vi.fn(async (factory: Function) => {
      const component = factory(
        { requestRender: vi.fn() },
        undefined,
        undefined,
        vi.fn(),
      ) as InteractiveSupervisorComponent;
      component.handleInput("X");
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      return { kind: "close" };
    });
    const ui = { custom, confirm, notify: vi.fn() };

    await commandHandler?.("", { ui });

    expect(confirm).toHaveBeenCalledWith(
      "Cancel interactive subagent subtree?",
      expect.stringContaining("retains artifacts"),
    );
    expect(interactiveSubagentRegistry.has(root.id)).toBe(true);
  });
});
