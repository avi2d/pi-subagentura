/**
 * Tests for the in-process sub-agent tools (in-process.ts).
 *
 * Covers parameter validation, edge cases, and list_available_models
 * filtering for every exported tool.
 *
 * Uses vi.hoisted + vi.mock to swap module-level dependencies while
 * keeping the real jobRegistry Map so tests can seed and verify state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock variables (available before vi.mock runs) ───────────

const {
  mockStartSubagentJob,
  mockDebugLog,
  mockFormatUsage,
  mockBuildLiveUpdate,
  mockScheduleJobCleanup,
  mockDeliverNotification,
} = vi.hoisted(() => ({
  mockStartSubagentJob: vi.fn(),
  mockDebugLog: vi.fn(),
  mockFormatUsage: vi.fn(),
  mockBuildLiveUpdate: vi.fn(),
  mockScheduleJobCleanup: vi.fn(),
  mockDeliverNotification: vi.fn(),
}));

// We need a separate hoisted mock for `convertToLlm` / `serializeConversation`
// so subagent_with_context does not try to serialize real messages.
const { mockConvertToLlm, mockSerializeConversation } = vi.hoisted(() => ({
  mockConvertToLlm: vi.fn(),
  mockSerializeConversation: vi.fn(),
}));

// ── Module mocks ─────────────────────────────────────────────────────

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return {
    ...actual,
    startSubagentJob: mockStartSubagentJob,
    debugLog: mockDebugLog,
    formatUsage: mockFormatUsage,
    buildLiveUpdate: mockBuildLiveUpdate,
    scheduleJobCleanup: mockScheduleJobCleanup,
  };
});

vi.mock("../src/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notifications")>();
  return {
    ...actual,
    deliverNotification: mockDeliverNotification,
  };
});

// interactive-tmux.ts has a TypeScript syntax that esbuild (vitest's transformer)
// cannot parse (line 613). We mock it so vitest never loads the source.
vi.mock("../src/interactive-tmux", () => {
  const fakeRegistry = new Map<string, any>();
  return {
    interactiveSubagentRegistry: fakeRegistry,
    isTmuxAvailable: () => false,
    default: {},
    // The specific shape doesn't matter — only the import needs to resolve.
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    convertToLlm: mockConvertToLlm,
    serializeConversation: mockSerializeConversation,
  };
});

// ── Imports (after mocks, vitest resolves to mocked modules) ─────────

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type JobState,
  type SubagentResult,
  jobRegistry,
} from "../src/helpers";
import {
  registerInProcessMaintenanceTools,
  registerInProcessSubagentTools,
} from "../src/tools/in-process";

// ── Helpers ──────────────────────────────────────────────────────────

/** A minimal context object that satisfies the tools' `ctx` parameter. */
function mockCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: "/tmp",
    ui: { setStatus: vi.fn() },
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("test-session"),
    },
    model: undefined,
    modelRegistry: {
      getAvailable: vi.fn().mockReturnValue([]),
      getAll: vi.fn().mockReturnValue([]),
      find: vi.fn(),
    },
    ...overrides,
  };
}

/** A minimal JobState for test seeding. */
function createJobState(overrides: Partial<JobState> = {}): JobState {
  return {
    id: "test-job",
    status: "running",
    liveStatus: {
      turn: 0,
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
    },
    session: { abort: vi.fn().mockResolvedValue(undefined) } as any,
    startedAt: Date.now(),
    promise: Promise.resolve({
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: false,
    }),
    modelLabel: "test/model",
    ...overrides,
  };
}

/** Build a mock ExtensionAPI, register the tools, and return the API handle. */
function setupExtension() {
  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };
  registerInProcessSubagentTools(api as any);
  registerInProcessMaintenanceTools(api as any);
  return api;
}

/** Find a tool definition by name from the registered tools. */
function getToolDef(
  api: { registerTool: ReturnType<typeof vi.fn> },
  name: string,
) {
  return api.registerTool.mock.calls.find(([t]: any[]) => t.name === name)?.[0];
}

/** A default success SubagentResult for mockStartSubagentJob. */
const defaultSuccessResult: SubagentResult = {
  output: "task completed",
  usage: {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.001,
    turns: 1,
  },
  model: "test/model",
  isError: false,
};

