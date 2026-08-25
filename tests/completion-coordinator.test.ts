import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import {
  clearCompletionCoordinator,
  assertCompletionGroupOpen,
  consumeCompletionSource,
  flushCompletionManifests,
  markCompletionHumanInput,
  markCompletionTurnStarting,
  prepareCompletionManifest,
  publishCompletion,
  registerCompletionCoordinator,
  registerCompletionMember,
  resolveCompletionPolicy,
  sealCompletionGroups,
  settleCompletionParentTurn,
  type CompletionRecord,
} from "../src/completion-coordinator";

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
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(setupResult.pi.appendEntry).toHaveBeenCalledTimes(2);
    expect(manifests(setupResult.pi)).toHaveLength(0);
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
});
