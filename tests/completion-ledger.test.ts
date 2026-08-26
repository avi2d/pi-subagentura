import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendLedgerLine,
  readLedgerLines,
  sessionLedgerPath,
} from "../src/completion-ledger";

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("completion ledger", () => {
  it("keeps records and bytes bounded while reporting rotation", () => {
    root = mkdtempSync(join(tmpdir(), "completion-ledger-"));
    const path = sessionLedgerPath(root, "session-a", "overflow");
    const first = appendLedgerLine(path, JSON.stringify({ id: 1 }), {
      maxRecords: 2,
      maxBytes: 100,
    });
    const second = appendLedgerLine(path, JSON.stringify({ id: 2 }), {
      maxRecords: 2,
      maxBytes: 100,
    });
    const third = appendLedgerLine(path, JSON.stringify({ id: 3 }), {
      maxRecords: 2,
      maxBytes: 100,
    });

    expect(first.dropped).toBe(0);
    expect(second.dropped).toBe(0);
    expect(third.dropped).toBe(1);
    expect(readLedgerLines(path, 100).lines).toEqual([
      JSON.stringify({ id: 2 }),
      JSON.stringify({ id: 3 }),
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("fails closed on a symlink ledger path", () => {
    root = mkdtempSync(join(tmpdir(), "completion-ledger-symlink-"));
    const target = join(root, "target.ndjson");
    const path = join(root, "ledger.ndjson");
    mkdirSync(root, { recursive: true });
    symlinkSync(target, path);

    expect(() =>
      appendLedgerLine(path, JSON.stringify({ id: 1 }), {
        maxRecords: 2,
        maxBytes: 100,
      }),
    ).toThrow();
  });
  it("fails closed on a symlinked parent directory", () => {
    root = mkdtempSync(join(tmpdir(), "completion-ledger-parent-symlink-"));
    const linked = join(root, "linked");
    const path = join(linked, ".pi", "ledger.ndjson");
    symlinkSync(root, linked);
    expect(() =>
      appendLedgerLine(path, JSON.stringify({ id: 1 }), {
        maxRecords: 2,
        maxBytes: 100,
      }),
    ).toThrow();
  });
});
