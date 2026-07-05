import { afterEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";

function mockApi(overrides: Record<string, any> = {}) {
  return {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("extension registration", () => {
  it("registers the expected tools without throwing", () => {
    const api = mockApi();

    expect(() => registerExtension(api as any)).not.toThrow();
    expect(api.registerMessageRenderer).toHaveBeenCalledOnce();
    expect(api.registerMessageRenderer).toHaveBeenCalledWith(
      "subagent-notify",
      expect.any(Function),
    );

    const names = api.registerTool.mock.calls
      .map(([tool]: any[]) => tool.name)
      .sort();
    expect(names).toEqual(
      [
        "cancel_interactive_subagent",
        "cancel_subagent",
        "cancel_workflow",
        "cleanup_subagent_artifacts",
        "get_interactive_subagent_status",
        "get_subagent_result",
        "get_subagent_status",
        "get_workflow_result",
        "get_workflow_status",
        "list_available_models",
        "list_subagent_artifacts",
        "list_workflows",
        "prune_subagent_jobs",
        "read_subagent_artifact",
        "save_workflow",
        "send_interactive_subagent_message",
        "subagent_interactive",
        "subagent_isolated",
        "subagent_with_context",
        "workflow",
      ].sort(),
    );
    expect(api.registerFlag).toHaveBeenCalledWith(
      "orchestrator",
      expect.objectContaining({ type: "boolean", default: false }),
    );
  });

  it("appends orchestrator guidance to the system prompt only when enabled", () => {
    const api = mockApi({ getFlag: vi.fn().mockReturnValue(false) });
    registerExtension(api as any);

    const handler = api.on.mock.calls.find(
      ([eventName]: any[]) => eventName === "before_agent_start",
    )?.[1];
    expect(handler).toBeDefined();

    const event = { systemPrompt: "base prompt" };
    expect(handler(event)).toBeUndefined();

    api.getFlag.mockReturnValue(true);
    const enabled = handler(event);
    expect(enabled.systemPrompt).toContain("base prompt");
    expect(enabled.systemPrompt).toContain("# Orchestrator");
    expect(enabled.systemPrompt).toContain("parent agent only");
  });

  it("enables orchestrator guidance with PI_ORCHESTRATOR", () => {
    vi.stubEnv("PI_ORCHESTRATOR", "1");
    const api = mockApi();
    registerExtension(api as any);
    const handler = api.on.mock.calls.find(
      ([eventName]: any[]) => eventName === "before_agent_start",
    )?.[1];

    expect(handler({ systemPrompt: "base" }).systemPrompt).toContain(
      "# Orchestrator",
    );
  });

  it("registers only protocol hooks in child mode", () => {
    const previous = process.env.PI_SUBAGENTURA_CHILD;
    const previousArtifactDir = process.env.ARTIFACT_DIR;
    process.env.PI_SUBAGENTURA_CHILD = "1";
    process.env.ARTIFACT_DIR = "/tmp/pi-subagentura-extension-test";
    const api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn(),
    };

    try {
      registerExtension(api as any);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENTURA_CHILD;
      else process.env.PI_SUBAGENTURA_CHILD = previous;
      if (previousArtifactDir === undefined) delete process.env.ARTIFACT_DIR;
      else process.env.ARTIFACT_DIR = previousArtifactDir;
    }

    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerMessageRenderer).not.toHaveBeenCalled();
    expect(api.on.mock.calls.map(([event]) => event)).toEqual([
      "before_agent_start",
      "turn_start",
      "before_provider_request",
      "tool_execution_start",
      "tool_execution_end",
      "agent_end",
      "agent_settled",
    ]);
  });
});
