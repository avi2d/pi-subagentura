/**
 * Tests for the subagent_interactive tool's `notifyOnComplete` defaulting.
 *
 * The tool's `execute` defaults `notifyOnComplete` to "inject" (not "notify")
 * so the parent LLM is woken up by default when an interactive sub-agent
 * finishes. These tests assert the default by mocking the tmux-backed
 * `launchInteractiveSubagent` helper and capturing the call args.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCancelInteractiveSubagent, mockLaunchInteractiveSubagent } =
  vi.hoisted(() => ({
    mockCancelInteractiveSubagent: vi.fn(),
    mockLaunchInteractiveSubagent: vi.fn(),
  }));

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    launchInteractiveSubagent: mockLaunchInteractiveSubagent,
    cancelInteractiveSubagent: mockCancelInteractiveSubagent,
  };
});

import registerExtension from "../src/subagent";

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

describe("subagent_interactive notifyOnComplete default", () => {
  let api: ReturnType<typeof setupExtension>;

  function setupExtension() {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(_api as any);
    return _api;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    api = setupExtension() as any;
    mockLaunchInteractiveSubagent.mockReset();
    mockCancelInteractiveSubagent.mockReset();
    mockCancelInteractiveSubagent.mockReturnValue({
      id: "abc12345",
      status: "cancelled",
      artifactDir: "/tmp/artifacts/abc12345",
    });
    // Return a minimal valid InteractiveSubagentState.
    mockLaunchInteractiveSubagent.mockReturnValue({
      id: "abc12345",
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: "/tmp/sess.jsonl",
      cwd: "/tmp",
      startedAt: Date.now(),
      status: "running",
      mux: "tmux",
      attachCommand: "tmux attach -t s",
      selectPaneCommand: "tmux select-pane -t '%99'",
      launchScriptFile: "/tmp/launch.sh",
      artifactDir: "/tmp/artifacts/abc12345",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to 'inject' when notifyOnComplete is omitted (parent LLM is woken up by default)", async () => {
    const toolDef = getInteractiveToolDef(api);
    expect(toolDef).toBeDefined();

    const result = await toolDef.execute(
      "call-1",
      { task: "research X" },
      undefined,
      undefined,
      mockCtx(),
    );

    // The helper was called exactly once.
    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    // And the default was 'inject' — not 'notify'.
    const callArgs = mockLaunchInteractiveSubagent.mock.calls[0][0];
    expect(callArgs.notifyOnComplete).toBe("inject");
    expect(result.content[0].text).toContain(
      "Completion output will be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "A new parent turn will start automatically after the injection",
    );
  });

  it("forwards 'notify' when explicitly passed (opt out of LLM wake-up)", async () => {
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
    expect(result.content[0].text).toContain(
      "Completion output will not be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "No new parent turn will start automatically",
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

  it("notifies the user without scheduling another LLM completion when cancelled", async () => {
    const toolDef = getCancelToolDef(api);
    const ctx = mockCtx();

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
    // Description must document 'inject' as the default and 'notify' as a valid
    // alternative. We don't assert literal phrasing — just that 'inject' is the
    // documented default — so wording tweaks don't break the test.
    const desc = properties.notifyOnComplete.description ?? "";
    // 'inject' is documented as the default.
    expect(desc).toMatch(/inject.*default|default.*inject/i);
    // 'notify' is documented as a valid choice (just not the default).
    expect(desc).toContain('"notify"');
  });
});
