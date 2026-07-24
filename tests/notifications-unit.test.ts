import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jobRegistry,
  type JobState,
  type SubagentResult,
} from "../src/helpers";
import {
  deliverArtifactNotification,
  deliverNotification,
  flushInProcessDeliveries,
  getInjectCount,
  sanitizeOutput,
  shouldNotify,
} from "../src/notifications";

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

function makeJobState(overrides?: Partial<JobState>): JobState {
  return {
    id: "test-job-1",
    status: "done",
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
    session: { abort: vi.fn() } as any,
    promise: Promise.resolve(SUCCESS_RESULT),
    startedAt: Date.now(),
    notifyOnComplete: "notify",
    ...overrides,
  };
}

function cleanGlobals() {
  const globalState = globalThis as any;
  globalState.__piSubagenturaPiRef = undefined;
  globalState.__piSubagenturaUi = undefined;
  globalState.__piSubagenturaSessionManager = undefined;
  globalState.__piSubagenturaActiveSessionContextId = undefined;
  globalState.__piSubagenturaParentStreaming = false;
  globalState.__piSubagenturaPendingJobDeliveries = [];
  globalState.__piSubagenturaInProcessFlushScheduled = false;
  jobRegistry.clear();
}

describe("in-process completion delivery queue", () => {
  beforeEach(cleanGlobals);
  afterEach(cleanGlobals);

  it("does nothing when the extension context is unavailable", () => {
    const job = makeJobState();

    expect(deliverNotification(job, SUCCESS_RESULT)).toBeUndefined();
    expect(job.notificationDelivered).toBeFalsy();
  });

  it("delivers notify mode as a pointer-only custom message", () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    const job = makeJobState({ notifyOnComplete: "notify" });

    deliverNotification(job, SUCCESS_RESULT);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).not.toContain(
      SUCCESS_RESULT.output,
    );
    expect(sendMessage.mock.calls[0][0].details.mode).toBe("notify");
    expect(job.notificationDelivered).toBe(true);
  });

  it("reports other running in-process jobs in completion messages", () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    jobRegistry.set(
      "still-running",
      makeJobState({ id: "still-running", status: "running" }),
    );

    deliverNotification(makeJobState(), SUCCESS_RESULT);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "1 in-process sub-agent job is still running",
    );
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "Do not claim all review work is complete yet",
    );
    expect(sendMessage.mock.calls[0][0].details.remainingRunningJobs).toBe(1);
  });

  it("retains a failed dispatch and retries it with a fresh context", () => {
    const staleSend = vi.fn(() => {
      throw new Error("stale context");
    });
    const pi: { sendMessage: (...args: any[]) => any } = {
      sendMessage: staleSend,
    };
    (globalThis as any).__piSubagenturaPiRef = pi;
    const job = makeJobState();

    deliverNotification(job, SUCCESS_RESULT);
    expect(staleSend).toHaveBeenCalledOnce();
    expect(job.notificationDelivered).toBeFalsy();

    const freshSend = vi.fn();
    pi.sendMessage = freshSend;
    (globalThis as any).__piSubagenturaPiRef = pi;
    flushInProcessDeliveries();

    expect(freshSend).toHaveBeenCalledOnce();
    expect(job.notificationDelivered).toBe(true);
  });

  it("delivers inject mode in one attributed custom message", () => {
    const sendMessage = vi.fn();
    const sendUserMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = {
      sendMessage,
      sendUserMessage,
    };
    const job = makeJobState({
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
    });

    deliverNotification(job, SUCCESS_RESULT);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain(
      SUCCESS_RESULT.output,
    );
    expect(sendMessage.mock.calls[0][0].details.mode).toBe("inject");
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBe(true);
  });

  it("dispatches triggering completion through native followUp while streaming", async () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    (globalThis as any).__piSubagenturaParentStreaming = true;
    const job = makeJobState({ notifyOnComplete: "inject" });

    deliverNotification(job, SUCCESS_RESULT);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    expect(job.notificationDelivered).toBe(true);
  });

  it("waits for idle when completion must not trigger a turn", async () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    (globalThis as any).__piSubagenturaParentStreaming = true;
    const job = makeJobState({ notifyOnComplete: "notify" });

    deliverNotification(job, SUCCESS_RESULT);
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBeFalsy();

    (globalThis as any).__piSubagenturaParentStreaming = false;
    flushInProcessDeliveries();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: false,
    });
    expect(job.notificationDelivered).toBe(true);
  });

  it("does not deliver a queued completion into a replacement parent session", async () => {
    const firstSessionSend = vi.fn();
    const secondSessionSend = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = {
      sendMessage: firstSessionSend,
    };
    (globalThis as any).__piSubagenturaSessionManager = {
      getSessionId: () => "parent-session-a",
    };
    (globalThis as any).__piSubagenturaParentStreaming = true;
    const job = makeJobState({ notifyOnComplete: "notify" });

    deliverNotification(job, SUCCESS_RESULT);
    await Promise.resolve();
    expect(firstSessionSend).not.toHaveBeenCalled();

    (globalThis as any).__piSubagenturaPiRef = {
      sendMessage: secondSessionSend,
    };
    (globalThis as any).__piSubagenturaSessionManager = {
      getSessionId: () => "parent-session-b",
    };
    (globalThis as any).__piSubagenturaParentStreaming = false;
    flushInProcessDeliveries();

    expect(secondSessionSend).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBeFalsy();
  });

  it("does not deliver a queued completion into a replacement session context", async () => {
    const firstSessionSend = vi.fn();
    const secondSessionSend = vi.fn();
    const globalState = globalThis as any;
    globalState.__piSubagenturaActiveSessionContextId = 1;
    globalState.__piSubagenturaPiRef = {
      sendMessage: firstSessionSend,
    };
    globalState.__piSubagenturaSessionManager = {
      getSessionId: () => "parent-session-a",
    };
    globalState.__piSubagenturaParentStreaming = true;
    const job = makeJobState({ notifyOnComplete: "notify" });

    deliverNotification(job, SUCCESS_RESULT);
    await Promise.resolve();
    expect(firstSessionSend).not.toHaveBeenCalled();

    globalState.__piSubagenturaActiveSessionContextId = 2;
    globalState.__piSubagenturaPiRef = {
      sendMessage: secondSessionSend,
    };
    globalState.__piSubagenturaSessionManager = {
      getSessionId: () => "parent-session-a",
    };
    globalState.__piSubagenturaParentStreaming = false;
    flushInProcessDeliveries();

    expect(secondSessionSend).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBeFalsy();
  });
});

