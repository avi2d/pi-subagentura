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
import {
  buildAsyncSupervisorItems,
  directSupervisorItems,
  registerInteractiveSupervisor,
} from "../src/interactive-supervisor-registration";
import { jobRegistry, type JobState } from "../src/helpers";
import {
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";

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

function inProcessJob(id: string, overrides: Partial<JobState> = {}): JobState {
  return {
    id,
    status: "running",
    liveStatus: {
      turn: 1,
      output: `partial output from ${id}`,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
      },
    },
    session: { abort: vi.fn() } as never,
    startedAt: Date.now() - 4_000,
    cwd: "/repo",
    promise: Promise.resolve({}) as never,
    ...overrides,
  };
}

function workflowJob(
  id: string,
  overrides: Partial<WorkflowJobState> = {},
): WorkflowJobState {
  return {
    id,
    name: `workflow-${id}`,
    status: "running",
    startedAt: Date.now() - 3_000,
    promise: Promise.resolve({}) as never,
    abort: new AbortController(),
    snapshot: {
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 5,
      phases: ["Review"],
      currentPhase: "Review",
      runningCount: 1,
      agentRecords: [{ agentId: 1, label: "reviewer", status: "running" }],
      agentRecordsOmitted: 0,
    },
    ...overrides,
  };
}