/** Default return value for mockStartSubagentJob (sync tool path). */
const defaultStartSubagentJobResult = {
  jobId: "default-job",
  jobPromise: Promise.resolve(defaultSuccessResult),
  session: { abort: vi.fn().mockResolvedValue(undefined) } as any,
  liveStatus: {
    turn: 1,
    output: "task completed",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.001,
      turns: 1,
    },
  },
  modelLabel: "test/model",
};

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  jobRegistry.clear();
  mockStartSubagentJob.mockReset();
  mockStartSubagentJob.mockResolvedValue(defaultStartSubagentJobResult);
  mockFormatUsage.mockReturnValue("mock usage 1 turn");
  mockBuildLiveUpdate.mockReturnValue({
    content: [{ type: "text", text: "running..." }],
    details: { status: "running", subagentStatus: {} },
  });
});

afterEach(() => {
  jobRegistry.clear();
});

// ── subagent_with_context ────────────────────────────────────────────

describe("subagent_with_context tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "subagent_with_context");
  });

  it("returns 'No conversation history to inherit' when branch is empty (sync path)", async () => {
    // sessionManager.getBranch returns [] — the tool immediately bails.
    const ctx = mockCtx();
    const result = await toolDef.execute(
      "call-1",
      { task: "do something" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toBe("No conversation history to inherit.");
    expect(result.details).toEqual({});
    // No calls beyond the early return
    expect(mockStartSubagentJob).not.toHaveBeenCalled();
    expect(mockConvertToLlm).not.toHaveBeenCalled();
  });

  it("registers with BaseParams schema", () => {
    const params = toolDef.parameters;
    const props = (params as any).properties;
    // Required field
    expect(props.task).toBeDefined();
    expect(props.task.type).toBe("string");
    // Optional fields from BaseParams
    expect(props.persona).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.cwd).toBeDefined();
    expect(props.async).toBeDefined();
    expect(props.notifyOnComplete).toBeDefined();
    expect(props.maxAge).toBeDefined();
  });
});

// ── subagent_isolated ────────────────────────────────────────────────

describe("subagent_isolated tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "subagent_isolated");
  });

  it("passes null context to startSubagentJob (sync path)", async () => {
    const ctx = mockCtx();
    // isolated tool doesn't consult getBranch at all, so no messages needed
    const result = await toolDef.execute(
      "call-1",
      { task: "analyze code" },
      undefined,
      undefined,
      ctx,
    );

    // startSubagentJob should have been called with contextText: null
    expect(mockStartSubagentJob).toHaveBeenCalledWith(
      expect.objectContaining({ contextText: null }),
    );
    // Result should come from the mocked runSubagent path
    expect(result.content[0].text).toBe("task completed");
    expect(result.details.status).toBe("done");
  });

  it("registers with BaseParams schema", () => {
    const params = toolDef.parameters;
    const props = (params as any).properties;
    expect(props.task).toBeDefined();
    expect(props.task.type).toBe("string");
    expect(props.persona).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.cwd).toBeDefined();
    expect(props.async).toBeDefined();
    expect(props.notifyOnComplete).toBeDefined();
    expect(props.maxAge).toBeDefined();
  });
});

// ── get_subagent_status ──────────────────────────────────────────────

describe("get_subagent_status tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "get_subagent_status");
  });

  it("returns not_found for unknown jobId", async () => {
    const result = await toolDef.execute(
      "call-1",
      { jobId: "nonexistent" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      "Job nonexistent not found. It may have been cancelled.",
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("not_found");
    expect(result.details.jobId).toBe("nonexistent");
  });

  it("returns cancelled response when job status is cancelled", async () => {
    const jobId = "cancelled-job";
    jobRegistry.set(jobId, createJobState({ id: jobId, status: "cancelled" }));

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(`Job ${jobId} was cancelled.`);
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("cancelled");
  });

  it("returns done response with usage summary when status is done", async () => {
    const jobId = "done-job";
    const doneResult: SubagentResult = {
      output: "analysis complete",
      usage: {
        input: 200,
        output: 150,
        cacheRead: 10,
        cacheWrite: 5,
        cost: 0.002,
        turns: 2,
      },
      model: "anthropic/claude-3-5-sonnet",
      isError: false,
    };
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "done",
        result: doneResult,
        promise: Promise.resolve(doneResult),
      }),
    );

    mockFormatUsage.mockReturnValue("2 turns ↑200 ↓150 $0.0020");

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe("analysis complete");
    expect(result.details.status).toBe("done");
    expect(result.details.usageSummary).toBe("2 turns ↑200 ↓150 $0.0020");
    expect(result.details.usage).toEqual(doneResult.usage);
    expect(result.details.model).toBe("anthropic/claude-3-5-sonnet");
    expect(result.isError).toBeFalsy();
  });

  it("returns error response with usage summary when status is error", async () => {
    const jobId = "error-job";
    const errorResult: SubagentResult = {
      output: "Something went wrong",
      usage: {
        input: 50,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.0005,
        turns: 1,
      },
      model: undefined,
      isError: true,
      errorMessage: "LLM returned an error",
    };
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "error",
        result: errorResult,
        promise: Promise.resolve(errorResult),
      }),
    );

    mockFormatUsage.mockReturnValue("1 turn ↑50 ↓10 $0.0005");

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    // get_subagent_status returns result.output directly (unlike
    // get_subagent_result which wraps it with "Sub-agent failed:")
    expect(result.content[0].text).toBe("Something went wrong");
    expect(result.details.status).toBe("error");
    expect(result.details.usageSummary).toBe("1 turn ↑50 ↓10 $0.0005");
    expect(result.isError).toBe(true);
  });

  it("returns running update for running job", async () => {
    const jobId = "running-job";
    jobRegistry.set(jobId, createJobState({ id: jobId, status: "running" }));

    mockBuildLiveUpdate.mockReturnValue({
      content: [{ type: "text", text: "still working..." }],
      details: {
        status: "running",
        subagentStatus: { turn: 2, output: "still working...", usage: {} },
        model: "test/model",
      },
    });

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.details.status).toBe("running");
    expect(result.content[0].text).toBe("still working...");
  });
});

