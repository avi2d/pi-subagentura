import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, artifactPath, writeOutput } from "./artifact";
import { importFresh } from "./test-utils";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentResult } from "./helpers";

// ── Hoisted mock: startSubagentJob must be mocked before any imports ──────
const { mockStartSubagentJob } = vi.hoisted(() => ({
  mockStartSubagentJob: vi.fn(),
}));

vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return { ...actual, startSubagentJob: mockStartSubagentJob };
});

// ── Imports (resolved after hoisted mock) ─────────────────────────────────
import registerExtension, { getInjectCount, MAX_INJECT } from "./subagent";
import { jobRegistry } from "./helpers";

// ── Fixtures ──────────────────────────────────────────────────────────────

const SUCCESS_RESULT: SubagentResult = {
  output: "All tests pass",
  usage: {
    input: 10,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.001,
    turns: 1,
  },
  model: "test/test-model",
  isError: false,
};

const ERROR_RESULT: SubagentResult = {
  output: "Something broke",
  usage: {
    input: 5,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.0005,
    turns: 1,
  },
  model: undefined,
  isError: true,
  errorMessage: "API rate limit exceeded",
};

const EMPTY_OUTPUT_RESULT: SubagentResult = {
  output: "",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  },
  model: undefined,
  isError: false,
};

const ZERO_USAGE_RESULT: SubagentResult = {
  output: "Done",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  },
  model: undefined,
  isError: false,
};

/** Error result whose errorMessage contains an API key — triggers sanitizeOutput. */
const SECRET_ERROR_RESULT: SubagentResult = {
  output: "Some output",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  },
  model: undefined,
  isError: true,
  errorMessage: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
};

// ── Test helpers ──────────────────────────────────────────────────────────

/** Create a controllable promise + resolve/reject pair for one subagent job. */
function createJobControl() {
  let resolve!: (value: SubagentResult) => void;
  let reject!: (reason: unknown) => void;
  const jobPromise = new Promise<SubagentResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, jobPromise };
}

/** Build a minimal ExtensionContext mock suitable for subagent_isolated. */
function mockCtx() {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "test-model" },
    ui: { setStatus: vi.fn() },
  };
}

/** Build a ctx where ui.setStatus throws (stale context simulation). */
function mockStaleCtx() {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "test-model" },
    ui: {
      setStatus: vi.fn().mockImplementation(() => {
        throw new Error("stale context");
      }),
    },
  };
}

/** Build a mock ctx with sessionManager for subagent_with_context tests. */
function mockCtxWithHistory() {
  return {
    cwd: "/tmp",
    sessionManager: {
      getBranch: vi
        .fn()
        .mockReturnValue([
          { type: "message", message: { role: "user", content: "test input" } },
        ]),
    },
    model: { provider: "test", id: "test-model" },
    ui: { setStatus: vi.fn() },
  };
}

/** Return a resolved value for the startSubagentJob mock. */
function mockJobResult(
  jobId: string,
  jobPromise: Promise<SubagentResult>,
  modelLabel = "test/test-model",
) {
  return Promise.resolve({
    jobId,
    jobPromise,
    session: { abort: vi.fn() },
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
    modelLabel,
  });
}

/** Shared globals that must be cleaned between tests */
function cleanGlobals() {
  (globalThis as any).__piSubagenturaPiRef = undefined;
  (globalThis as any).__piSubagenturaInjectCount = 0;
  jobRegistry.clear();
}

/**
 * sendMessage receives `[message]` (an array wrapping a single message) as its
 * first argument — the source code passes `[{ customType, content, display, details }]`.
 * These helpers consistently unwrap it.
 */
function sentMessageAt(api: any, callIndex: number) {
  const batch = api.sendMessage.mock.calls[callIndex][0];
  return Array.isArray(batch) ? batch[0] : batch;
}

function sentMessageOptsAt(api: any, callIndex: number) {
  return api.sendMessage.mock.calls[callIndex][1];
}

// ===========================================================================
// Tests
// ===========================================================================

