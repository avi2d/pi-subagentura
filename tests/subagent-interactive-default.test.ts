/**
 * Focused tool-lifecycle coverage for interactive notification defaults and
 * prompt running-footer refreshes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCancelInteractiveSubagent,
  mockLaunchInteractiveSubagent,
  mockPruneDeadInteractiveSubagents,
} = vi.hoisted(() => ({
  mockCancelInteractiveSubagent: vi.fn(),
  mockLaunchInteractiveSubagent: vi.fn(),
  mockPruneDeadInteractiveSubagents: vi.fn(),
}));

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    launchInteractiveSubagent: mockLaunchInteractiveSubagent,
    cancelInteractiveSubagent: mockCancelInteractiveSubagent,
    pruneDeadInteractiveSubagents: mockPruneDeadInteractiveSubagents,
  };
});

import registerExtension from "../src/subagent";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";

/** Minimal ctx for the tool's execute signature. */
function mockCtx() {
  return {
    cwd: "/tmp",
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("test-session-id"),
    },
  };
}

/** Find the subagent_interactive tool def from the registered API. */
function getInteractiveToolDef(api: {
  registerTool: ReturnType<typeof vi.fn>;
}) {
  return api.registerTool.mock.calls.find(
    ([t]: any[]) => t.name === "subagent_interactive",
  )?.[0];
}

function getCancelToolDef(api: { registerTool: ReturnType<typeof vi.fn> }) {
  return api.registerTool.mock.calls.find(
    ([tool]: any[]) => tool.name === "cancel_interactive_subagent",
  )?.[0];
}

function getStatusToolDef(api: { registerTool: ReturnType<typeof vi.fn> }) {
  return api.registerTool.mock.calls.find(
    ([tool]: any[]) => tool.name === "get_interactive_subagent_status",
  )?.[0];
}

function mockInteractiveState(status = "running") {
  return {
    id: "abc12345",
    name: "Test",
    task: "t",
    paneId: "%99",
    sessionFile: "/tmp/sess.jsonl",
    cwd: "/tmp",
    startedAt: Date.now(),
    status,
    mux: "tmux",
    attachCommand: "tmux attach -t s",
    selectPaneCommand: "tmux select-pane -t '%99'",
    launchScriptFile: "/tmp/launch.sh",
    artifactDir: "/tmp/artifacts/abc12345",
  };
}

