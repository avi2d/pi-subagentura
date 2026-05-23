import { describe, it, expect } from "vitest";

describe("debugLog", () => {
  it("does not throw when SUBAGENT_DEBUG_LOG_DIR is not set", async () => {
    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
    const { debugLog } = await import("./helpers");

    // Should not throw
    expect(() => debugLog("info", "test", {})).not.toThrow();
    expect(() => debugLog("error", "test_error", { err: "something" })).not.toThrow();
    expect(() => debugLog("warn", "test_warn", { key: "value", num: 42 })).not.toThrow();
  });

  it("does not throw when SUBAGENT_DEBUG_LOG_DIR is set to valid path", async () => {
    const { tmpdir } = await import("node:os");
    const { mkdirSync, existsSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const testDir = join(tmpdir(), `debug-log-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SUBAGENT_DEBUG_LOG_DIR = testDir;

    const { debugLog } = await import("./helpers");

    // Should not throw even when directory exists
    expect(() => debugLog("info", "test_event", { foo: "bar" })).not.toThrow();

    // Cleanup
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
  });

  it("does not throw when SUBAGENT_DEBUG_LOG_DIR is set to invalid path", async () => {
    process.env.SUBAGENT_DEBUG_LOG_DIR = "/nonexistent/path/that/cannot/be/created";
    const { debugLog } = await import("./helpers");

    // Should not throw - errors are caught internally
    expect(() => debugLog("info", "test", {})).not.toThrow();
    expect(() => debugLog("error", "test_error", { err: "failed" })).not.toThrow();

    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
  });

  it("accepts various log levels and data shapes", async () => {
    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
    const { debugLog } = await import("./helpers");

    expect(() => debugLog("info", "event1", {})).not.toThrow();
    expect(() => debugLog("warn", "event2", { nested: { obj: true } })).not.toThrow();
    expect(() => debugLog("error", "event3", { arr: [1, 2, 3] })).not.toThrow();
    expect(() => debugLog("debug", "event4", null as any)).not.toThrow();
    expect(() => debugLog("info", "event5", { date: new Date() })).not.toThrow();
  });
});
