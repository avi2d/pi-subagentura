import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Standard tmux pane id returned by mocks when "new-window"/"split-window" is called. */
const MOCK_PANE_ID = "%42";
/** Tab-separated session/window/pane — matches real tmux #{...} format. */
const MOCK_LOCATION = "sess\t1\t0\n";

function installMockExec(scenario: (file: string, args: string[]) => string) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => scenario("tmux", args as string[]),
  }));
}

function makeArgs() {
  return {
    TMUX: "/tmp/tmux-1000/default,12345,0",
    TMUX_PANE: "%1",
    HOME: process.env.HOME ?? "/tmp",
    PI_CODING_AGENT_SESSION_DIR: undefined as string | undefined,
  };
}

describe("interactive-tmux", () => {
  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
  });

  afterEach(() => {
    rmSync(makeTmp(), { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  });

  it("is unavailable when TMUX env var is missing", async () => {
    process.env.TMUX = "";
    const { isTmuxAvailable } = await importFresh();
    expect(isTmuxAvailable()).toBe(false);
  });

  it("launches in background mode by default (new-window) and stores window-name attach commands", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";

    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      if (args[0] === "show-options") return "0\n";
      return "";
    });

    const mod = await importFresh();
    // No `background` flag — should default to true (hidden).
    const state = mod.launchInteractiveSubagent({
      name: "Demo",
      task: "Run tests",
      persona: "You are a tester",
      cwd: tmp,
    });

    expect(state.paneId).toBe(MOCK_PANE_ID);
    expect(state.windowName).toBe("demo");
    // Background mode: attach command should target the named window, not the pane.
    expect(state.attachCommand).toContain("select-window -t 'demo'");
    expect(state.attachCommand).not.toContain("select-pane");
    expect(state.selectPaneCommand).toContain("select-window -t 'demo'");

    // new-window was used (not split-window) — the user's tmux layout is undisturbed.
    const usedNewWindow = calls.some((args) => args[0] === "new-window");
    const usedSplitWindow = calls.some((args) => args[0] === "split-window");
    expect(usedNewWindow).toBe(true);
    expect(usedSplitWindow).toBe(false);

    // Launch script embeds an EXIT trap that writes @pi-exit-code to the pane.
    expect(existsSync(state.launchScriptFile)).toBe(true);
    const launchScript = readFileSync(state.launchScriptFile, "utf8");
    expect(launchScript).toContain("trap");
    expect(launchScript).toContain("@pi-exit-code");
    expect(launchScript).toContain("pi --session");
    // Tightened perms — only the owning user can read the script.
    expect(statSync(state.launchScriptFile).mode & 0o777).toBe(0o700);

    // Registry has the state.
    expect(mod.interactiveSubagentRegistry.get(state.id)).toBe(state);

    // Artifact dir was created and the inline CLI was written.
    expect(state.artifactDir).toBeTruthy();
    expect(existsSync(state.artifactDir)).toBe(true);
    expect(existsSync(join(state.artifactDir, "cli.mjs"))).toBe(true);
    expect(statSync(join(state.artifactDir, "cli.mjs")).mode & 0o777).toBe(0o700);
  });

  it("launches in visible-split mode when background: false", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";

    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      if (args[0] === "split-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      return "";
    });

    const mod = await importFresh();
    const state = mod.launchInteractiveSubagent({
      name: "Demo",
      task: "Run tests",
      cwd: tmp,
      background: false,
    });

    // Visible-split mode: pane is in a side-by-side, attach by pane id.
    expect(state.paneId).toBe(MOCK_PANE_ID);
    expect(state.windowName).toBeUndefined();
    expect(state.attachCommand).toContain("select-pane -t '%42'");
    expect(state.selectPaneCommand).toBe("tmux select-pane -t '%42'");

    const usedSplitWindow = calls.some((args) => args[0] === "split-window");
    const usedNewWindow = calls.some((args) => args[0] === "new-window");
    expect(usedSplitWindow).toBe(true);
    expect(usedNewWindow).toBe(false);
  });

  it("kills the orphan pane if writeLaunchScript fails after createTmuxPane", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";

    // Pre-create a path that will collide with the launch script so writeFileSync
    // throws EEXIST. We do this by mocking fs to make writeFileSync fail on the
    // launch script path.
    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      return "";
    });
    // Override fs so the launch script write throws.
    vi.doMock("node:fs", async () => {
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...real,
        writeFileSync: (path: any, data: any, options?: any) => {
          if (typeof path === "string" && path.endsWith("-launch.sh")) {
            throw new Error("simulated disk full");
          }
          return real.writeFileSync(path, data, options);
        },
      };
    });

    const mod = await importFresh();
    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Demo",
        task: "Run tests",
        cwd: tmp,
      }),
    ).toThrow(/simulated disk full/);

    // F2 fix: the pane should have been killed (no orphan left in tmux).
    const killedPane = calls.some(
      (args) => args[0] === "kill-pane" && args.includes("-t") && args.includes(MOCK_PANE_ID),
    );
    expect(killedPane).toBe(true);

    // Registry should not have the failed sub-agent.
    expect(mod.interactiveSubagentRegistry.size).toBe(0);
  });

  it("readPaneExitCode returns the captured exit code, or null when unset", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = makeTmp();
    process.env.TMUX = makeArgs().TMUX;

    // Mock returning a numeric exit code.
    installMockExec((_f, args) => {
      if (args[0] === "show-options") return "0\n";
      return "";
    });
    const mod1 = await importFresh();
    expect(mod1.readPaneExitCode(MOCK_PANE_ID)).toBe(0);

    // Mock returning empty string (option not yet set).
    installMockExec((_f, args) => {
      if (args[0] === "show-options") return "\n";
      return "";
    });
    const mod2 = await importFresh();
    expect(mod2.readPaneExitCode(MOCK_PANE_ID)).toBeNull();

    // Mock throwing (pane dead / option unset).
    installMockExec((_f, args) => {
      if (args[0] === "show-options") throw new Error("no such pane");
      return "";
    });
    const mod3 = await importFresh();
    expect(mod3.readPaneExitCode(MOCK_PANE_ID)).toBeNull();
  });

  it("readPaneExitCode suppresses tmux stderr (regression: 'invalid option' leak into parent TUI)", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = makeTmp();
    process.env.TMUX = makeArgs().TMUX;

    // Capture the options passed to execFileSync so we can assert stdio ignores
    // stderr. This guards against the regression where, while the child is still
    // running, tmux's `invalid option: @pi-exit-code` leaked into the parent TUI.
    const capturedOptions: Array<Record<string, unknown> | undefined> = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[], options?: unknown) => {
        capturedOptions.push(options as Record<string, unknown> | undefined);
        if (args[0] === "show-options") throw new Error("unset");
        return "";
      },
    }));

    const mod = await importFresh();
    expect(mod.readPaneExitCode(MOCK_PANE_ID)).toBeNull();

    // The execFileSync call must use stdio that explicitly ignores stderr.
    // Inheriting stderr would let tmux errors leak into the parent's TUI when
    // the option is unset.
    expect(capturedOptions.length).toBeGreaterThan(0);
    for (const opts of capturedOptions) {
      expect(opts).toBeDefined();
      const stdio = opts!.stdio as [string, string, string] | undefined;
      expect(stdio, "stdio must be specified to avoid inheriting stderr").toBeDefined();
      expect(stdio![2]).toBe("ignore");
    }
  });

  it("pruneDeadInteractiveSubagents reads from the artifact", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = makeTmp();
    process.env.TMUX = makeArgs().TMUX;

    const mod = await importFresh();
    const { appendEvent, artifactPath } = await import("./artifact");
    const { mkdirSync } = await import("node:fs");

    // Case 1: artifact has a `done` event → "exited" with code 0.
    {
      const dir = join(makeTmp(), "a1");
      mkdirSync(dir, { recursive: true });
      const art = artifactPath(join(dir, ".."), "a1");
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      const state: import("./interactive-tmux").InteractiveSubagentState = {
        id: "a1",
        name: "A",
        task: "t",
        paneId: MOCK_PANE_ID,
        sessionFile: "/nonexistent.jsonl",
        cwd: "/tmp",
        startedAt: Date.now(),
        status: "running",
        attachCommand: "",
        selectPaneCommand: "",
        launchScriptFile: "/dev/null",
        artifactDir: dir,
      };
      mod.interactiveSubagentRegistry.set(state.id, state);
      mod.pruneDeadInteractiveSubagents();
      expect(state.status).toBe("exited");
      expect(state.exitCode).toBe(0);
    }

    // Case 2: artifact has a `cancelled` event → "cancelled".
    {
      const dir = join(makeTmp(), "a2");
      mkdirSync(dir, { recursive: true });
      const art = artifactPath(join(dir, ".."), "a2");
      appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });
      const state: import("./interactive-tmux").InteractiveSubagentState = {
        id: "a2",
        name: "B",
        task: "t",
        paneId: MOCK_PANE_ID,
        sessionFile: "/nonexistent.jsonl",
        cwd: "/tmp",
        startedAt: Date.now(),
        status: "running",
        attachCommand: "",
        selectPaneCommand: "",
        launchScriptFile: "/dev/null",
        artifactDir: dir,
      };
      mod.interactiveSubagentRegistry.set(state.id, state);
      mod.pruneDeadInteractiveSubagents();
      expect(state.status).toBe("cancelled");
    }
  });
});

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-tmux-"));
}

async function importFresh() {
  vi.resetModules();
  return import("./interactive-tmux");
}