describe("subagent_interactive tool lifecycle", () => {
  let api: ReturnType<typeof setupExtension>;

  function setupExtension() {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(_api as any);
    return _api;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    interactiveSubagentRegistry.clear();
    api = setupExtension() as any;
    mockLaunchInteractiveSubagent.mockReset();
    mockCancelInteractiveSubagent.mockReset();
    mockPruneDeadInteractiveSubagents.mockReset();
    mockCancelInteractiveSubagent.mockReturnValue(
      mockInteractiveState("cancelled"),
    );
    mockLaunchInteractiveSubagent.mockReturnValue(mockInteractiveState());
  });

  afterEach(() => {
    interactiveSubagentRegistry.clear();
    vi.clearAllMocks();
  });

  it("defaults to notify + automatic triggering when both params are omitted", async () => {
    const toolDef = getInteractiveToolDef(api);
    expect(toolDef).toBeDefined();

    const result = await toolDef.execute(
      "call-1",
      { task: "research X" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    const callArgs = mockLaunchInteractiveSubagent.mock.calls[0][0];
    expect(callArgs.notifyOnComplete).toBe("notify");
    expect(callArgs.triggerTurnOnComplete).toBe(true);
    expect(result.content[0].text).toContain(
      "Completion output will not be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "A new parent turn will start automatically after the pointer delivery",
    );
  });

  it("defaults explicit notify mode to automatic triggering", async () => {
    const toolDef = getInteractiveToolDef(api);

    const result = await toolDef.execute(
      "call-2",
      { task: "research X", notifyOnComplete: "notify" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].notifyOnComplete,
    ).toBe("notify");
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].triggerTurnOnComplete,
    ).toBe(true);
    expect(result.content[0].text).toContain(
      "Completion output will not be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "A new parent turn will start automatically after the pointer delivery",
    );
  });

  it("explains explicit inject mode with automatic turn triggering disabled", async () => {
    const toolDef = getInteractiveToolDef(api);

    const result = await toolDef.execute(
      "call-3",
      {
        task: "research X",
        notifyOnComplete: "inject",
        triggerTurnOnComplete: false,
      },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].notifyOnComplete,
    ).toBe("inject");
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].triggerTurnOnComplete,
    ).toBe(false);
    expect(result.content[0].text).toContain(
      "Completion output will be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "No new parent turn will start automatically",
    );
  });

  it("forwards triggerTurnOnComplete when explicitly passed", async () => {
    const toolDef = getInteractiveToolDef(api);

    const result = await toolDef.execute(
      "call-trigger-turn",
      {
        task: "research X",
        notifyOnComplete: "notify",
        triggerTurnOnComplete: true,
      },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].triggerTurnOnComplete,
    ).toBe(true);
    expect(result.content[0].text).toContain(
      "Completion output will not be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "A new parent turn will start automatically after the pointer delivery",
    );
  });

  it("updates the running footer immediately after launch", async () => {
    const toolDef = getInteractiveToolDef(api);
    const ctx = mockCtx();
    const state = mockInteractiveState();
    mockLaunchInteractiveSubagent.mockImplementationOnce(() => {
      interactiveSubagentRegistry.set(state.id, state as any);
      return state;
    });

    await toolDef.execute(
      "call-footer-launch",
      { task: "research X" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
  });

  it("refreshes the footer when status pruning detects an exit", async () => {
    const toolDef = getStatusToolDef(api);
    const ctx = mockCtx();
    const state = mockInteractiveState();
    interactiveSubagentRegistry.set(state.id, state as any);
    mockPruneDeadInteractiveSubagents.mockImplementationOnce(() => {
      state.status = "exited";
    });

    await toolDef.execute(
      "call-footer-exit",
      { jobId: state.id },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      undefined,
    );
  });
  it("preserves explicit false triggering for notify mode", async () => {
    const toolDef = getInteractiveToolDef(api);

    const result = await toolDef.execute(
      "call-notify-no-trigger",
      {
        task: "research X",
        notifyOnComplete: "notify",
        triggerTurnOnComplete: false,
      },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].triggerTurnOnComplete,
    ).toBe(false);
    expect(result.content[0].text).toContain(
      "No new parent turn will start automatically",
    );
  });

  it("notifies the user without scheduling another LLM completion when cancelled", async () => {
    const toolDef = getCancelToolDef(api);
    const ctx = mockCtx();
    const state = mockInteractiveState();
    interactiveSubagentRegistry.set(state.id, state as any);
    mockCancelInteractiveSubagent.mockImplementationOnce(() => {
      state.status = "cancelled";
      return state;
    });

    const result = await toolDef.execute(
      "call-cancel",
      { jobId: "abc12345" },
      undefined,
      undefined,
      ctx,
    );

    expect(mockCancelInteractiveSubagent).toHaveBeenCalledWith("abc12345");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no separate cancellation completion"),
      "warning",
    );
    expect(result.content[0].text).toContain(
      "No separate cancellation completion will be injected",
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      undefined,
    );
  });

  it("exposes notifyOnComplete in the schema with the new default documented", () => {
    const toolDef = getInteractiveToolDef(api);
    expect(toolDef).toBeDefined();
    const params = toolDef.parameters;
    // TypeBox runtime shape: properties.notifyOnComplete exists
    const properties = (params as any).properties;
    expect(properties).toBeDefined();
    expect(properties.notifyOnComplete).toBeDefined();
    expect(properties.triggerTurnOnComplete).toBeDefined();
    // Description must document 'notify' as the default and 'inject' as a valid
    // alternative.
    const desc = properties.notifyOnComplete.description ?? "";
    expect(desc).toMatch(/notify.*default|default.*notify/i);
    expect(desc).toContain('"inject"');
  });
});
