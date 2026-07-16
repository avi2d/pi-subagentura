import { describe, expect, it, vi } from "vitest";
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
        "delete_workflow",
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
  });

  it("registers the --orchestrator flag", () => {
    const api = mockApi();

    registerExtension(api as any);

    expect(api.registerFlag).toHaveBeenCalledWith("orchestrator", {
      description: "Append the bundled orchestration system prompt",
      type: "boolean",
      default: false,
    });
  });

  it("appends the bundled prompt when --orchestrator is enabled", async () => {
    const api = mockApi({ getFlag: vi.fn().mockReturnValue(true) });

    registerExtension(api as any);

    const beforeAgentStart = api.on.mock.calls.find(
      ([event]: any[]) => event === "before_agent_start",
    )?.[1];
    const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {});

    expect(result.systemPrompt).toContain("# Orchestrator System Prompt");
    expect(result.systemPrompt.startsWith("base prompt\n\n")).toBe(true);
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
