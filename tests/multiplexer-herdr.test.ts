import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

/**
 * Mocked-argv unit tests for the herdr backend.
 *
 * These pin the argv we build and the JSON shapes we parse; the real CLI
 * contract — flag names, output shape, exit codes — is pinned by
 * `tests/herdr.integration.test.ts` against the actual binary. Fixtures below
 * are copied from herdr 0.8.2 responses, trimmed to the fields we read.
 */

const TAB_CREATE_RESPONSE = JSON.stringify({
  id: "cli:tab:create",
  result: {
    root_pane: { pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1" },
    tab: { label: "demo", tab_id: "w1:t9", workspace_id: "w1" },
    type: "tab_created",
  },
});

const PANE_SPLIT_RESPONSE = JSON.stringify({
  id: "cli:pane:split",
  result: {
    pane: { pane_id: "w1:p7", tab_id: "w1:t3", workspace_id: "w1" },
    type: "pane_info",
  },
});

const PANE_GET_RESPONSE = JSON.stringify({
  id: "cli:pane:get",
  result: {
    pane: { pane_id: "w1:p7", tab_id: "w1:t3", workspace_id: "w1" },
    type: "pane_info",
  },
});

const PANE_NOT_FOUND_STDERR = JSON.stringify({
  error: { code: "pane_not_found", message: "pane w1:p7 not found" },
  id: "cli:pane:get",
});

function isCommandProbe(args: readonly string[]): boolean {
  return args[0] === "-c" && (args[1] ?? "").startsWith("command -v");
}

interface ExecFailure {
  status?: number;
  stderr?: string;
}

function execError(failure: ExecFailure): Error {
  return Object.assign(new Error("herdr exited non-zero"), failure);
}

interface AsyncExecOutcome {
  error?: Error;
  stdout?: string;
  /**
   * Delivered as the callback's third argument, NEVER attached to the error —
   * matching real `execFile`, where only the sync API puts stderr on the
   * thrown error. A mock that attached it let a broken async liveness read
   * ship green until the real binary said otherwise.
   */
  stderr?: string;
}

function installMockExec(
  scenario: (args: string[]) => string,
  asyncScenario: (args: string[]) => AsyncExecOutcome = () => ({ stdout: "" }),
) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => scenario(args as string[]),
    execFile: (
      _file: string,
      args: string[],
      _opts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const outcome = asyncScenario(args as string[]);
      queueMicrotask(() =>
        callback(
          outcome.error ?? null,
          outcome.stdout ?? "",
          outcome.stderr ?? "",
        ),
      );
    },
  }));
}