describe("notifyOnComplete", () => {
  let api: ReturnType<typeof setupExtension>["api"];
  let isolatedToolDef: any;
  let contextToolDef: any;
  let statusToolDef: any;

  /** Build the minimal ExtensionAPI mock and register the extension. */
  function setupExtension() {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };

    registerExtension(_api as any);

    const isolatedDef = _api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "subagent_isolated",
    )?.[0];

    const contextDef = _api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "subagent_with_context",
    )?.[0];

    const statusDef = _api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "get_subagent_status",
    )?.[0];

    return {
      api: _api,
      isolatedToolDef: isolatedDef,
      contextToolDef: contextDef,
      statusToolDef: statusDef,
    };
  }

  beforeEach(() => {
    mockStartSubagentJob.mockReset(); // clear stale mockImplementationOnce handlers
    vi.clearAllMocks();
    cleanGlobals();

    const setup = setupExtension();
    api = setup.api;
    isolatedToolDef = setup.isolatedToolDef;
    contextToolDef = setup.contextToolDef;
    statusToolDef = setup.statusToolDef;

    // Guard: ensure tools were captured
    expect(isolatedToolDef).toBeDefined();
    expect(contextToolDef).toBeDefined();
    expect(statusToolDef).toBeDefined();
  });

  afterEach(() => {
    cleanGlobals();
  });

  // ── Notification delivery (both tools) ──────────────────────────────
  // Key delivery assertions run for both subagent_isolated and subagent_with_context
  describe("both tools deliver notifications", () => {
    const toolCases = [
      ["subagent_isolated", () => isolatedToolDef, () => mockCtx()] as const,
      [
        "subagent_with_context",
        () => contextToolDef,
        () => mockCtxWithHistory(),
      ] as const,
    ];

    for (const [label, getToolDef, getCtx] of toolCases) {
      describe(label, () => {
        it("sends a summary notification with customType subagent-notify when job completes", async () => {
          const toolDef = getToolDef();
          const jobId = `both-notify-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          await toolDef.execute(
            "call-1",
            { async: true, task: "test", notifyOnComplete: "notify" },
            undefined,
            undefined,
            getCtx(),
          );

          control.resolve(SUCCESS_RESULT);

          await vi.waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
          });

          const msg = sentMessageAt(api, 0);
          const opts = sentMessageOptsAt(api, 0);

          expect(msg).toMatchObject({
            customType: "subagent-notify",
            display: true,
            details: { jobId, mode: "notify" },
          });
          expect(msg.content).toContain(jobId);
          expect(msg.content).toContain("✅");
          expect(opts).toMatchObject({ deliverAs: "followUp" });
          expect(api.sendUserMessage).not.toHaveBeenCalled();
        });

        it("injects full result in inject mode", async () => {
          const toolDef = getToolDef();
          const jobId = `both-inject-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          await toolDef.execute(
            "call-2",
            { async: true, task: "test", notifyOnComplete: "inject" },
            undefined,
            undefined,
            getCtx(),
          );

          control.resolve(SUCCESS_RESULT);

          await vi.waitFor(() => {
            expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
          });

          const [userContent, userOpts] = api.sendUserMessage.mock.calls[0];
          expect(userContent).toBe(SUCCESS_RESULT.output);
          expect(userOpts).toMatchObject({ deliverAs: "followUp" });

          const msg = sentMessageAt(api, 0);
          const msgOpts = sentMessageOptsAt(api, 0);
          expect(msg).toMatchObject({
            customType: "subagent-notify",
            display: true,
            details: { jobId, mode: "inject" },
          });
          expect(msg.content).toContain("result injected above");
          expect(msgOpts).toMatchObject({ deliverAs: "followUp" });
        });

        it("delivers notification when job promise rejects", async () => {
          const toolDef = getToolDef();
          const jobId = `both-reject-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          await toolDef.execute(
            "call-3",
            { async: true, task: "test", notifyOnComplete: "notify" },
            undefined,
            undefined,
            getCtx(),
          );

          control.reject(new Error("Connection timeout"));

          await vi.waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
          });

          const msg = sentMessageAt(api, 0);
          expect(msg.content).toContain("❌");
          expect(msg.content).toContain("Connection timeout");
          expect(msg.details).toMatchObject({ jobId, mode: "notify" });
        });
      });
    }
  });

  // ── Notify mode ───────────────────────────────────────────────────
  describe("notify mode", () => {
    it("sends a summary notification with customType subagent-notify when job completes", async () => {
      const jobId = "notify-test-1";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      // Fire execute — triggers async subagent spawn, returns immediately
      await isolatedToolDef.execute(
        "call-1",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Complete the subagent job
      control.resolve(SUCCESS_RESULT);

      // Wait for the .then() handler and deliverNotification to run
      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const msg = sentMessageAt(api, 0);
      const opts = sentMessageOptsAt(api, 0);

      // Notification shape
      expect(msg).toMatchObject({
        customType: "subagent-notify",
        display: true,
        details: { jobId, mode: "notify" },
      });
      // Content includes a status emoji and the job id
      expect(msg.content).toContain(jobId);
      expect(msg.content).toContain("✅");

      // Delivered as followUp
      expect(opts).toMatchObject({ deliverAs: "followUp" });

      // sendUserMessage should never be called in notify mode
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    });

    it("includes usage info in the summary when usage is non-zero", async () => {
      const jobId = "notify-usage";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-2",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const content: string = sentMessageAt(api, 0).content;
      // formatUsage for SUCCESS_RESULT produces: "1 turn ↑10 ↓50 $0.0010 test/test-model"
      expect(content).toContain("1 turn");
      expect(content).toContain("↑10");
      expect(content).toContain("↓50");
      expect(content).toContain("$0.0010");
    });
  });

  // ── Inject mode ───────────────────────────────────────────────────
  describe("inject mode", () => {
    it("injects the full result via sendUserMessage and sends a summary notification", async () => {
      const jobId = "inject-test-1";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-3",
        { async: true, task: "test", notifyOnComplete: "inject" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      // Expect both sendUserMessage + sendMessage (summary)
      await vi.waitFor(() => {
        expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      // sendUserMessage receives the full output
      const [userContent, userOpts] = api.sendUserMessage.mock.calls[0];
      expect(userContent).toBe(SUCCESS_RESULT.output);
      expect(userOpts).toMatchObject({ deliverAs: "followUp" });

      // sendMessage summary notification
      const msg = sentMessageAt(api, 0);
      const msgOpts = sentMessageOptsAt(api, 0);
      expect(msg).toMatchObject({
        customType: "subagent-notify",
        display: true,
        details: { jobId, mode: "inject" },
      });
      expect(msg.content).toContain("result injected above");
      expect(msgOpts).toMatchObject({ deliverAs: "followUp" });
    });

    it("degrades to notify mode when inject cap is exceeded", async () => {
      // Set inject count past the cap BEFORE the job completes
      (globalThis as any).__piSubagenturaInjectCount = MAX_INJECT;

      const jobId = "inject-cap";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-4",
        { async: true, task: "test", notifyOnComplete: "inject" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      // Degrade: only sendMessage (notify-style), NO sendUserMessage
      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      expect(api.sendUserMessage).not.toHaveBeenCalled();

      // The degrade notification mentions "Inject cap exceeded"
      const msg = sentMessageAt(api, 0);
      expect(msg.content).toContain("Inject cap exceeded");
      expect(msg.details).toMatchObject({ mode: "notify", jobId });
    });

    it("allows more than five sequential inject completions because the cap is concurrent, not lifetime", async () => {
      for (let i = 0; i < MAX_INJECT + 1; i++) {
        const jobId = `inject-sequential-${i}`;
        const control = createJobControl();
        mockStartSubagentJob.mockImplementationOnce(() =>
          mockJobResult(jobId, control.jobPromise),
        );

        await isolatedToolDef.execute(
          `call-sequential-${i}`,
          { async: true, task: "test", notifyOnComplete: "inject" },
          undefined,
          undefined,
          mockCtx(),
        );

        control.resolve({ ...SUCCESS_RESULT, output: `done ${i}` });

        await vi.waitFor(() => {
          expect(api.sendUserMessage).toHaveBeenCalledTimes(i + 1);
          expect(api.sendMessage).toHaveBeenCalledTimes(i + 1);
        });
      }

      expect(getInjectCount()).toBe(0);
    });

    it("uses fallback text when output is empty in inject mode", async () => {
      const jobId = "inject-empty";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-5",
        { async: true, task: "test", notifyOnComplete: "inject" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(EMPTY_OUTPUT_RESULT);

      await vi.waitFor(() => {
        expect(api.sendUserMessage).toHaveBeenCalledTimes(1);
      });

      // Fallback "(sub-agent produced no output)" is used instead of empty string
      const [userContent] = api.sendUserMessage.mock.calls[0];
      expect(userContent).toBe("(sub-agent produced no output)");
    });
  });

  describe("async status", () => {
    it("shows the resolved async job model instead of the parent model", async () => {
      const jobId = "status-override-model";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(
          jobId,
          control.jobPromise,
          "override/provider-model",
        ),
      );

      await isolatedToolDef.execute(
        "call-status-model",
        { async: true, task: "test", model: "override/provider-model" },
        undefined,
        undefined,
        mockCtx(),
      );

      const result = await statusToolDef.execute(
        "call-get-status",
        { jobId },
        undefined,
        undefined,
        mockCtx(),
      );

      expect((result.details as Record<string, unknown>).model).toBe(
        "override/provider-model",
      );

      control.resolve(SUCCESS_RESULT);
    });
  });

  // ── Suppression gates ─────────────────────────────────────────────
  describe("suppression gates", () => {
    it("does NOT deliver notification when job is cancelled before completion", async () => {
      const jobId = "cancel-suppress";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-6",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Mark the job as cancelled BEFORE resolving the promise.
      // The .then() handler checks jobState.status === "cancelled" and returns early.
      const jobState = jobRegistry.get(jobId)!;
      expect(jobState).toBeDefined();
      jobState.status = "cancelled";

      // Resolve — the check at the top of the success handler should bail out
      control.resolve(SUCCESS_RESULT);

      // Let microtasks settle, then assert nothing was sent
      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
          expect(api.sendUserMessage).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });

    it("does NOT deliver notification when result was retrieved before completion", async () => {
      const jobId = "retrieve-suppress";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-7",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Simulate get_subagent_result having been called: set resultRetrieved
      const jobState = jobRegistry.get(jobId)!;
      expect(jobState).toBeDefined();
      jobState.resultRetrieved = true;

      control.resolve(SUCCESS_RESULT);

      // The delivery guard checks !jobState.resultRetrieved and skips
      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
          expect(api.sendUserMessage).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });

    it("suppresses inject notification when result was retrieved before completion", async () => {
      const jobId = "retrieve-inject-suppress";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-8",
        { async: true, task: "test", notifyOnComplete: "inject" },
        undefined,
        undefined,
        mockCtx(),
      );

      const jobState = jobRegistry.get(jobId)!;
      jobState.resultRetrieved = true;

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
          expect(api.sendUserMessage).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });
  });

  // ── Error handling ────────────────────────────────────────────────
  describe("error handling", () => {
    it("includes error message in notification when sub-agent returns isError", async () => {
      const jobId = "error-result";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-9",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(ERROR_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const msg = sentMessageAt(api, 0);
      // Error state is reflected in the content
      expect(msg.content).toContain("❌");
      expect(msg.content).toContain(ERROR_RESULT.errorMessage);
      expect(msg.details).toMatchObject({ jobId, mode: "notify" });
    });

    it("delivers notification via promise rejection handler when the job promise rejects", async () => {
      const jobId = "promise-reject";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-10",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Reject the promise instead of resolving
      control.reject(new Error("Connection timeout"));

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const msg = sentMessageAt(api, 0);
      expect(msg.content).toContain("❌");
      expect(msg.content).toContain("Connection timeout");
      expect(msg.details).toMatchObject({ jobId, mode: "notify" });
    });

    it("does NOT deliver via rejection handler if notification already delivered", async () => {
      const jobId = "double-deliver-guard";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-11",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Set notificationDelivered BEFORE settling
      const jobState = jobRegistry.get(jobId)!;
      jobState.notificationDelivered = true;

      control.reject(new Error("Timeout"));

      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });
  });

  // ── Backward compatibility ────────────────────────────────────────
  describe("backward compatibility", () => {
    it("does NOT fire any notification when notifyOnComplete is omitted", async () => {
      const jobId = "no-notify";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-12",
        { async: true, task: "test" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
          expect(api.sendUserMessage).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("fires notification with fallback message when output is empty in notify mode", async () => {
      const jobId = "empty-output-notify";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-13",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Empty output — NOT ZERO_USAGE_RESULT which has output "Done"
      control.resolve(EMPTY_OUTPUT_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const msg = sentMessageAt(api, 0);
      // buildNotifySummary uses "done" for non-error results
      expect(msg.content).toContain("✅");
      expect(msg.content).toContain(jobId);
      expect(msg.content).toContain("done");
    });

    it("sanitizes sensitive tokens in notification content via errorMessage", async () => {
      const jobId = "sanitize";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-14",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Use isError: true result where errorMessage contains an API key
      // This ensures sanitizeOutput actually runs (it runs on errorMessage for isError results)
      control.resolve(SECRET_ERROR_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const msg = sentMessageAt(api, 0);
      // The raw secret must NOT appear in the output
      expect(msg.content).not.toContain(
        "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
      );
      // sanitizeOutput replaces it with [REDACTED]
      expect(msg.content).toContain("[REDACTED]");
      expect(msg.content).toContain(jobId);
    });

    it("handles multiple concurrent async subagents with independent notifications", async () => {
      const jobId1 = "multi-1";
      const jobId2 = "multi-2";
      const control1 = createJobControl();
      const control2 = createJobControl();

      // Use single mockImplementation with counter instead of mockImplementationOnce
      // to avoid fallback to real implementation if a third call were made
      const callResults = [
        () => mockJobResult(jobId1, control1.jobPromise),
        () => mockJobResult(jobId2, control2.jobPromise),
      ];
      mockStartSubagentJob.mockImplementation(() => callResults.shift()!());

      // Spawn two concurrent subagents
      await Promise.all([
        isolatedToolDef.execute(
          "call-15",
          { async: true, task: "test-1", notifyOnComplete: "notify" },
          undefined,
          undefined,
          mockCtx(),
        ),
        isolatedToolDef.execute(
          "call-16",
          { async: true, task: "test-2", notifyOnComplete: "notify" },
          undefined,
          undefined,
          mockCtx(),
        ),
      ]);

      // Resolve both
      control1.resolve(SUCCESS_RESULT);
      control2.resolve(ERROR_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
      });

      const msg1 = sentMessageAt(api, 0);
      const msg2 = sentMessageAt(api, 1);

      expect(msg1.details.jobId).toBe(jobId1);
      expect(msg1.content).toContain("✅");

      expect(msg2.details.jobId).toBe(jobId2);
      expect(msg2.content).toContain("❌");
    });

    it("does NOT deliver notification when __piSubagenturaPiRef is stale (null/undefined)", async () => {
      const jobId = "stale-pi-ref";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-stale-pi",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Clear the pi ref — deliverNotification checks !pi and returns early
      (globalThis as any).__piSubagenturaPiRef = undefined;

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });

    it("delivers notification even when ctx is stale (ui.setStatus throws)", async () => {
      const jobId = "stale-ctx";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      // Use a ctx where ui.setStatus throws synchronously
      // The .then() handler wraps ctx.ui.setStatus in try/catch, so the
      // execution continues and deliverNotification (which uses pi, not ctx) still fires.
      await isolatedToolDef.execute(
        "call-stale-ctx",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockStaleCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const msg = sentMessageAt(api, 0);
      expect(msg.content).toContain("✅");
      expect(msg.content).toContain(jobId);
      expect(msg.details).toMatchObject({ mode: "notify" });
    });

    it("delivers notification before resultRetrieved can suppress it when get_subagent_result is called after settlement", async () => {
      const jobId = "race-delivers";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-race",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Resolve the promise — .then() callback is queued as a microtask
      control.resolve(SUCCESS_RESULT);

      // Wait for the .then() microtask to fire and deliver the notification
      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      // By now, the notification was already delivered because .then()
      // fires before get_subagent_result can set resultRetrieved.
      // Simulate get_subagent_result being called now (after settlement).
      const jobState = jobRegistry.get(jobId)!;
      jobState.resultRetrieved = true;

      // No double delivery — notificationDelivered guard prevents it
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe("read_subagent_artifact (invalid id)", () => {
  /** Build the minimal ExtensionAPI mock and capture the tool def. */
  function setupReadArtifactTool() {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(_api as any);
    return _api.registerTool.mock.calls.find(([t]: any[]) => t.name === "read_subagent_artifact")?.[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanGlobals();
  });

  afterEach(() => {
    cleanGlobals();
  });

  it("returns status:invalid_id with a precise message for a malformed id", async () => {
    const toolDef = setupReadArtifactTool();
    expect(toolDef).toBeDefined();

    const result = await toolDef.execute("call-malformed", { id: "not-a-hex-id" }, undefined, undefined, {} as any);

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("invalid_id");
    expect(result.details.id).toBe("not-a-hex-id");
    const text = result.content[0].text;
    expect(text).toContain("Invalid sub-agent id");
    expect(text).toContain("not-a-hex-id");
  });
});

describe("read_subagent_artifact (output reporting)", () => {
  function tmp() {
    return mkdtempSync(join(tmpdir(), "pi-subagentura-read-out-"));
  }

  function makeArtifactWithDone(id: string, parentDir: string) {
    const dir = join(parentDir, id);
    const state: import("./interactive-tmux").InteractiveSubagentState = {
      id,
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: "/tmp/sess.jsonl",
      cwd: "/tmp",
      startedAt: 1,
      status: "exited",
      mux: "tmux",
      attachCommand: "tmux attach",
      selectPaneCommand: "tmux select-pane",
      launchScriptFile: "/tmp/launch.sh",
      artifactDir: dir,
    };
    const art = artifactPath(parentDir, id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    return { state, art, dir };
  }

  function makeReadTool(mod: any) {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    (mod as any).default(_api as any);
    return _api.registerTool.mock.calls.find(([t]: any[]) => t.name === "read_subagent_artifact")?.[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanGlobals();
  });

  afterEach(() => {
    cleanGlobals();
  });

  it("reports '(sub-agent exited without writing output.md — last event: done @ <ts>)' when output.md is missing and the agent finished", async () => {
    const id = "ab12cd34";
    const parent = tmp();
    try {
      const { state } = makeArtifactWithDone(id, parent);
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      mod.interactiveSubagentRegistry.set(id, state);
      const readTool = makeReadTool(mod);
      expect(readTool).toBeDefined();

      const result = await readTool.execute("call-1", { id }, undefined, undefined, {} as any);
      const text = result.content[0].text;
      expect(text).toContain("Output: (sub-agent exited without writing output.md");
      expect(text).toContain("last event: done @ 2");
      expect(text).not.toContain("not written yet");
      expect(result.details.output).toBeNull();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports '(<N> events, last: <type> @ <ts> — output.md not written yet)' when output.md is missing and the agent is still running", async () => {
    const id = "ab12cd35";
    const parent = tmp();
    try {
      const dir = join(parent, id);
      const state: import("./interactive-tmux").InteractiveSubagentState = {
        id,
        name: "Test",
        task: "t",
        paneId: "%99",
        sessionFile: "/tmp/sess.jsonl",
        cwd: "/tmp",
        startedAt: 1,
        status: "running",
      mux: "tmux",
        attachCommand: "tmux attach",
        selectPaneCommand: "tmux select-pane",
        launchScriptFile: "/tmp/launch.sh",
        artifactDir: dir,
      };
      const art = artifactPath(parent, id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "tool_activity", status: "running", tool: "bash", summary: "ls" });

      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      mod.interactiveSubagentRegistry.set(id, state);

      const readTool = makeReadTool(mod);
      const result = await readTool.execute("call-2", { id }, undefined, undefined, {} as any);
      const text = result.content[0].text;
      expect(text).toContain("Output: (2 events");
      expect(text).toContain("last: tool_activity @ 2");
      expect(text).toContain("output.md not written yet");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports '(empty — 0 chars)' when output.md exists but is empty", async () => {
    const id = "ab12cd36";
    const parent = tmp();
    try {
      const { state, art } = makeArtifactWithDone(id, parent);
      writeOutput(art, "");

      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      mod.interactiveSubagentRegistry.set(id, state);

      const readTool = makeReadTool(mod);
      const result = await readTool.execute("call-3", { id }, undefined, undefined, {} as any);
      const text = result.content[0].text;
      expect(text).toContain("Output: (empty — 0 chars)");
      expect(result.details.output).toBe("");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports '<N> chars' when output.md has content", async () => {
    const id = "ab12cd37";
    const parent = tmp();
    try {
      const { state, art } = makeArtifactWithDone(id, parent);
      writeOutput(art, "Hello, world!");

      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      mod.interactiveSubagentRegistry.set(id, state);

      const readTool = makeReadTool(mod);
      const result = await readTool.execute("call-4", { id }, undefined, undefined, {} as any);
      const text = result.content[0].text;
      expect(text).toContain("Output: 13 chars");
      expect(result.details.output).toBe("Hello, world!");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
