import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InteractiveSupervisorComponent,
  formatSupervisorSummary,
  showInteractiveSupervisor,
} from "../src/interactive-supervisor-ui";
import {
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";

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
  vi.useRealTimers();
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
});
