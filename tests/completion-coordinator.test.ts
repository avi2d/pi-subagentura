import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import {
  clearCompletionCoordinator,
  MAX_COMPLETION_RECORDS,
  assertCompletionGroupOpen,
  consumeCompletionSource,
  flushCompletionManifests,
  markCompletionHumanInput,
  markCompletionTurnStarting,
  prepareCompletionManifest,
  publishCompletion,
  registerCompletionCoordinator,
  registerCompletionMember,
  reserveCompletionGroup,
  resolveCompletionPolicy,
  sealCompletionGroups,
  settleCompletionParentTurn,
  type CompletionRecord,
} from "../src/completion-coordinator";
import { sessionLedgerPath } from "../src/completion-ledger";

function record(
  sourceId: string,
  overrides: Partial<CompletionRecord> = {},
): CompletionRecord {
  return {
    schemaVersion: 1,
    completionId: `completion-${sourceId}`,
    source: "interactive",
    sourceId,
    turnId: `turn-${sourceId}`,
    label: `Agent ${sourceId}`,
    status: "done",
    policy: "each",
    references: [
      {
        label: "output",
        value: `/tmp/artifacts/${sourceId}/outputs/event-${sourceId}.md`,
      },
      {
        label: "events",
        value: `/tmp/artifacts/${sourceId}/events.ndjson`,
      },
    ],
    completedAt: 1,
    ...overrides,
  };
}

function setup() {
  const entries: any[] = [];
  const handlers = new Map<string, Function[]>();
  const pi = {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    registerEntryRenderer: vi.fn(),
    sendMessage: vi.fn((message: any) => {
      entries.push({ type: "custom_message", ...message });
    }),
    on: vi.fn((name: string, handler: Function) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    }),
  };
  const scope = registerSessionScope({
    id: 1,
    generation: 1,
    lifecycle: "started",
    pi: pi as never,
    sessionManager: {
      getSessionId: () => "parent-session",
      getEntries: () => entries,
    },
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map(),
  });
  registerCompletionCoordinator(pi as never, scope);
  return { entries, handlers, pi, scope };
}

function manifests(pi: { sendMessage: ReturnType<typeof vi.fn> }) {
  return pi.sendMessage.mock.calls.filter(
    ([message]) => message.customType === "subagent-manifest",
  );
}

function userCompletions(entries: any[]) {
  return entries.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === "subagentura-completion",
  );
}

