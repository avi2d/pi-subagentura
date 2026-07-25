import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobRegistry } from "../src/helpers";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { registerSessionHandlers } from "../src/session-handlers";
import { updateRunningSubagentFooter } from "../src/artifact-poller";
import { workflowJobRegistry } from "../src/workflow-jobs";

function registerHandlers() {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on: vi.fn((name: string, handler: Function) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    }),
    sendMessage: vi.fn(),
  };
  const sessionContext = registerSessionHandlers(pi as any);
  return { handlers, pi, sessionContext };
}

describe("session handler lifecycle callbacks", () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "pi-subagentura-session-handlers-"));
    jobRegistry.clear();
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
    const globalState = globalThis as any;
    globalState.__piSubagenturaInteractivePollerHandle = undefined;
    globalState.__piSubagenturaPiRef = undefined;
    globalState.__piSubagenturaUi = undefined;
    globalState.__piSubagenturaSessionManager = undefined;
    globalState.__piSubagenturaParentStreaming = false;
    const contextStack = globalState.__piSubagenturaSessionContextStack;
    if (Array.isArray(contextStack)) {
      contextStack.length = 0;
    }
    globalState.__piSubagenturaSessionContextIdCounter = 0;
  });

  afterEach(() => {
    const handle = (globalThis as any).__piSubagenturaInteractivePollerHandle;
    if (handle) clearInterval(handle);
    vi.useRealTimers();
    jobRegistry.clear();
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
    rmSync(root, { recursive: true, force: true });
  });

  it("tracks streaming state, captures session context, and shuts down jobs", async () => {
    const { handlers, pi, sessionContext } = registerHandlers();
    const sessionManager = {
      getSessionId: () => "parent-session",
      getEntries: () => [],
    };
    const ui = { notify: vi.fn() };
    const ctx = { cwd: root, ui, sessionManager };

    handlers.get("agent_start")![0]();
    expect((globalThis as any).__piSubagenturaParentStreaming).toBe(true);

    handlers.get("agent_settled")![0]();
    expect((globalThis as any).__piSubagenturaParentStreaming).toBe(false);

    handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    expect((globalThis as any).__piSubagenturaUi).toBe(ui);
    expect((globalThis as any).__piSubagenturaSessionManager).toBe(
      sessionManager,
    );

    handlers.get("session_shutdown")![0]();

    const abort = vi.fn(() => Promise.reject(new Error("already disposed")));
    jobRegistry.set("job-1", {
      id: "job-1",
      status: "running",
      session: { abort },
    } as any);
    const workflowAbort = new AbortController();
    workflowJobRegistry.set("workflow-1", {
      id: "workflow-1",
      status: "running",
      abort: workflowAbort,
      parentSessionOwner: {
        id: sessionContext.id,
        generation: sessionContext.generation,
      },
    } as any);

    await handlers.get("session_shutdown")![1]({ reason: "quit" }, ctx);
    await Promise.resolve();

    expect(abort).toHaveBeenCalledOnce();
    expect(workflowAbort.signal.aborted).toBe(true);
    expect(jobRegistry.size).toBe(0);
    expect(workflowJobRegistry.size).toBe(0);
    expect((globalThis as any).__piSubagenturaPiRef).toBeUndefined();
    expect(pi.on).toHaveBeenCalled();
  });

  it("keeps parent async jobs and footer visible after nested session shutdown", () => {
    const parent = registerHandlers();
    const child = registerHandlers();
    const parentUi = { setStatus: vi.fn() };
    const parentSessionManager = {
      getSessionId: () => "parent-session",
      getEntries: () => [],
    };
    const childSessionManager = {
      getSessionId: () => "child-session",
      getEntries: () => [],
    };
    const parentCtx = {
      cwd: root,
      ui: parentUi,
      sessionManager: parentSessionManager,
    };
    const childCtx = {
      cwd: root,
      ui: parentUi,
      sessionManager: childSessionManager,
    };

    parent.handlers.get("session_start")![0](
      { reason: "startup" },
      parentCtx as any,
    );
    child.handlers.get("session_start")![0](
      { reason: "startup" },
      childCtx as any,
    );

    jobRegistry.set("running-parent-job", {
      id: "running-parent-job",
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
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      promise: new Promise<never>(() => {}),
    } as any);

    updateRunningSubagentFooter(parentUi as any);
    expect(parentUi.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
    parentUi.setStatus.mockClear();

    child.handlers.get("session_shutdown")![1](
      { reason: "agent_settled" },
      childCtx as any,
    );
    expect(jobRegistry.size).toBe(1);
    expect((globalThis as any).__piSubagenturaPiRef).toBe(parent.pi);
    expect((globalThis as any).__piSubagenturaSessionManager).toBe(
      parentSessionManager,
    );

    updateRunningSubagentFooter(parentUi as any);
    expect(parentUi.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
  });
});
