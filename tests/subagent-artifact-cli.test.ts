import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CLI_SOURCE, writeCliScript } from "../src/subagent-artifact-cli";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-cli-"));
}

function runCli(
  artDir: string,
  args: string[],
  input?: string,
): { status: number; stdout: string; stderr: string } {
  // Write the CLI source to the artifact dir, then invoke it.
  const cliPath = join(artDir, "cli.mjs");
  writeCliScript(cliPath);
  const res = spawnSync("node", [cliPath, ...args], {
    env: { ...process.env, ARTIFACT_DIR: artDir },
    input,
    encoding: "utf8",
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("subagent-artifact CLI", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("source", () => {
    it("starts with a shebang", () => {
      expect(CLI_SOURCE.startsWith("#!/usr/bin/env node")).toBe(true);
    });

    it("parses as valid JavaScript (node --check)", () => {
      // Strip the shebang (node can't parse it as a file) and write to a
      // temp .mjs file, then `node --check` it.
      const body = CLI_SOURCE.replace(/^#!.*\n/, "");
      const target = join(tmp, "check.mjs");
      writeFileSync(target, body);
      const r = spawnSync("node", ["--check", target], { encoding: "utf8" });
      expect({ status: r.status, stderr: r.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
    });

    it("the generated cli.mjs is 0o700", () => {
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      expect(statSync(cliPath).mode & 0o777).toBe(0o700);
    });
  });

  describe("start", () => {
    it("writes a started event", () => {
      const r = runCli(tmp, ["start"]);
      expect(r.status).toBe(0);
      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n");
      expect(events).toHaveLength(1);
      const ev = JSON.parse(events[0]);
      expect(ev.type).toBe("started");
      expect(ev.status).toBe("running");
      expect(typeof ev.ts).toBe("number");
    });
  });

  describe("done", () => {
    it("writes a done event with exit code 0 → status done", () => {
      runCli(tmp, ["done", "0"]);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.type).toBe("completion");
      expect(ev.outcome).toBe("done");
      expect(ev.status).toBe("done");
      expect(ev.exitCode).toBe(0);
    });

    it("writes a done event with non-zero exit code → status error", () => {
      runCli(tmp, ["done", "1"]);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.status).toBe("error");
      expect(ev.exitCode).toBe(1);
    });

    it("serializes concurrent completion writers for one turn", async () => {
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({ turnId: "shared-turn", startedAt: Date.now() }),
      );
      writeFileSync(join(tmp, "output.md"), "stable output");

      const commands = Array.from({ length: 16 }, (_, index) =>
        index % 3 === 0 ? ["cancelled"] : ["done", "0"],
      );
      await Promise.all(
        commands.map(
          (args) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn("node", [cliPath, ...args], {
                env: { ...process.env, ARTIFACT_DIR: tmp },
              });
              child.once("error", reject);
              child.once("exit", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`completion writer exited ${code}`));
              });
            }),
        ),
      );

      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.filter(
          (event) =>
            event.type === "completion" && event.turnId === "shared-turn",
        ),
      ).toHaveLength(1);
      expect(existsSync(join(tmp, "outputs"))).toBe(true);
    });
  });

  describe("error", () => {
    it("writes an error event with message", () => {
      runCli(tmp, ["error", "boom"]);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.type).toBe("completion");
      expect(ev.outcome).toBe("error");
      expect(ev.status).toBe("error");
      expect(ev.message).toBe("boom");
    });
  });

  describe("cancelled", () => {
    it("writes a cancelled event", () => {
      runCli(tmp, ["cancelled"]);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.type).toBe("completion");
      expect(ev.outcome).toBe("cancelled");
      expect(ev.status).toBe("cancelled");
    });
  });

  describe("errors", () => {
    it("fails when ARTIFACT_DIR is unset", () => {
      // Spawn without ARTIFACT_DIR
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      const r = spawnSync("node", [cliPath, "start"], {
        env: { ...process.env, ARTIFACT_DIR: "" },
        encoding: "utf8",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("ARTIFACT_DIR not set");
    });

    it("fails on unknown subcommand", () => {
      const r = runCli(tmp, ["bogus"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Unknown command");
    });
  });
});
