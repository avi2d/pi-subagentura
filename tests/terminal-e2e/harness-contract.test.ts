import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.mjs";

async function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(
      () => rejectPromise(new Error("timed out waiting for child output")),
      15_000,
    );
    stream.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolvePromise(buffer.slice(0, newline));
    });
  });
}

describe("terminal harness lifecycle", () => {
  it("kills a server created before pane discovery fails", async () => {
    const harness = createHarness({ scenario: "startup-failure" });
    const runTmux = harness.tmux.bind(harness);
    harness.tmux = (args, options) => {
      if (args[0] === "display-message") {
        throw new Error("injected pane discovery failure");
      }
      return runTmux(args, options);
    };

    const startError = await harness.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(startError)).toContain("injected pane discovery failure");
    await harness.cleanup(true);

    expect(() =>
      execFileSync("tmux", ["-L", harness.socket, "has-session"], {
        stdio: "ignore",
        timeout: 2_000,
      }),
    ).toThrow();
  });

  it("kills active harnesses when the test process receives SIGTERM", async () => {
    const harnessUrl = new URL("./harness.mjs", import.meta.url).href;
    const script = `import { createHarness } from ${JSON.stringify(harnessUrl)}; const harness = createHarness({ scenario: "signal" }); await harness.start(); console.log(JSON.stringify({ socket: harness.socket, root: harness.root })); setInterval(() => {}, 1000);`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      const info = JSON.parse(await nextLine(child.stdout));
      const exited = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolvePromise) => {
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      });
      child.kill("SIGTERM");
      const result = await exited;
      const processes = execFileSync("ps", ["-axo", "command="], {
        encoding: "utf8",
      });

      expect(result).toEqual({ code: 143, signal: null });
      expect(processes).not.toContain(info.root);
      expect(() =>
        execFileSync("tmux", ["-L", info.socket, "has-session"], {
          stdio: "ignore",
          timeout: 2_000,
        }),
      ).toThrow();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    expect(stderr).toBe("");
  }, 30_000);
});
