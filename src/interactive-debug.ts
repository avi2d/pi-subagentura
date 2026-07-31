import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEBUG_FILE = "debug.ndjson";
const MAX_DEBUG_STRING = 256;
const MAX_DEBUG_KEYS = 32;
const MAX_DEBUG_ITEMS = 16;

function boundDebugValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, MAX_DEBUG_STRING);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth >= 2) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DEBUG_ITEMS)
      .map((item) => boundDebugValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_DEBUG_KEYS)
        .map(([key, item]) => [key, boundDebugValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, MAX_DEBUG_STRING);
}

export function appendInteractiveDebugEvent(
  artifactDir: string,
  event: string,
  data: Record<string, unknown> = {},
): void {
  try {
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const bounded = boundDebugValue(data) as Record<string, unknown>;
    appendFileSync(
      join(artifactDir, DEBUG_FILE),
      JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        event,
        ...bounded,
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics must never change the child lifecycle or delivery outcome.
  }
}