// ── get_subagent_result ──────────────────────────────────────────────

describe("get_subagent_result tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "get_subagent_result");
  });

  it("returns not_found for unknown jobId", async () => {
    const result = await toolDef.execute(
      "call-1",
      { jobId: "missing" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      "Job missing not found. It may have been cancelled.",
    );
    expect(result.isError).toBe(true);
    expect(result.details.jobId).toBe("missing");
  });

  it("returns cancelled when job status is already cancelled", async () => {
    const jobId = "cancelled-result";
    jobRegistry.set(jobId, createJobState({ id: jobId, status: "cancelled" }));

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      `Job ${jobId} was cancelled before completion.`,
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("cancelled");
  });

  it("returns done result for completed job", async () => {
    const jobId = "done-result";
    const doneResult: SubagentResult = {
      output: "final analysis",
      usage: {
        input: 300,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.003,
        turns: 3,
      },
      model: "anthropic/claude-sonnet",
      isError: false,
    };
    const job: JobState = createJobState({
      id: jobId,
      status: "done",
      result: doneResult,
      promise: Promise.resolve(doneResult),
    });
    jobRegistry.set(jobId, job);

    mockFormatUsage.mockReturnValue("3 turns ↑300 ↓200 $0.0030");

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe("final analysis");
    expect(result.details.status).toBe("done");
    expect(result.details.usageSummary).toBe("3 turns ↑300 ↓200 $0.0030");
    expect(result.isError).toBeFalsy();
    // resultRetrieved should have been set
    expect(job.resultRetrieved).toBe(true);
  });

  it("handles cancellation race (status changes to cancelled after await)", async () => {
    const jobId = "race-job";
    let resolvePromise!: (value: SubagentResult) => void;
    const deferredPromise = new Promise<SubagentResult>((resolve) => {
      resolvePromise = resolve;
    });

    const job: JobState = createJobState({
      id: jobId,
      status: "running",
      promise: deferredPromise,
    });
    jobRegistry.set(jobId, job);

    // Start execute – it will set resultRetrieved=true then await the promise
    const executePromise = toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    // Resolve the promise (schedules microtask)
    resolvePromise({
      output: "should be ignored",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: true,
      errorMessage: "aborted",
    });

    // Simulate the race: another code path cancels the job synchronously
    // BEFORE the microtask that resumes the tool executes.
    job.status = "cancelled";

    const result = await executePromise;

    expect(result.content[0].text).toBe(
      `Job ${jobId} was cancelled before completion.`,
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("cancelled");
  });
});

// ── cancel_subagent ──────────────────────────────────────────────────

