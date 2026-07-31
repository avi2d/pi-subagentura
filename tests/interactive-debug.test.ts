import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendInteractiveDebugEvent } from "../src/interactive-debug";

describe("interactive debug events", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes bounded structured events without changing the artifact protocol", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagentura-debug-"));
    tempDirs.push(dir);
    const longValue = "x".repeat(512);

    appendInteractiveDebugEvent(dir, "turn_bind", {
      turnId: "turn-1",
      persistedUserEntryId: longValue,
    });

    const event = JSON.parse(readFileSync(join(dir, "debug.ndjson"), "utf8"));
    expect(event).toMatchObject({ event: "turn_bind", turnId: "turn-1" });
    expect(event.persistedUserEntryId).toHaveLength(256);
    expect(event.pid).toEqual(expect.any(Number));
    expect(event.ts).toEqual(expect.any(Number));
    expect(existsSync(join(dir, "events.ndjson"))).toBe(false);
  });
});
