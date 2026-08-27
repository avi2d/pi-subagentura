import { afterEach, describe, expect, it, vi } from "vitest";

const { mockDebugLog } = vi.hoisted(() => ({ mockDebugLog: vi.fn() }));

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return { ...actual, debugLog: mockDebugLog };
});
import {
  acknowledgeCompletionTurnWake,
  clearCompletionTurnWake,
  markCompletionTurnWakeStarted,
  ORCHESTRATOR_V2_WAKE_ACK_MAX_ATTEMPTS,
  ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS,
  ORCHESTRATOR_V2_WAKE_DETAIL_KEY,
  ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
  ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS,
  ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS,
  recoverCompletionTurnWakes,
  sendCompletionTurn,
  settleCompletionTurnWake,
} from "../src/completion-turn";

function mockPi() {
  return {
    appendEntry: vi.fn(),
    getFlag: vi.fn((name: string) => name === "orchestratorv2"),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

function completion(content: string) {
  return {
    customType: "subagent-notify",
    content,
    display: true,
    details: { deliveryIds: [`delivery-${content}`] },
  };
}

describe("Orchestratorv2 completion turns", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockDebugLog.mockClear();
  });

  it("coalesces concurrent completions and bounds a missing wake start", () => {
    vi.useFakeTimers();
    const pi = mockPi();

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });

    expect(pi.appendEntry).toHaveBeenCalledOnce();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "requested" }),
    );
    const firstWakeId =
      pi.sendMessage.mock.calls[0][0].details[ORCHESTRATOR_V2_WAKE_DETAIL_KEY];
    expect(pi.sendMessage.mock.calls[1][0].details).toMatchObject({
      [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: firstWakeId,
    });
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS - 1);
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(
      ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS *
        (ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS - 1),
    );
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(
      ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS,
    );

    acknowledgeCompletionTurnWake(pi as never);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({
        state: "acknowledged",
        wakeIds: [firstWakeId],
      }),
    );
  });

  it("retains the wake until its durable acknowledgement succeeds", () => {
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("transient append failure");
    });

    acknowledgeCompletionTurnWake(pi as never);
    acknowledgeCompletionTurnWake(pi as never);

    expect(mockDebugLog).toHaveBeenCalledOnce();
    expect(mockDebugLog).toHaveBeenCalledWith(
      "error",
      "orchestratorv2_wake_ack_failed",
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(pi.appendEntry).toHaveBeenCalledTimes(3);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged" }),
    );
    acknowledgeCompletionTurnWake(pi as never);
    expect(pi.appendEntry).toHaveBeenCalledTimes(3);
  });

  it("allows a later completion to re-wake after repeated acknowledgement failures", () => {
    const pi = mockPi();
    mockDebugLog.mockClear();

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakeId =
      pi.sendMessage.mock.calls[0][0].details[ORCHESTRATOR_V2_WAKE_DETAIL_KEY];
    for (let attempt = 0; attempt < 2; attempt++) {
      pi.appendEntry.mockImplementationOnce(() => {
        throw new Error("transient append failure");
      });
      acknowledgeCompletionTurnWake(pi as never);
    }

    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendMessage.mock.calls[1][0].details).toMatchObject({
      [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: wakeId,
    });
    expect(
      pi.appendEntry.mock.calls.filter(
        ([customType, entry]) =>
          customType === ORCHESTRATOR_V2_WAKE_ENTRY_TYPE &&
          entry.state === "requested",
      ),
    ).toHaveLength(1);
    acknowledgeCompletionTurnWake(pi as never);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged", wakeIds: [wakeId] }),
    );
  });

  it("does not acknowledge unrelated runs and requires the exact wake prompt", () => {
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakePrompt = pi.sendUserMessage.mock.calls[0][0];

    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    expect(
      markCompletionTurnWakeStarted(pi as never, `${wakePrompt} extra`),
    ).toBe(false);
    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    expect(pi.appendEntry).toHaveBeenCalledOnce();

    expect(markCompletionTurnWakeStarted(pi as never, wakePrompt)).toBe(true);
    expect(settleCompletionTurnWake(pi as never)).toBe(true);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged" }),
    );
  });
  it("retries a transient acknowledgement failure without replaying the wake", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakePrompt = pi.sendUserMessage.mock.calls[0][0];
    expect(markCompletionTurnWakeStarted(pi as never, wakePrompt)).toBe(true);
    pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("transient append failure");
    });

    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS);

    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged" }),
    );
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("starts a fresh wake for a completion arriving during ack retry", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const firstWakePrompt = pi.sendUserMessage.mock.calls[0][0];
    expect(markCompletionTurnWakeStarted(pi as never, firstWakePrompt)).toBe(
      true,
    );
    pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("transient append failure");
    });
    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendUserMessage.mock.calls[1][0]).toBe(firstWakePrompt);

    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    const secondWakePrompt = pi.sendUserMessage.mock.calls[1][0];
    expect(markCompletionTurnWakeStarted(pi as never, secondWakePrompt)).toBe(
      true,
    );
    expect(settleCompletionTurnWake(pi as never)).toBe(true);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds acknowledgement retries and lets a later completion wake again", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakePrompt = pi.sendUserMessage.mock.calls[0][0];
    expect(markCompletionTurnWakeStarted(pi as never, wakePrompt)).toBe(true);
    pi.appendEntry.mockImplementation(() => {
      throw new Error("persistent append failure");
    });

    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    vi.advanceTimersByTime(
      ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS *
        (ORCHESTRATOR_V2_WAKE_ACK_MAX_ATTEMPTS + 2),
    );
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    clearCompletionTurnWake(pi as never);
  });

  it("cancels a pending acknowledgement retry on clear", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakePrompt = pi.sendUserMessage.mock.calls[0][0];
    markCompletionTurnWakeStarted(pi as never, wakePrompt);
    pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("transient append failure");
    });
    settleCompletionTurnWake(pi as never);
    expect(vi.getTimerCount()).toBe(1);

    clearCompletionTurnWake(pi as never);
    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("retries swallowed async wake failures up to a cap, then retries a later completion", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    pi.sendUserMessage.mockImplementation(() =>
      Promise.reject(new Error("preflight failed")),
    );

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();

    for (
      let attempt = 1;
      attempt < ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS;
      attempt++
    ) {
      vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS);
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(attempt + 1);
    }
    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS * 2);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(
      ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS,
    );

    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(
      ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS + 1,
    );

    clearCompletionTurnWake(pi as never);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the wake watchdog when the exact run starts and settles", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(vi.getTimerCount()).toBe(1);

    const wakePrompt = pi.sendUserMessage.mock.calls[0][0];
    expect(markCompletionTurnWakeStarted(pi as never, wakePrompt)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(settleCompletionTurnWake(pi as never)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses native custom-message delivery when Orchestratorv2 is disabled", () => {
    const pi = mockPi();
    pi.getFlag.mockReturnValue(false);

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "one" }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("recovers a durable delivered wake idempotently but ignores an acknowledged one", () => {
    const wakeId = "12345678-1234-1234-9234-123456789abc";
    const entries = [
      {
        type: "custom",
        customType: ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
        data: { schemaVersion: 1, state: "requested", wakeId },
      },
      {
        type: "custom_message",
        details: { [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: wakeId },
      },
    ];
    const pendingPi = mockPi();

    expect(recoverCompletionTurnWakes(pendingPi as never, entries)).toBe(true);
    expect(recoverCompletionTurnWakes(pendingPi as never, entries)).toBe(true);
    expect(pendingPi.sendUserMessage).toHaveBeenCalledOnce();
    clearCompletionTurnWake(pendingPi as never);

    const acknowledgedPi = mockPi();
    expect(
      recoverCompletionTurnWakes(acknowledgedPi as never, [
        ...entries,
        {
          type: "custom",
          customType: ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
          data: {
            schemaVersion: 1,
            state: "acknowledged",
            wakeIds: [wakeId],
          },
        },
      ]),
    ).toBe(false);
    expect(acknowledgedPi.sendUserMessage).not.toHaveBeenCalled();
  });
});