async function freshHerdr() {
  const { HerdrMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-herdr")
  >("../src/multiplexer-herdr");
  return new HerdrMultiplexer();
}

describe("multiplexer-herdr", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // The suite itself may run inside a herdr pane, so the injected context
    // must be cleared up front — each test states the env it assumes.
    originalEnv = { ...process.env };
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    delete process.env.HERDR_PANE_ID;
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    process.env = originalEnv;
  });

  /* ------------------------------------------------------------------ */
  /*  isAvailable                                                        */
  /* ------------------------------------------------------------------ */

  it("isAvailable requires HERDR_ENV=1 — no exec happens without it", async () => {
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const mux = await freshHerdr();
    expect(mux.isAvailable()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("isAvailable probes the live server with pane current --current", async () => {
    process.env.HERDR_ENV = "1";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const mux = await freshHerdr();
    expect(mux.isAvailable()).toBe(true);
    expect(calls[0]).toEqual(["pane", "current", "--current"]);
  });

  it("isAvailable is false when the probe fails (env var outlived the server)", async () => {
    process.env.HERDR_ENV = "1";
    installMockExec(() => {
      throw execError({ status: 1 });
    });
    const mux = await freshHerdr();
    expect(mux.isAvailable()).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  createPane                                                         */
  /* ------------------------------------------------------------------ */

  it("createPane background creates a --no-focus tab and maps tab_id to windowName", async () => {
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_PANE_ID = "w1:p1";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (isCommandProbe(args)) return "";
      if (args[0] === "tab" && args[1] === "create") return TAB_CREATE_RESPONSE;
      throw new Error("unexpected exec: " + args.join(" "));
    });
    const mux = await freshHerdr();

    const result = mux.createPane({
      name: "Demo Agent",
      cwd: "/tmp/ws",
      background: true,
      windowName: "demo-agent",
    });

    expect(result).toEqual({
      paneId: "w1:p9",
      windowName: "w1:t9",
      session: "w1",
    });
    const create = calls.find((a) => a[0] === "tab");
    expect(create).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/tmp/ws",
      "--label",
      "demo-agent",
      "--no-focus",
    ]);
  });

  it("createPane background derives the label from the name when windowName is omitted", async () => {
    process.env.HERDR_WORKSPACE_ID = "w1";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (isCommandProbe(args)) return "";
      return TAB_CREATE_RESPONSE;
    });
    const mux = await freshHerdr();
    mux.createPane({ name: "Code Reviewer #2", cwd: "/tmp", background: true });

    const create = calls.find((a) => a[0] === "tab");
    expect(create).toContain("--label");
    expect(create![create!.indexOf("--label") + 1]).toBe("code-reviewer-2");
  });

  it("createPane split targets the caller's own pane from HERDR_PANE_ID", async () => {
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_PANE_ID = "w1:p1";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (isCommandProbe(args)) return "";
      if (args[0] === "pane" && args[1] === "split") return PANE_SPLIT_RESPONSE;
      throw new Error("unexpected exec: " + args.join(" "));
    });
    const mux = await freshHerdr();

    const result = mux.createPane({
      name: "Demo",
      cwd: "/tmp/ws",
      background: false,
    });

    // windowName stays undefined: callers read its absence as "visible split".
    expect(result).toEqual({
      paneId: "w1:p7",
      windowName: undefined,
      session: "w1",
    });
    const split = calls.find((a) => a[0] === "pane");
    expect(split).toEqual([
      "pane",
      "split",
      "--pane",
      "w1:p1",
      "--direction",
      "right",
      "--cwd",
      "/tmp/ws",
      "--no-focus",
    ]);
  });

  it("createPane forces background mode when no caller pane exists", async () => {
    process.env.HERDR_WORKSPACE_ID = "w1";
    delete process.env.HERDR_PANE_ID;
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (isCommandProbe(args)) return "";
      return TAB_CREATE_RESPONSE;
    });
    const mux = await freshHerdr();
    const result = mux.createPane({
      name: "Demo",
      cwd: "/tmp",
      background: false,
    });

    expect(calls.some((a) => a[0] === "tab" && a[1] === "create")).toBe(true);
    expect(calls.some((a) => a[1] === "split")).toBe(false);
    expect(result.windowName).toBe("w1:t9");
  });

  it("createPane throws a setup error without HERDR_WORKSPACE_ID", async () => {
    delete process.env.HERDR_WORKSPACE_ID;
    installMockExec((args) => {
      if (isCommandProbe(args)) return "";
      return "";
    });
    const mux = await freshHerdr();
    expect(() =>
      mux.createPane({ name: "Demo", cwd: "/tmp", background: true }),
    ).toThrow(/HERDR_WORKSPACE_ID/);
  });

  it("createPane surfaces a malformed JSON response instead of an empty pane id", async () => {
    process.env.HERDR_WORKSPACE_ID = "w1";
    installMockExec((args) => {
      if (isCommandProbe(args)) return "";
      return "not json";
    });
    const mux = await freshHerdr();
    expect(() =>
      mux.createPane({ name: "Demo", cwd: "/tmp", background: true }),
    ).toThrow(/malformed JSON/);
  });

  /* ------------------------------------------------------------------ */
  /*  sendKeys / sendEnter / killPane                                    */
  /* ------------------------------------------------------------------ */

  it("sendKeys passes the text as one positional argument with no -- terminator", async () => {
    // herdr delivers everything after the pane id literally — verified against
    // 0.8.2, where a `--` argument is itself typed into the pane. Adding the
    // terminator the other backends need would corrupt every follow-up.
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const mux = await freshHerdr();
    mux.sendKeys("w1:p7", "--help");

    expect(calls[0]).toEqual(["pane", "send-text", "w1:p7", "--help"]);
  });

  it("sendEnter presses the logical enter key", async () => {
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const mux = await freshHerdr();
    mux.sendEnter("w1:p7");

    expect(calls[0]).toEqual(["pane", "send-keys", "w1:p7", "enter"]);
  });

  it("killPane closes the pane and swallows the already-dead error", async () => {
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      throw execError({ status: 1, stderr: PANE_NOT_FOUND_STDERR });
    });
    const mux = await freshHerdr();
    expect(() => mux.killPane("w1:p7")).not.toThrow();
    expect(calls[0]).toEqual(["pane", "close", "w1:p7"]);
  });

  /* ------------------------------------------------------------------ */
  /*  liveness                                                           */
  /* ------------------------------------------------------------------ */

  it("getPaneLiveness answers alive on exit 0", async () => {
    installMockExec((args) => {
      expect(args).toEqual(["pane", "get", "w1:p7"]);
      return PANE_GET_RESPONSE;
    });
    const mux = await freshHerdr();
    expect(mux.getPaneLiveness("w1:p7")).toBe("alive");
  });

  it("getPaneLiveness answers dead only for pane_not_found", async () => {
    installMockExec(() => {
      throw execError({ status: 1, stderr: PANE_NOT_FOUND_STDERR });
    });
    const mux = await freshHerdr();
    expect(mux.getPaneLiveness("w1:p7")).toBe("dead");
  });

  it("getPaneLiveness answers unknown for any other failure", async () => {
    // A backend that cannot answer must not be read as a dead pane: exit 2
    // syntax errors, a dead socket, and non-JSON stderr are all `unknown`.
    installMockExec(() => {
      throw execError({ status: 2, stderr: "usage: herdr pane get <pane>" });
    });
    const mux = await freshHerdr();
    expect(mux.getPaneLiveness("w1:p7")).toBe("unknown");
    expect(mux.getPaneLiveness("")).toBe("unknown");
    expect(mux.getPaneLiveness("--current")).toBe("unknown");
  });

  it("getPaneLivenessAsync mirrors the tri-state mapping", async () => {
    installMockExec(
      () => "",
      (args) => {
        expect(args).toEqual(["pane", "get", "w1:p7"]);
        // stderr rides the callback argument, not the error (see the mock).
        return {
          error: execError({ status: 1 }),
          stderr: PANE_NOT_FOUND_STDERR,
        };
      },
    );
    const mux = await freshHerdr();
    await expect(mux.getPaneLivenessAsync("w1:p7")).resolves.toBe("dead");

    installMockExec(
      () => "",
      () => ({ stdout: PANE_GET_RESPONSE }),
    );
    const alive = await freshHerdr();
    await expect(alive.getPaneLivenessAsync("w1:p7")).resolves.toBe("alive");

    installMockExec(
      () => "",
      () => ({ error: execError({ status: 2 }), stderr: "usage" }),
    );
    const unknown = await freshHerdr();
    await expect(unknown.getPaneLivenessAsync("w1:p7")).resolves.toBe(
      "unknown",
    );
  });

  /* ------------------------------------------------------------------ */
  /*  capturePane                                                        */
  /* ------------------------------------------------------------------ */

  it("capturePane reads the visible source and applies the caller's bounds", async () => {
    const calls: string[][] = [];
    installMockExec(
      () => "",
      (args) => {
        calls.push(args);
        return { stdout: "one\ntwo\nthree\nfour" };
      },
    );
    const mux = await freshHerdr();
    const result = await mux.capturePane(
      { paneId: "w1:p7" },
      { maxBytes: 4096, maxLines: 2 },
    );

    expect(calls[0]).toEqual([
      "pane",
      "read",
      "w1:p7",
      "--source",
      "visible",
      "--lines",
      "2",
    ]);
    expect(result).toEqual({ output: "three\nfour", truncated: true });
  });

  it("capturePane rejects when the read fails", async () => {
    installMockExec(
      () => "",
      () => ({
        error: execError({ status: 1, stderr: PANE_NOT_FOUND_STDERR }),
      }),
    );
    const mux = await freshHerdr();
    await expect(
      mux.capturePane({ paneId: "w1:p7" }, { maxBytes: 1024, maxLines: 10 }),
    ).rejects.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /*  focusPane / buildAttachCommands / showNativeViewer                 */
  /* ------------------------------------------------------------------ */

  it("focusPane focuses the tab named by windowName", async () => {
    const asyncCalls: string[][] = [];
    installMockExec(
      () => "",
      (args) => {
        asyncCalls.push(args);
        return { stdout: "" };
      },
    );
    const mux = await freshHerdr();
    await mux.focusPane({ paneId: "w1:p9", windowName: "w1:t9" });

    expect(asyncCalls[0]).toEqual(["tab", "focus", "w1:t9"]);
  });

  it("focusPane recovers a split pane's tab id from pane get", async () => {
    const syncCalls: string[][] = [];
    const asyncCalls: string[][] = [];
    installMockExec(
      (args) => {
        syncCalls.push(args);
        return PANE_GET_RESPONSE;
      },
      (args) => {
        asyncCalls.push(args);
        return { stdout: "" };
      },
    );
    const mux = await freshHerdr();
    await mux.focusPane({ paneId: "w1:p7" });

    expect(syncCalls[0]).toEqual(["pane", "get", "w1:p7"]);
    expect(asyncCalls[0]).toEqual(["tab", "focus", "w1:t3"]);
  });

  it("buildAttachCommands emits the plain attach and the tab focus command", async () => {
    installMockExec(() => PANE_GET_RESPONSE);
    const mux = await freshHerdr();

    expect(
      mux.buildAttachCommands({ paneId: "w1:p9", windowName: "w1:t9" }),
    ).toEqual({
      attachCommand: "herdr",
      focusCommand: "herdr tab focus 'w1:t9'",
    });
    // Split pane: no windowName, the tab id comes from pane get.
    expect(mux.buildAttachCommands({ paneId: "w1:p7" })).toEqual({
      attachCommand: "herdr",
      focusCommand: "herdr tab focus 'w1:t3'",
    });
  });

  it("showNativeViewer always declines — herdr has no overlay surface", async () => {
    installMockExec(() => {
      throw new Error("no exec expected");
    });
    const mux = await freshHerdr();
    await expect(mux.showNativeViewer()).resolves.toBe(false);
  });
});