describe("artifact notification compatibility", () => {
  const state = {
    id: "child-1",
    name: "Reviewer",
    artifactDir: "/tmp/artifacts/child-1",
    notifyOnComplete: "notify",
    triggerTurnOnComplete: true,
  } as any;

  it("retains the deprecated zero inject-count API", () => {
    expect(getInjectCount()).toBe(0);
  });

  it("sanitizes secrets and identifies terminal notification events", () => {
    expect(sanitizeOutput(`token sk-${"a".repeat(24)}`)).toBe(
      "token [REDACTED]",
    );
    expect(shouldNotify({ type: "started", ts: 1, status: "running" })).toBe(
      false,
    );
    expect(
      shouldNotify({
        version: 2,
        eventId: "event-1",
        turnId: "turn-1",
        ts: 2,
        type: "completion",
        status: "done",
        outcome: "done",
        source: "agent_settled",
      }),
    ).toBe(true);
  });

  it("builds and sends pointer notifications for legacy terminal events", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage };

    expect(
      deliverArtifactNotification(pi as any, state, {
        type: "done",
        ts: 2,
        status: "done",
        exitCode: 0,
      }),
    ).toBe(true);
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "✅ Reviewer (child-1) — done (exit 0)",
    );
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });

    expect(
      deliverArtifactNotification(pi as any, state, {
        type: "error",
        ts: 3,
        status: "error",
        message: `failed with sk-${"b".repeat(24)}`,
      }),
    ).toBe(true);
    expect(sendMessage.mock.calls[1][0].content).toContain("[REDACTED]");
  });

  it("formats protocol-v2 and process lifecycle pointers", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage };
    const events = [
      {
        version: 2,
        eventId: "turn-started",
        turnId: "turn-1",
        ts: 4,
        type: "turn_started",
        status: "running",
      },
      {
        version: 2,
        eventId: "completion",
        turnId: "turn-1",
        ts: 5,
        type: "completion",
        status: "cancelled",
        outcome: "cancelled",
        source: "parent",
      },
      {
        version: 2,
        eventId: "process-exit",
        ts: 6,
        type: "process_exited",
        status: "error",
        exitCode: 1,
      },
      { type: "started", ts: 7, status: "running" },
      {
        type: "tool_activity",
        ts: 8,
        status: "running",
        tool: "read",
      },
      { type: "done", ts: 9, status: "done", exitCode: 1 },
      {
        version: 2,
        eventId: "completion-error",
        turnId: "turn-2",
        ts: 10,
        type: "completion",
        status: "error",
        outcome: "error",
        source: "agent_settled",
      },
      {
        version: 2,
        eventId: "process-success",
        ts: 11,
        type: "process_exited",
        status: "done",
        exitCode: 0,
      },
      { type: "error", ts: 12, status: "error" },
    ];

    for (const event of events) {
      expect(deliverArtifactNotification(pi as any, state, event as any)).toBe(
        true,
      );
    }

    expect(sendMessage.mock.calls.map((call) => call[0].content)).toEqual([
      expect.stringContaining("▶ Reviewer (child-1) — started"),
      expect.stringContaining("🚫 Reviewer (child-1) — cancelled"),
      expect.stringContaining("❌ Reviewer (child-1) — process exited (1)"),
      expect.stringContaining("▶ Reviewer (child-1) — started"),
      expect.stringContaining("▶ Reviewer (child-1) — activity"),
      expect.stringContaining("❌ Reviewer (child-1) — done (exit 1)"),
      expect.stringContaining("❌ Reviewer (child-1) — error"),
      expect.stringContaining("✅ Reviewer (child-1) — process exited (0)"),
      expect.stringContaining("❌ Reviewer (child-1) — error"),
    ]);
  });

  it("returns false for stale contexts and unsupported events", () => {
    expect(
      deliverArtifactNotification(
        {
          sendMessage: () => {
            throw new Error("stale context");
          },
        } as any,
        state,
        { type: "cancelled", ts: 4, status: "cancelled" },
      ),
    ).toBe(false);
    expect(
      deliverArtifactNotification({ sendMessage: vi.fn() } as any, state, {
        type: "unsupported",
      } as any),
    ).toBe(false);
  });
});
