import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import { ONLY_INTERACTIVE_MAINTENANCE_TOOLS } from "../src/tools/in-process";

/** Registered by `registerInteractiveSubagentTools` in every parent mode. */
const INTERACTIVE_TOOL_NAMES = [
  "cancel_interactive_subagent",
  "get_interactive_subagent_status",
  "list_subagent_artifacts",
  "read_subagent_artifact",
  "send_interactive_subagent_message",
  "subagent_interactive",
];

/**
 * Expected surface of only-interactive mode: the interactive tools plus the
 * maintenance subset declared by src/tools/in-process.ts (the single source of
 * truth for that subset).
 */
const ONLY_INTERACTIVE_TOOLS = [
  ...INTERACTIVE_TOOL_NAMES,
  ...ONLY_INTERACTIVE_MAINTENANCE_TOOLS,
].sort();

/**
 * Expected surface of the default mode, spelled out independently on purpose:
 * if this were derived from ONLY_INTERACTIVE_TOOLS, editing one mode's
 * expectation would silently move the other and both tests would stay green.
 */
const FULL_MODE_TOOLS = [
  "cancel_interactive_subagent",
  "cancel_subagent",
  "cancel_workflow",
  "cleanup_subagent_artifacts",
  "delete_workflow",
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
].sort();

/** Tools that only-interactive mode must drop. */
const FULL_MODE_ONLY_TOOLS = FULL_MODE_TOOLS.filter(
  (name) => !ONLY_INTERACTIVE_TOOLS.includes(name),
);

function getRegisteredToolNames(api: {
  registerTool: ReturnType<typeof vi.fn>;
}) {
  return api.registerTool.mock.calls.map(([tool]: any[]) => tool.name).sort();
}

function getRegisteredCommandNames(api: {
  registerCommand: ReturnType<typeof vi.fn>;
}) {
  return api.registerCommand.mock.calls.map(([name]: any[]) => name as string);
}

function mockApi(overrides: Record<string, any> = {}) {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    ...overrides,
  };
}