afterEach(() => {
  interactiveSubagentRegistry.clear();
  jobRegistry.clear();
  workflowJobRegistry.clear();
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

  it("renders in-process, workflow, and interactive async work", () => {
    const processJob = inProcessJob("job-123");
    const workflow = workflowJob("wf-123");
    const interactive = state("interactive-123");
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        {
          kind: "in-process",
          job: processJob,
          depth: 0,
          actionable: true,
        },
        { kind: "workflow", job: workflow, depth: 0, actionable: true },
        {
          kind: "interactive",
          state: interactive,
          depth: 0,
          actionable: true,
        },
      ],
    });

    const summaries = component.render(180).join("\n");
    expect(summaries).toContain("Async Subagents");
    expect(summaries).toContain("[in-process] → running job-123");
    expect(summaries).toContain("[workflow] → running workflow-wf-123");
    expect(summaries).toContain(
      "[interactive] → running agent-interactive-123",
    );

    component.handleInput("\r");
    expect(component.render(180).join("\n")).toContain(
      "Output preview: partial output from job-123",
    );
    component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(180).join("\n")).toContain(
      "Agent: → running reviewer #1",
    );
  });

  it("reports omitted workflow agent records", () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      agentId: index + 1,
      label: "worker",
      status: "done" as const,
    }));
    const workflow = workflowJob("wf-omitted", {
      snapshot: {
        ...workflowJob("snapshot").snapshot,
        agentsSpawned: 27,
        agentRecords: records,
        agentRecordsOmitted: 2,
      },
    });
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        { kind: "workflow", job: workflow, depth: 0, actionable: true },
      ],
    });

    component.handleInput("\r");

    expect(component.render(180).join("\n")).toContain(
      "… 7 older agent records omitted",
    );
  });

  it("keeps selection on the same async item across refresh reordering", () => {
    const first = state("first");
    const selected = state("selected");
    const inserted = state("inserted");
    const cancel = vi.fn().mockReturnValue(selected);
    let items = [first, selected].map((interactive) => ({
      kind: "interactive" as const,
      state: interactive,
      depth: 0,
      actionable: true,
    }));
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      cancel,
      items: () => items,
    });
    component.render(120);
    component.handleInput("j");
    items = [inserted, first, selected].map((interactive) => ({
      kind: "interactive" as const,
      state: interactive,
      depth: 0,
      actionable: true,
    }));

    component.invalidate();
    component.render(120);
    component.handleInput("x");

    expect(cancel).toHaveBeenCalledWith(selected.id);
  });

  it("dispatches cancellation according to async work type", () => {
    const processJob = inProcessJob("job-cancel");
    const workflow = workflowJob("wf-cancel");
    const interactive = state("interactive-cancel");
    const cancelInProcess = vi.fn().mockReturnValue(true);
    const cancelWorkflow = vi.fn().mockReturnValue(true);
    const cancel = vi
      .fn()
      .mockReturnValue(state("interactive-cancel", { status: "cancelled" }));
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      cancel,
      cancelInProcess,
      cancelWorkflow,
      items: () => [
        {
          kind: "in-process",
          job: processJob,
          depth: 0,
          actionable: true,
        },
        { kind: "workflow", job: workflow, depth: 0, actionable: true },
        {
          kind: "interactive",
          state: interactive,
          depth: 0,
          actionable: true,
        },
      ],
    });

    component.handleInput("x");
    component.handleInput("j");
    component.handleInput("x");
    component.handleInput("j");
    component.handleInput("x");

    expect(cancelInProcess).toHaveBeenCalledWith(processJob);
    expect(cancelWorkflow).toHaveBeenCalledWith(workflow);
    expect(cancel).toHaveBeenCalledWith(interactive.id);
  });

  it("builds owner-scoped unified supervisor items", () => {
    const owner = { id: 7, generation: 2 };
    const processJob = inProcessJob("owned-job", {
      deliveryOwner: {
        pi: {} as never,
        sessionContextId: owner.id,
        sessionContextGeneration: owner.generation,
      },
    });
    const otherProcessJob = inProcessJob("other-job", {
      deliveryOwner: {
        pi: {} as never,
        sessionContextId: 99,
        sessionContextGeneration: 1,
      },
    });
    const workflow = workflowJob("owned-workflow", {
      parentSessionOwner: owner,
    });
    const otherWorkflow = workflowJob("other-workflow", {
      parentSessionOwner: { id: 99, generation: 1 },
    });
    jobRegistry.set(processJob.id, processJob);
    jobRegistry.set(otherProcessJob.id, otherProcessJob);
    workflowJobRegistry.set(workflow.id, workflow);
    workflowJobRegistry.set(otherWorkflow.id, otherWorkflow);
    const interactive = state("owned-interactive", {
      parentSessionId: "owned-parent-session",
    });
    const otherInteractive = state("other-interactive", {
      parentSessionId: "other-parent-session",
    });
    interactiveSubagentRegistry.set(interactive.id, interactive);
    interactiveSubagentRegistry.set(otherInteractive.id, otherInteractive);

    const items = buildAsyncSupervisorItems(
      directSupervisorItems("owned-parent-session"),
      owner,
    );

    expect(items.map((item) => item.kind)).toEqual([
      "in-process",
      "workflow",
      "interactive",
    ]);
    expect(
      items.some(
        (item) => item.kind === "in-process" && item.job.id === "other-job",
      ),
    ).toBe(false);
    expect(
      items.some(
        (item) => item.kind === "workflow" && item.job.id === "other-workflow",
      ),
    ).toBe(false);
    expect(
      items.some(
        (item) =>
          item.kind === "interactive" && item.state.id === "other-interactive",
      ),
    ).toBe(false);
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

  it("cancels registered in-process jobs and workflows from the overlay", async () => {
    const processAbort = new AbortController();
    const processJob = inProcessJob("registered-job", { abort: processAbort });
    const workflow = workflowJob("registered-workflow");
    const workflowAbort = vi.spyOn(workflow.abort, "abort");
    jobRegistry.set(processJob.id, processJob);
    workflowJobRegistry.set(workflow.id, workflow);
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
    const custom = vi.fn(async (factory: Function) => {
      const component = factory(
        { requestRender: vi.fn() },
        undefined,
        undefined,
        vi.fn(),
      ) as InteractiveSupervisorComponent;
      component.handleInput("x");
      component.handleInput("j");
      component.handleInput("x");
      return { kind: "close" };
    });
    const ui = {
      custom,
      confirm: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
    };

    await commandHandler?.("", { ui });

    expect(processAbort.signal.aborted).toBe(true);
    expect(processJob.status).toBe("cancelled");
    expect(workflowAbort).toHaveBeenCalledOnce();
    expect(workflow.status).toBe("cancelled");
    expect(workflow.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
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