describe("cancel_subagent tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "cancel_subagent");
  });

  it("returns not_found for unknown jobId", async () => {
    const result = await toolDef.execute(
      "call-1",
      { jobId: "unknown" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe("Job unknown not found.");
    expect(result.isError).toBe(true);
    expect(result.details.jobId).toBe("unknown");
  });

  it("returns already cancelled when job status is already cancelled", async () => {
    const jobId = "already-cancelled";
    jobRegistry.set(jobId, createJobState({ id: jobId, status: "cancelled" }));

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(`Job ${jobId} was already cancelled.`);
    // Already-cancelled is NOT considered an error by the tool
    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("cancelled");
  });

  it("returns already completed when job is done", async () => {
    const jobId = "done-cancel";
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "done",
        result: defaultSuccessResult,
      }),
    );

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      `Job ${jobId} already completed — cannot cancel.`,
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("done");
  });

  it("returns already completed when job is in error state", async () => {
    const jobId = "error-cancel";
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "error",
        result: {
          isError: true,
          output: defaultSuccessResult.output,
          usage: defaultSuccessResult.usage,
          errorMessage: "previous error",
        },
      }),
    );

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      `Job ${jobId} already completed — cannot cancel.`,
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("error");
  });

  it("cancels a running job and calls session.abort", async () => {
    const jobId = "running-cancel";
    const abortFn = vi.fn().mockResolvedValue(undefined);
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "running",
        session: { abort: abortFn } as any,
      }),
    );

    const ctx = mockCtx();
    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toBe(`Job ${jobId} cancelled.`);
    expect(result.details.status).toBe("cancelled");
    // session.abort was called
    expect(abortFn).toHaveBeenCalledTimes(1);
    // scheduleJobCleanup was called for immediate cleanup
    expect(mockScheduleJobCleanup).toHaveBeenCalledWith(jobId, true);
    // Footer was updated
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });

  it("handles abort rejection gracefully", async () => {
    const jobId = "abort-throws";
    const abortFn = vi.fn().mockRejectedValue(new Error("session gone"));
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "running",
        session: { abort: abortFn } as any,
      }),
    );

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    // Even though abort threw, the tool should still report cancellation
    expect(result.content[0].text).toBe(`Job ${jobId} cancelled.`);
    expect(result.details.status).toBe("cancelled");
  });
});

// ── list_available_models ────────────────────────────────────────────

describe("list_available_models tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "list_available_models");
  });

  const baseModels = [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    },
    { provider: "anthropic", id: "claude-haiku-4", name: "Claude Haiku 4" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { provider: "google", id: "gemini-2.5-flash", name: undefined },
  ];

  it("uses modelRegistry.getAvailable() when authOnly is true (default)", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels.slice(0, 3));
    const getAll = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll, find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { authOnly: true },
      undefined,
      undefined,
      ctx,
    );

    expect(getAvailable).toHaveBeenCalledTimes(1);
    expect(getAll).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("3 models with auth configured");
  });

  it("uses modelRegistry.getAll() when authOnly is false", async () => {
    const getAvailable = vi.fn().mockReturnValue([]);
    const getAll = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll, find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { authOnly: false },
      undefined,
      undefined,
      ctx,
    );

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAvailable).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("6 models total");
  });

  it("authOnly defaults to true when omitted", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels.slice(0, 2));
    const getAll = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll, find: vi.fn() },
    });

    await toolDef.execute("call-1", {}, undefined, undefined, ctx);

    expect(getAvailable).toHaveBeenCalledTimes(1);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("filters by filter param on provider name (case-insensitive)", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "ANTHROPIC" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("anthropic/claude-sonnet-4-5");
    expect(text).toContain("anthropic/claude-haiku-4");
    expect(text).not.toContain("openai");
    expect(text).not.toContain("minimax");
    expect(text).not.toContain("google");
  });

  it("filters by filter param on model id (case-insensitive)", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "gpt" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("gpt-4o");
    expect(text).toContain("gpt-4o-mini");
    expect(text).not.toContain("anthropic");
    expect(text).not.toContain("minimax");
  });

  it("filters by filter param on model name", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "MiniMax" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("MiniMax-M2.7");
    expect(text).not.toContain("claude");
    expect(text).not.toContain("gpt");
    expect(text).toContain("MiniMax M2.7"); // name appended
  });

  it("returns correct count and formatted text", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { authOnly: true },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.count).toBe(6);
    expect(result.details.models).toHaveLength(6);
    expect(result.details.models[0].provider).toBe("anthropic");
    expect(result.details.models[0].id).toBe("claude-sonnet-4-5");
    expect(result.details.models[0].name).toBe("Claude Sonnet 4.5");
    // Name-less model does not have a name prop (it's undefined)
    expect(result.details.models[5].name).toBeUndefined();
  });

  it("shows models with name appended in parentheses", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "gpt-4o" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("gpt-4o  (GPT-4o)");
    expect(text).toContain("gpt-4o-mini  (GPT-4o Mini)");
  });

  it("shows '(no models match)' when filter matches nothing", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "nonexistent" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("0 models with auth configured");
    expect(text).toContain("(no models match)");
  });

  it("shows the search pattern when a filter is provided", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "big-pickle" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("Search pattern: big-pickle");
  });

  it("handles empty model registry gracefully", async () => {
    const getAvailable = vi.fn().mockReturnValue([]);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      {},
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("0 models with auth configured");
    expect(result.details.count).toBe(0);
  });
});