describe("completion coordinator", () => {
  let scope: SessionScope;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (scope) clearCompletionCoordinator(sessionOwner(scope));
    clearSessionScopes();
    vi.useRealTimers();
  });

  it("notifies the user once and sends one independent reference manifest", () => {
    const setupResult = setup();
    scope = setupResult.scope;

    publishCompletion(record("a"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));
    publishCompletion(record("a"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)).toHaveLength(1);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    const [message, options] = manifests(setupResult.pi)[0];
    expect(message.content).toContain("outputs/event-a.md");
    expect(message.content).not.toContain("<untrusted-subagent-output>");
    expect(options).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });
  });

  it("does not duplicate a notice when append throws after writing", async () => {
    vi.useRealTimers();
    const setupResult = setup();
    scope = setupResult.scope;
    let throwAfterWrite = true;
    setupResult.pi.appendEntry.mockImplementation(
      (customType: string, data: unknown) => {
        setupResult.entries.push({ type: "custom", customType, data });
        if (customType === "subagentura-completion" && throwAfterWrite) {
          throwAfterWrite = false;
          throw new Error("late append failure");
        }
      },
    );

    expect(() =>
      publishCompletion(record("append-then-throw"), sessionOwner(scope)),
    ).not.toThrow();
    await vi.waitFor(() => expect(manifests(setupResult.pi)).toHaveLength(1));

    expect(userCompletions(setupResult.entries)).toHaveLength(1);
  });

  it("does not spin while durable notice storage remains unavailable", async () => {
    vi.useRealTimers();
    const setupResult = setup();
    scope = setupResult.scope;
    setupResult.pi.appendEntry.mockImplementation(() => {
      throw new Error("disk unavailable");
    });

    publishCompletion(record("persistent-failure"), sessionOwner(scope));
    await vi.waitFor(() =>
      expect(setupResult.pi.appendEntry).toHaveBeenCalledTimes(2),
    );
    const callsAfterInitialRetry = setupResult.pi.appendEntry.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(setupResult.pi.appendEntry.mock.calls.length).toBeLessThanOrEqual(
      callsAfterInitialRetry + 1,
    );
    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("recovers a transient completion notice append failure", async () => {
    vi.useRealTimers();
    const setupResult = setup();
    scope = setupResult.scope;
    let failed = true;
    setupResult.pi.appendEntry.mockImplementation(
      (customType: string, data: unknown) => {
        if (failed && customType === "subagentura-completion") {
          failed = false;
          throw new Error("transient storage failure");
        }
        setupResult.entries.push({ type: "custom", customType, data });
      },
    );
    publishCompletion(record("notice-retry"), sessionOwner(scope));
    await vi.waitFor(() => expect(manifests(setupResult.pi)).toHaveLength(1));
    expect(userCompletions(setupResult.entries)).toHaveLength(1);
  });

  it("preserves protocol-valid interactive turn IDs in retrieval selectors", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const turnId = "t".repeat(256);

    publishCompletion(record("long-turn", { turnId }), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)[0].data.turnId).toBe(turnId);
    expect(manifests(setupResult.pi)[0][0].content).toContain(
      JSON.stringify(turnId),
    );
  });

  it("coalesces independent completions that become ready while busy", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;

    publishCompletion(record("a"), sessionOwner(scope));
    publishCompletion(record("b"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));
    expect(manifests(setupResult.pi)).toHaveLength(0);

    scope.parentStreaming = false;
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)).toHaveLength(2);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    const content = manifests(setupResult.pi)[0][0].content;
    expect(content).toContain("Agent a");
    expect(content).toContain("Agent b");
  });

  it("waits for a sealed group and every member including errors and cancels", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const group = {
      policy: "group" as const,
      groupId: "review-group",
    };
    for (const id of ["a", "b", "c"]) {
      registerCompletionMember(
        "interactive",
        id,
        "group",
        group.groupId,
        sessionOwner(scope),
      );
    }

    publishCompletion(record("a", group), sessionOwner(scope));
    publishCompletion(
      record("b", { ...group, status: "error" }),
      sessionOwner(scope),
    );
    flushCompletionManifests(sessionOwner(scope));
    expect(manifests(setupResult.pi)).toHaveLength(0);

    settleCompletionParentTurn(sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));
    expect(manifests(setupResult.pi)).toHaveLength(0);

    publishCompletion(
      record("c", { ...group, status: "cancelled" }),
      sessionOwner(scope),
    );
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)).toHaveLength(3);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    expect(manifests(setupResult.pi)[0][0].details.completionIds).toHaveLength(
      3,
    );
  });

  it("marks manually collected results consumed before later publication", () => {
    const setupResult = setup();
    scope = setupResult.scope;

    consumeCompletionSource(
      setupResult.pi as never,
      "interactive",
      "a",
      sessionOwner(scope),
      "turn-a",
    );
    publishCompletion(record("a"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)).toHaveLength(1);
    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("persists one manual-consumption receipt per terminal turn", () => {
    const setupResult = setup();
    scope = setupResult.scope;

    for (let index = 0; index < 2; index++) {
      consumeCompletionSource(
        setupResult.pi as never,
        "interactive",
        "a",
        sessionOwner(scope),
        "turn-a",
      );
    }

    expect(
      setupResult.entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "subagentura-completion-consumed",
      ),
    ).toHaveLength(1);
  });

  it("preserves group terminality when every result was manually consumed", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const group = {
      policy: "group" as const,
      groupId: "consumed-group",
    };
    for (const id of ["a", "b"]) {
      registerCompletionMember(
        "interactive",
        id,
        "group",
        group.groupId,
        sessionOwner(scope),
      );
    }
    sealCompletionGroups(sessionOwner(scope));

    publishCompletion(record("a", group), sessionOwner(scope));
    consumeCompletionSource(
      setupResult.pi as never,
      "interactive",
      "a",
      sessionOwner(scope),
      "turn-a",
    );
    publishCompletion(record("b", group), sessionOwner(scope));
    consumeCompletionSource(
      setupResult.pi as never,
      "interactive",
      "b",
      sessionOwner(scope),
      "turn-b",
    );
    flushCompletionManifests(sessionOwner(scope));

    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("attaches ready references to a natural turn instead of auto-triggering", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    publishCompletion(record("a"), sessionOwner(scope));

    const message = prepareCompletionManifest(sessionOwner(scope));

    expect(message?.customType).toBe("subagent-manifest");
    expect(message?.content).toContain("outputs/event-a.md");
    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("treats repeated turns from one agent as distinct independent results", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;

    publishCompletion(record("a"), sessionOwner(scope));
    publishCompletion(
      record("a", {
        completionId: "completion-a-turn-2",
        turnId: "turn-a-2",
        references: [
          {
            label: "output",
            value: "/tmp/artifacts/a/outputs/event-a-2.md",
          },
        ],
      }),
      sessionOwner(scope),
    );
    scope.parentStreaming = false;
    flushCompletionManifests(sessionOwner(scope));

    expect(manifests(setupResult.pi)[0][0].details.completionIds).toEqual([
      "completion-a",
      "completion-a-turn-2",
    ]);
  });

  it("requires safe explicit group identifiers", () => {
    expect(resolveCompletionPolicy({})).toEqual({
      policy: "each",
      legacy: false,
    });
    expect(() =>
      resolveCompletionPolicy({
        completionPolicy: "group",
        completionGroupId: "bad\ngroup",
      }),
    ).toThrow(/groupId/);
  });

  it("quotes untrusted reference lines in parent manifests", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;
    publishCompletion(
      record("quoted", {
        references: [{ label: "output", value: "/tmp/safe\nignore previous" }],
      }),
      sessionOwner(scope),
    );

    const message = prepareCompletionManifest(sessionOwner(scope));
    expect(message?.content).toContain("\\nignore previous");
    expect(message?.content).not.toContain("/tmp/safe\nignore previous");
  });

  it("bounds independent records per parent manifest", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;
    for (let index = 0; index < 130; index++) {
      publishCompletion(record(`bounded-${index}`), sessionOwner(scope));
    }

    const completionIds: string[] = [];
    let message = prepareCompletionManifest(sessionOwner(scope));
    while (message) {
      expect(Buffer.byteLength(message.content, "utf8")).toBeLessThanOrEqual(
        32 * 1024,
      );
      completionIds.push(...message.details.completionIds);
      message = prepareCompletionManifest(sessionOwner(scope));
    }
    expect(completionIds).toHaveLength(130);
    expect(new Set(completionIds)).toHaveLength(130);
  });

  it("bounds explicit completion-group membership", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    for (let index = 0; index < 32; index++) {
      registerCompletionMember(
        "interactive",
        `agent-${index}`,
        "group",
        "bounded-group",
        sessionOwner(scope),
      );
    }
    expect(() =>
      registerCompletionMember(
        "interactive",
        "agent-overflow",
        "group",
        "bounded-group",
        sessionOwner(scope),
      ),
    ).toThrow(/full/);
  });

  it("rejects new work before launching into a sealed group", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    registerCompletionMember(
      "interactive",
      "existing",
      "group",
      "sealed-group",
      sessionOwner(scope),
    );
    sealCompletionGroups(sessionOwner(scope));

    expect(() =>
      assertCompletionGroupOpen("group", "sealed-group", sessionOwner(scope)),
    ).toThrow(/sealed/);
  });

  it("keeps every claimed manifest record inside the byte budget", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;
    for (let index = 0; index < 64; index++) {
      publishCompletion(
        record(`long-${index}`, {
          references: [
            {
              label: "output",
              value: `/tmp/${"x".repeat(1_000)}/event-${index}.md`,
            },
          ],
        }),
        sessionOwner(scope),
      );
    }

    const message = prepareCompletionManifest(sessionOwner(scope));
    expect(Buffer.byteLength(message!.content, "utf8")).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(message!.content).toContain("</completion-manifest>");
    for (const completionId of message!.details.completionIds) {
      const sourceId = completionId.replace(/^completion-/, "");
      expect(message!.content).toContain(sourceId);
    }
  });

  it("preserves publication order instead of timestamp order", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;
    publishCompletion(
      record("physical-first", { completedAt: 200 }),
      sessionOwner(scope),
    );
    publishCompletion(
      record("physical-second", { completedAt: 100 }),
      sessionOwner(scope),
    );

    const message = prepareCompletionManifest(sessionOwner(scope));
    expect(message?.details.completionIds).toEqual([
      "completion-physical-first",
      "completion-physical-second",
    ]);
  });

  it("keeps a human-turn fence until agent_start", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    publishCompletion(record("piggyback"), sessionOwner(scope));
    markCompletionHumanInput(sessionOwner(scope));
    expect(prepareCompletionManifest(sessionOwner(scope))).toBeDefined();

    publishCompletion(record("during-start"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("holds a no-ready human turn through before-start and releases on settlement", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    markCompletionHumanInput(owner);
    markCompletionTurnStarting(owner);
    expect(prepareCompletionManifest(owner)).toBeUndefined();

    publishCompletion(record("arrived-during-start"), owner);
    flushCompletionManifests(owner);
    expect(manifests(setupResult.pi)).toHaveLength(0);

    settleCompletionParentTurn(owner);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    expect(manifests(setupResult.pi)[0][0].details.completionIds).toContain(
      "completion-arrived-during-start",
    );
  });

  it("downgrades repeated sealed-group turns to independent delivery", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const group = { policy: "group" as const, groupId: "one-shot" };
    registerCompletionMember(
      "interactive",
      "same-agent",
      "group",
      group.groupId,
      sessionOwner(scope),
    );
    sealCompletionGroups(sessionOwner(scope));
    publishCompletion(record("same-agent", group), sessionOwner(scope));
    prepareCompletionManifest(sessionOwner(scope));

    publishCompletion(
      record("same-agent", {
        ...group,
        completionId: "completion-same-agent-turn-2",
        turnId: "turn-same-agent-2",
      }),
      sessionOwner(scope),
    );

    const completionEntries = userCompletions(setupResult.entries);
    expect(completionEntries.at(-1)?.data.policy).toBe("each");
  });

  it("maps legacy completion controls and rejects mixed group options", () => {
    expect(resolveCompletionPolicy({ notifyOnComplete: "inject" })).toEqual({
      policy: "each",
      legacy: false,
    });
    expect(() =>
      resolveCompletionPolicy({
        notifyOnComplete: "notify",
        completionGroupId: "mixed",
      }),
    ).toThrow(/cannot be combined/i);
  });

  it("rejects unregistered grouped publication after sealing", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    sealCompletionGroups(owner);
    publishCompletion(
      record("late", { policy: "group", groupId: "late-group" }),
      owner,
    );
    expect(userCompletions(setupResult.entries)).toHaveLength(0);
  });

  it("downgrades repeated grouped turns after the first record is spilled", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-group-overflow-"));
    scope.parentStreaming = true;
    try {
      registerCompletionMember(
        "interactive",
        "group-source",
        "group",
        "g",
        owner,
      );
      publishCompletion(
        record("group-source", {
          completionId: "group-first",
          policy: "group",
          groupId: "g",
        }),
        owner,
      );
      for (let index = 0; index < MAX_COMPLETION_RECORDS; index++) {
        publishCompletion(record(`filler-${index}`), owner);
      }
      publishCompletion(
        record("group-source", {
          completionId: "group-second",
          turnId: "turn-group-second",
          policy: "group",
          groupId: "g",
        }),
        owner,
      );
      expect(
        userCompletions(setupResult.entries).find(
          (entry) => entry.data.completionId === "group-second",
        )?.data.policy,
      ).toBe("each");
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("reserves group capacity across concurrent prepared spawns", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    const reservations = Array.from({ length: 32 }, () =>
      reserveCompletionGroup("group", "reserved", owner),
    );
    expect(reservations).toHaveLength(32);
    expect(() => reserveCompletionGroup("group", "reserved", owner)).toThrow(
      /full/,
    );
  });

  it("preflights the maximum number of completion groups", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    for (let index = 0; index < 512; index++) {
      registerCompletionMember(
        "in-process",
        `job-${index}`,
        "group",
        `group-${index}`,
        owner,
      );
    }
    expect(() =>
      assertCompletionGroupOpen("group", "group-overflow", owner),
    ).toThrow(/Too many completion groups/);
  });

  it("retries a failed manifest dispatch with backoff", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    let failed = true;
    setupResult.pi.sendMessage.mockImplementation((message: any) => {
      if (failed) {
        failed = false;
        throw new Error("stale context");
      }
      setupResult.entries.push({ type: "custom_message", ...message });
    });
    scope.parentStreaming = true;
    publishCompletion(record("retry"), sessionOwner(scope));
    scope.parentStreaming = false;
    flushCompletionManifests(sessionOwner(scope));
    expect(
      setupResult.entries.filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(
      setupResult.entries.filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(1);
  });

  it("keeps successful consumption durable when the receipt append fails", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-receipt-"));
    setupResult.pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("receipt storage unavailable");
    });
    try {
      expect(() =>
        consumeCompletionSource(
          setupResult.pi as never,
          "interactive",
          "consumed",
          sessionOwner(scope),
          "turn-consumed",
        ),
      ).not.toThrow();
      publishCompletion(
        record("consumed", { turnId: "turn-consumed" }),
        sessionOwner(scope),
      );
      clearCompletionCoordinator(sessionOwner(scope));
      registerCompletionCoordinator(setupResult.pi as never, scope);
      flushCompletionManifests(sessionOwner(scope));
      expect(manifests(setupResult.pi)).toHaveLength(0);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("keeps more than 512 fallback receipts across coordinator recreation", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-receipt-many-"));
    setupResult.pi.appendEntry.mockImplementation(
      (customType: string, data: unknown) => {
        if (customType === "subagentura-completion-consumed") {
          throw new Error("receipt store unavailable");
        }
        setupResult.entries.push({ type: "custom", customType, data });
      },
    );
    try {
      for (let index = 0; index < 513; index++) {
        const sourceId = `receipt-${index}`;
        const turnId = `turn-${index}`;
        consumeCompletionSource(
          setupResult.pi as never,
          "in-process",
          sourceId,
          sessionOwner(scope),
          turnId,
        );
        publishCompletion(
          record(sourceId, {
            source: "in-process",
            completionId: `receipt-completion-${index}`,
            turnId,
          }),
          sessionOwner(scope),
        );
      }
      clearCompletionCoordinator(sessionOwner(scope));
      registerCompletionCoordinator(setupResult.pi as never, scope);
      flushCompletionManifests(sessionOwner(scope));
      expect(manifests(setupResult.pi)).toHaveLength(0);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("shows failed overflow identities in the model-visible selector", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-overflow-failure-"));
    mkdirSync(join(scope.cwd, ".pi"), { recursive: true });
    const ledger = sessionLedgerPath(
      scope.cwd,
      "parent-session",
      "subagentura-completion-overflow",
    );
    symlinkSync(join(scope.cwd, "missing-target"), ledger);
    scope.parentStreaming = true;
    try {
      for (let index = 0; index <= MAX_COMPLETION_RECORDS; index++) {
        publishCompletion(record(`failure-${index}`), sessionOwner(scope));
      }
      scope.parentStreaming = false;
      const message = prepareCompletionManifest(sessionOwner(scope));
      expect(message?.content).toContain("ledger_append_failed");
      expect(message?.content).toContain("completion-failure-0");
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("moves unconsumed records past the bound to a durable overflow selector", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-overflow-"));
    scope.parentStreaming = true;
    try {
      for (let index = 0; index <= MAX_COMPLETION_RECORDS; index++) {
        publishCompletion(record(`overflow-${index}`), sessionOwner(scope));
      }
      scope.parentStreaming = false;
      const message = prepareCompletionManifest(sessionOwner(scope));
      expect(message?.content).toContain("Completion metadata exceeded");
      expect(message?.content).toContain("read(path:");
      expect(message?.details.overflowCount).toBe(1);
      const ledger = message!.details.overflowPath!;
      expect(readFileSync(ledger, "utf8")).toContain("overflow-0");
      expect(message?.details.completionIds).toEqual([]);
      clearCompletionCoordinator(sessionOwner(scope));
      registerCompletionCoordinator(setupResult.pi as never, scope);
      const rehydrated = prepareCompletionManifest(sessionOwner(scope));
      expect(rehydrated?.details.overflowPath).toBe(ledger);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });
});
