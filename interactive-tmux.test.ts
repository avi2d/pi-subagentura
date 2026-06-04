import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Exec = (file: string, args: string[], options?: any) => string | Buffer;

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

  it("launches a tmux pane and stores attach commands", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";

    const calls: string[][] = [];
    installMockExec((file, args) => {
      calls.push(args);
      if (args[0] === "split-window") return "%42\n";
      if (args[0] === "display-message") {
        return `sess\n1\n0\n`;
      }
      return "";
    });

    const mod = await importFresh();
    const state = mod.launchInteractiveSubagent({
      name: "Demo",
      task: "Run tests",
      persona: "You are a tester",
      cwd: tmp,
    });

    expect(state.paneId).toBe("%42");
    expect(state.sessionFile).toContain(".jsonl");
    expect(state.attachCommand).toContain("tmux attach");
    expect(state.attachCommand).toContain("-t '%42'");
    expect(state.selectPaneCommand).toContain("select-pane");

    // Session file & prompt & system prompt & launch script should exist
    expect(existsSync(state.sessionFile)).toBe(false); // not created by our code, only by `pi`
    expect(existsSync(state.launchScriptFile)).toBe(true);
    const launchScript = readFileSync(state.launchScriptFile, "utf8");
    expect(launchScript).toContain("pi --session");
    expect(launchScript).toContain("Demo");
    expect(launchScript).toMatch(/demo-prompt\.md'$/m);
    const promptPath = launchScript
      .split("'")
      .find((s) => s.endsWith("demo-prompt.md"))!
      .replace(/^@/, "");
    expect(readFileSync(promptPath, "utf8")).toContain("Run tests");
    const sysPromptPath = launchScript
      .split("'")
      .find((s) => s.endsWith("demo-system.md"))!;
    expect(existsSync(sysPromptPath)).toBe(true);
    expect(readFileSync(sysPromptPath, "utf8")).toContain("You are a tester");
    expect(launchScript).toContain("--append-system-prompt");
    const subcommandCounts = calls.reduce<Record<string, number>>((acc, args) => {
      const sub = args[0];
      acc[sub] = (acc[sub] ?? 0) + 1;
      return acc;
    }, {});
    expect(subcommandCounts["split-window"]).toBe(1);

    expect(subcommandCounts["display-message"]).toBe(1);
    expect(subcommandCounts["send-keys"]).toBeGreaterThanOrEqual(2);

    // Registry contains the state
    expect(mod.interactiveSubagentRegistry.get(state.id)).toBe(state);
    // Cancel kills the pane
    const moreCalls: string[][] = [];
    installMockExec((_f, args) => {
      moreCalls.push(args);
      return "%42\n";
    });
    const mod2 = await importFresh();
    mod2.cancelInteractiveSubagent(state.id);
    expect(
      moreCalls.some((args) => args[0] === "kill-pane" && args.includes("-t") && args.includes("%42")),
    ).toBe(true);
    expect(mod2.interactiveSubagentRegistry.get(state.id)?.status).toBe("cancelled");
  });
});

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-tmux-"));
}

async function importFresh() {
  vi.resetModules();
  return import("./interactive-tmux");
}
