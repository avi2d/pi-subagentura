import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";

// Use dynamic import after setting env var
const testDir = join(
  process.env.TEMP_DIR || "/tmp",
  `debug-log-test-${Date.now()}`,
);
const currentLogFile = () =>
  join(testDir, `debug-${new Date().toISOString().slice(0, 10)}.jsonl`);

describe("debugLog", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      const logFile = currentLogFile();
      if (existsSync(logFile)) unlinkSync(logFile);
      rmdirSync(testDir);
    } catch {}
  });

  it("writes log entry to file when SUBAGENT_DEBUG_LOG_DIR is set", async () => {
    process.env.SUBAGENT_DEBUG_LOG_DIR = testDir;

    // Need to re-import after setting env var since DEBUG_LOG_DIR is cached at load
    vi.resetModules();
    const { debugLog } = await import("../src/helpers");

    debugLog("info", "test_event", { foo: "bar", num: 42 });

    const logFile = currentLogFile();
    expect(existsSync(logFile)).toBe(true);

    const content = readFileSync(logFile, "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.level).toBe("info");
    expect(entry.event).toBe("test_event");
    expect(entry.foo).toBe("bar");
    expect(entry.num).toBe(42);
    expect(entry.timestamp).toBeDefined();

    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
  });

  it("does not write when SUBAGENT_DEBUG_LOG_DIR is not set", async () => {
    delete process.env.SUBAGENT_DEBUG_LOG_DIR;

    vi.resetModules();
    const { debugLog } = await import("../src/helpers");

    // Should not throw
    expect(() => debugLog("info", "test", {})).not.toThrow();
  });

  it("logs error events with correct level", async () => {
    process.env.SUBAGENT_DEBUG_LOG_DIR = testDir;

    vi.resetModules();
    const { debugLog } = await import("../src/helpers");

    debugLog("error", "subagent_error", {
      jobId: "test-job",
      error: "something broke",
    });

    const logFile = currentLogFile();
    const content = readFileSync(logFile, "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.level).toBe("error");
    expect(entry.event).toBe("subagent_error");
    expect(entry.jobId).toBe("test-job");
    expect(entry.error).toBe("something broke");

    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
  });

  it("captures tool name and args on tool_start events", async () => {
    process.env.SUBAGENT_DEBUG_LOG_DIR = testDir;

    vi.resetModules();
    const { debugLog } = await import("../src/helpers");

    const toolArgs = { command: "rg TODO src/", timeout: 5000 };
    debugLog("info", "tool_start", {
      jobId: "job-123",
      toolName: "bash",
      args: toolArgs,
    });

    const logFile = currentLogFile();
    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);

    expect(entry.event).toBe("tool_start");
    expect(entry.toolName).toBe("bash");
    expect(entry.args).toEqual(toolArgs);
    expect(entry.jobId).toBe("job-123");

    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
  });
});
