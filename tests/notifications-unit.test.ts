/**
 * Direct unit tests for deliverNotification from src/notifications.ts.
 *
 * Tests the return value and edge cases that aren't covered through the
 * higher-level subagent tool integration tests in subagent-notify.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobState, SubagentResult } from "../src/helpers";

// ── Imports after global setup ─────────────────────────────────────────
import {
  deliverNotification,
  getInjectCount,
  incrementInjectCount,
  MAX_INJECT,
} from "../src/notifications";

// ── Fixtures ───────────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────

function cleanGlobals() {
  (globalThis as any).__piSubagenturaPiRef = undefined;
  (globalThis as any).__piSubagenturaInjectCount = 0;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("deliverNotification return value", () => {
  beforeEach(() => {
    cleanGlobals();
  });

  afterEach(() => {
    cleanGlobals();
  });

  it("returns false when pi ref is missing", () => {
    const job = makeJobState();
    const result = deliverNotification(job, SUCCESS_RESULT);
    expect(result).toBe(false);
  });

  it("returns true on successful notify delivery", () => {
    const pi = { sendMessage: vi.fn() };
    (globalThis as any).__piSubagenturaPiRef = pi;

    const job = makeJobState({ notifyOnComplete: "notify" });
    const result = deliverNotification(job, SUCCESS_RESULT);

    expect(result).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(job.notificationDelivered).toBe(true);
  });

  it("returns false when sendMessage throws in notify mode", () => {
    const pi = {
      sendMessage: vi.fn().mockImplementation(() => {
        throw new Error("stale context");
      }),
    };
    (globalThis as any).__piSubagenturaPiRef = pi;

    const job = makeJobState({ notifyOnComplete: "notify" });
    const result = deliverNotification(job, SUCCESS_RESULT);

    expect(result).toBe(false);
    expect(job.notificationDelivered).toBeFalsy();
  });

  it("returns false when sendUserMessage is not a function in inject mode", () => {
    const pi = { sendMessage: vi.fn() };
    (globalThis as any).__piSubagenturaPiRef = pi;

    const job = makeJobState({ notifyOnComplete: "inject" });
    const result = deliverNotification(job, SUCCESS_RESULT);

    expect(result).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(getInjectCount()).toBe(0);
  });

  it("returns true on successful inject delivery", () => {
    const pi = { sendMessage: vi.fn(), sendUserMessage: vi.fn() };
    (globalThis as any).__piSubagenturaPiRef = pi;

    const job = makeJobState({ notifyOnComplete: "inject" });
    const result = deliverNotification(job, SUCCESS_RESULT);

    expect(result).toBe(true);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(job.notificationDelivered).toBe(true);
    expect(getInjectCount()).toBe(0); // decremented in finally
  });

  it("returns false when sendUserMessage throws in inject mode", () => {
    const pi = {
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn().mockImplementation(() => {
        throw new Error("injection failed");
      }),
    };
    (globalThis as any).__piSubagenturaPiRef = pi;

    const job = makeJobState({ notifyOnComplete: "inject" });
    const result = deliverNotification(job, SUCCESS_RESULT);

    expect(result).toBe(false);
    expect(getInjectCount()).toBe(0); // still decremented in finally
  });

  it("degrades to notify and returns true when inject cap exceeded", () => {
    const pi = { sendMessage: vi.fn(), sendUserMessage: vi.fn() };
    (globalThis as any).__piSubagenturaPiRef = pi;

    // Set inject count at the cap
    for (let i = 0; i < MAX_INJECT; i++) incrementInjectCount();

    const job = makeJobState({ notifyOnComplete: "inject" });
    const result = deliverNotification(job, SUCCESS_RESULT);

    expect(result).toBe(true);
    // Should NOT call sendUserMessage (degraded to notify)
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    // Should call sendMessage with degrade message
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain(
      "Inject cap exceeded",
    );
    expect(pi.sendMessage.mock.calls[0][0].details.mode).toBe("notify");
  });

  it("returns false when sendMessage throws in inject-cap degrade path", () => {
    const pi = {
      sendMessage: vi.fn().mockImplementation(() => {
        throw new Error("send failed");
      }),
      sendUserMessage: vi.fn(),
    };
    (globalThis as any).__piSubagenturaPiRef = pi;

    // Set inject count at the cap
    for (let i = 0; i < MAX_INJECT; i++) incrementInjectCount();

    const job = makeJobState({ notifyOnComplete: "inject" });
    const result = deliverNotification(job, SUCCESS_RESULT);

    expect(result).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
