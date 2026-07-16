import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobState, SubagentResult } from "../src/helpers";
import {
  deliverNotification,
  flushInProcessDeliveries,
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
  globalState.__piSubagenturaParentStreaming = false;
  globalState.__piSubagenturaPendingJobDeliveries = [];
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

  it("retains a failed dispatch and retries it with a fresh context", () => {
    const staleSend = vi.fn(() => {
      throw new Error("stale context");
    });
    (globalThis as any).__piSubagenturaPiRef = { sendMessage: staleSend };
    const job = makeJobState();

    deliverNotification(job, SUCCESS_RESULT);
    expect(staleSend).toHaveBeenCalledOnce();
    expect(job.notificationDelivered).toBeFalsy();

    const freshSend = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage: freshSend };
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

  it("waits for the parent to become idle before dispatching", () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    (globalThis as any).__piSubagenturaParentStreaming = true;
    const job = makeJobState({ notifyOnComplete: "inject" });

    deliverNotification(job, SUCCESS_RESULT);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBeFalsy();

    (globalThis as any).__piSubagenturaParentStreaming = false;
    flushInProcessDeliveries();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(job.notificationDelivered).toBe(true);
  });
});