describe("extension registration", () => {
  let previousChild: string | undefined;
  let previousOnlyInteractive: string | undefined;
  beforeEach(() => {
    previousChild = process.env.PI_SUBAGENTURA_CHILD;
    previousOnlyInteractive = process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE;
    delete process.env.PI_SUBAGENTURA_CHILD;
    delete process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE;
  });
  afterEach(() => {
    if (previousChild === undefined) {
      delete process.env.PI_SUBAGENTURA_CHILD;
    } else {
      process.env.PI_SUBAGENTURA_CHILD = previousChild;
    }
    if (previousOnlyInteractive === undefined) {
      delete process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE;
    } else {
      process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE = previousOnlyInteractive;
    }
  });

  it("registers the expected tools without throwing", () => {
    const api = mockApi();
    expect(() => registerExtension(api as any)).not.toThrow();
    expect(api.registerMessageRenderer).toHaveBeenCalledOnce();
    expect(api.registerMessageRenderer).toHaveBeenCalledWith(
      "subagent-notify",
      expect.any(Function),
    );

    expect(getRegisteredToolNames(api)).toEqual(FULL_MODE_TOOLS);
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

  it("registers the --only-interactive flag", () => {
    const api = mockApi();

    registerExtension(api as any);

    expect(api.registerFlag).toHaveBeenCalledWith("only-interactive", {
      description:
        "Register only attachable interactive sub-agent tools, model listing, and artifact cleanup",
      type: "boolean",
      default: false,
    });
  });

  it("omits in-process and workflow tools in only-interactive mode", () => {
    process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE = "1";
    const api = mockApi();

    registerExtension(api as any);

    const names = getRegisteredToolNames(api);
    expect(names).toEqual(ONLY_INTERACTIVE_TOOLS);
    for (const name of FULL_MODE_ONLY_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  it("selects only-interactive mode from the --only-interactive argv", () => {
    const api = mockApi();
    process.argv.push("--only-interactive");

    try {
      registerExtension(api as any);
    } finally {
      process.argv.splice(process.argv.indexOf("--only-interactive"), 1);
    }

    expect(getRegisteredToolNames(api)).toEqual(ONLY_INTERACTIVE_TOOLS);
  });

  /**
   * Ordering contract, documented as a test: Pi applies CLI flag values AFTER
   * every extension factory has run, so `pi.getFlag("only-interactive")` is
   * still the registered default during activation. Registration must therefore
   * ignore it — a mode gated on `getFlag` alone would be dead code.
   */
  it("ignores getFlag('only-interactive') because flag values arrive after activation", () => {
    const api = mockApi({
      getFlag: vi.fn((name: string) => name === "only-interactive"),
    });

    registerExtension(api as any);

    expect(getRegisteredToolNames(api)).toEqual(FULL_MODE_TOOLS);
  });

  it("keeps interactive tools and session handlers in only-interactive mode", () => {
    process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE = "1";
    const api = mockApi();

    registerExtension(api as any);

    expect(getRegisteredToolNames(api)).toEqual(ONLY_INTERACTIVE_TOOLS);

    const events = api.on.mock.calls.map(([event]: any[]) => event as string);
    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
    expect(events).toContain("agent_settled");
  });

  it.each([
    ["default mode", undefined],
    ["only-interactive mode", "1"],
  ])(
    "keeps /cancel-all-flows and ctrl+alt+x available in %s",
    (_label, onlyInteractive) => {
      if (onlyInteractive) {
        process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE = onlyInteractive;
      }
      const api = mockApi();

      registerExtension(api as any);

      expect(getRegisteredCommandNames(api)).toContain("cancel-all-flows");
      expect(api.registerShortcut).toHaveBeenCalledWith(
        "ctrl+alt+x",
        expect.objectContaining({ handler: expect.any(Function) }),
      );
    },
  );

  it("registers only /cancel-all-flows in only-interactive mode", () => {
    process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE = "1";
    const api = mockApi();

    registerExtension(api as any);

    expect(getRegisteredCommandNames(api)).toEqual(["cancel-all-flows"]);
  });

  it("appends the bundled prompt when --orchestrator is enabled", async () => {
    const api = mockApi({
      getFlag: vi.fn((name: string) => name === "orchestrator"),
    });

    registerExtension(api as any);

    const beforeAgentStart = api.on.mock.calls.find(
      ([event]: any[]) => event === "before_agent_start",
    )?.[1];
    const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {});

    expect(result.systemPrompt).toContain("# Orchestrator System Prompt");
    expect(result.systemPrompt).toContain("subagent_isolated");
    expect(result.systemPrompt.startsWith("base prompt\n\n")).toBe(true);
  });

  it("appends the reduced prompt when --orchestrator meets only-interactive mode", async () => {
    process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE = "1";
    const api = mockApi({
      getFlag: vi.fn((name: string) => name === "orchestrator"),
    });

    registerExtension(api as any);

    const beforeAgentStart = api.on.mock.calls.find(
      ([event]: any[]) => event === "before_agent_start",
    )?.[1];
    const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {});

    expect(result.systemPrompt).toContain(
      "# Orchestrator System Prompt (only-interactive mode)",
    );
    expect(result.systemPrompt.startsWith("base prompt\n\n")).toBe(true);
    // The prompt must never advertise a tool this mode does not register.
    for (const name of FULL_MODE_ONLY_TOOLS) {
      expect(result.systemPrompt).not.toContain(name);
    }
    for (const name of ONLY_INTERACTIVE_TOOLS) {
      expect(result.systemPrompt).toContain(name);
    }
  });

  it("registers only protocol hooks in child mode", () => {
    const previous = process.env.PI_SUBAGENTURA_CHILD;
    const previousArtifactDir = process.env.ARTIFACT_DIR;
    process.env.PI_SUBAGENTURA_CHILD = "1";
    process.env.ARTIFACT_DIR = "/tmp/pi-subagentura-extension-test";
    const api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
    };

    try {
      registerExtension(api as any);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENTURA_CHILD;
      else process.env.PI_SUBAGENTURA_CHILD = previous;
      if (previousArtifactDir === undefined) delete process.env.ARTIFACT_DIR;
      else process.env.ARTIFACT_DIR = previousArtifactDir;
    }

    const names = api.registerTool.mock.calls
      .map(([tool]: any[]) => tool.name)
      .sort();
    expect(names).toEqual(
      [
        "cancel_interactive_subagent",
        "cleanup_subagent_artifacts",
        "get_interactive_subagent_status",
        "list_available_models",
        "list_subagent_artifacts",
        "read_subagent_artifact",
        "send_interactive_subagent_message",
        "subagent_interactive",
      ].sort(),
    );
    expect(names).not.toContain("workflow");
    expect(names).not.toContain("subagent_with_context");
    expect(api.registerMessageRenderer).toHaveBeenCalledWith(
      "subagent-notify",
      expect.any(Function),
    );
    expect(api.registerCommand).toHaveBeenCalledWith(
      "subagents",
      expect.any(Object),
    );
    expect(api.registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+a",
      expect.any(Object),
    );
    expect(api.on.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        "before_agent_start",
        "turn_start",
        "before_provider_request",
        "tool_execution_start",
        "tool_execution_end",
        "agent_end",
        "agent_settled",
        "session_start",
        "session_shutdown",
      ]),
    );
  });
});
