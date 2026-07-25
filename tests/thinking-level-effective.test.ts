import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBuildSessionOptions,
  mockCreateCompatibleSessionRuntime,
  mockCreateAgentSession,
} = vi.hoisted(() => ({
  mockBuildSessionOptions: vi.fn(),
  mockCreateCompatibleSessionRuntime: vi.fn(),
  mockCreateAgentSession: vi.fn(),
}));

vi.mock("../src/pi-sdk-compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pi-sdk-compat")>();
  return {
    ...actual,
    buildSessionOptions: mockBuildSessionOptions,
    createCompatibleSessionRuntime: mockCreateCompatibleSessionRuntime,
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: mockCreateAgentSession,
    SessionManager: { inMemory: vi.fn(() => ({})) },
  };
});

import { jobRegistry, startSubagentJob } from "../src/helpers";

function createSession(thinkingLevel: string) {
  return {
    thinkingLevel,
    model: undefined,
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined),
    agent: { state: { messages: [], errorMessage: null } },
    dispose: vi.fn(),
  };
}

function params(
  thinkingLevel?:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
) {
  return {
    task: "test task",
    persona: undefined,
    modelOverride: undefined,
    cwd: "/tmp",
    contextText: null,
    signal: undefined,
    onUpdate: undefined,
    defaultModel: undefined,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

describe("startSubagentJob effective thinking level", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobRegistry.clear();
    mockCreateCompatibleSessionRuntime.mockResolvedValue({
      kind: "modern",
      modelRuntime: {},
    });
    mockBuildSessionOptions.mockReturnValue({});
  });

  it("threads explicit requested options to the SDK and exposes effective level", async () => {
    const session = createSession("low");
    mockCreateAgentSession.mockResolvedValue({ session });

    const started = await startSubagentJob(params("high"));
    started.start();
    const result = await started.jobPromise;

    expect(mockBuildSessionOptions.mock.calls[0][1]).toMatchObject({
      thinkingLevel: "high",
    });
    expect(started.thinkingLevel).toBe("low");
    expect(started.liveStatus.thinkingLevel).toBe("low");
    expect(result.thinkingLevel).toBe("low");
  });

  it("keeps thinking-level details omitted when the request omits it", async () => {
    const session = createSession("medium");
    mockCreateAgentSession.mockResolvedValue({ session });

    const started = await startSubagentJob(params());
    started.start();
    const result = await started.jobPromise;

    expect(mockBuildSessionOptions.mock.calls[0][1]).not.toHaveProperty(
      "thinkingLevel",
    );
    expect(started.thinkingLevel).toBeUndefined();
    expect(started.liveStatus.thinkingLevel).toBeUndefined();
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("disposes a prepared session without starting its prompt", async () => {
    const session = createSession("medium");
    mockCreateAgentSession.mockResolvedValue({ session });

    const prepared = await startSubagentJob(params());
    expect(session.prompt).not.toHaveBeenCalled();

    prepared.disposeBeforeStart();
    const result = await prepared.jobPromise;

    expect(result.cancelled).toBe(true);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
