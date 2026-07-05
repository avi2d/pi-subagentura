import { afterEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import { ORCHESTRATOR_STATUS_KEY } from "../src/orchestrator";

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

function mockCtx() {
  return { ui: { setStatus: vi.fn() } };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("extension registration", () => {
  it("registers the expected tools without throwing", () => {
    const api = mockApi();

    expect(() => registerExtension(api as any)).not.toThrow();

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
    const ctx = mockCtx();
    expect(handler(event, ctx)).toBeUndefined();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      ORCHESTRATOR_STATUS_KEY,
      undefined,
    );

    api.getFlag.mockReturnValue(true);
    const enabled = handler(event, ctx);
    expect(enabled.systemPrompt).toContain("base prompt");
    expect(enabled.systemPrompt).toContain("# Orchestrator");
    expect(enabled.systemPrompt).toContain("parent agent only");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      ORCHESTRATOR_STATUS_KEY,
      "🧭 orchestrator",
    );
  });

  it("enables orchestrator guidance with PI_ORCHESTRATOR", () => {
    vi.stubEnv("PI_ORCHESTRATOR", "1");
    const api = mockApi();
    registerExtension(api as any);
    const handler = api.on.mock.calls.find(
      ([eventName]: any[]) => eventName === "before_agent_start",
    )?.[1];

    const ctx = mockCtx();
    expect(handler({ systemPrompt: "base" }, ctx).systemPrompt).toContain(
      "# Orchestrator",
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      ORCHESTRATOR_STATUS_KEY,
      "🧭 orchestrator",
    );
  });
});
