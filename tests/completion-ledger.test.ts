import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendLedgerLine,
  appendLedgerLineLossless,
  readLedgerLines,
  scanLedgerLines,
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
  it("scans a fixed initial snapshot and bounds oversized multi-chunk lines", () => {
    root = mkdtempSync(join(tmpdir(), "completion-ledger-scan-"));
    const path = sessionLedgerPath(root, "session-a", "scan");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(path, `${"x".repeat(128 * 1024)}\nfirst\nsecond\n`, {
      mode: 0o600,
    });

    const lines: string[] = [];
    scanLedgerLines(path, 1024, (line) => {
      lines.push(line);
      if (line === "first") appendLedgerLineLossless(path, "late");
    });

    expect(lines).toEqual(["first", "second"]);
    expect(readFileSync(path, "utf8")).toContain("late\n");
  });

  it("bounds total scan bytes and accepted records", () => {
    root = mkdtempSync(join(tmpdir(), "completion-ledger-scan-budget-"));
    const path = sessionLedgerPath(root, "session-a", "scan-budget");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      path,
      `${Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n")}\n`,
      { mode: 0o600 },
    );

    const lines: string[] = [];
    const result = scanLedgerLines(path, 1024, (line) => lines.push(line), {
      maxScanBytes: 64,
      maxRecords: 2,
    });

    expect(lines).toEqual(["line-0", "line-1"]);
    expect(result.acceptedRecords).toBe(2);
    expect(result.scannedBytes).toBeLessThanOrEqual(64);
    expect(result.truncated).toBe(true);
  });

  it("continues dropping oversized lines across scan snapshots", () => {
    root = mkdtempSync(join(tmpdir(), "completion-ledger-scan-resume-"));
    const path = sessionLedgerPath(root, "session-a", "scan-resume");
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(path, "x".repeat(2 * 1024), { mode: 0o600 });

    const firstLines: string[] = [];
    const first = scanLedgerLines(path, 1024, (line) => firstLines.push(line));
    expect(firstLines).toEqual([]);
    expect(first.dropping).toBe(true);

    appendFileSync(path, `${JSON.stringify({ consumed: true })}\nkept\n`);
    const resumedLines: string[] = [];
    const resumed = scanLedgerLines(
      path,
      1024,
      (line) => resumedLines.push(line),
      {
        startOffset: first.nextOffset,
        dropping: first.dropping,
      },
    );
    expect(resumedLines).toEqual(["kept"]);
    expect(resumed.dropping).toBe(false);
  });

  it("repairs partial tails before byte-accurate lossless appends", () => {
    root = mkdtempSync(join(tmpdir(), "completion-ledger-lossless-"));
    const path = sessionLedgerPath(root, "session-a", "receipts");
    mkdirSync(join(root, ".pi"), { recursive: true });

    writeFileSync(path, Buffer.from('{"partial":true}', "utf8"), {
      mode: 0o600,
    });
    appendLedgerLineLossless(path, JSON.stringify({ text: "π" }));
    expect(readFileSync(path, "utf8")).toBe('{"partial":true}\n{"text":"π"}\n');

    writeFileSync(path, Buffer.from('{"newlyPartial":', "utf8"));
    appendLedgerLineLossless(path, JSON.stringify({ text: "€" }));
    expect(readFileSync(path, "utf8")).toBe('{"newlyPartial":\n{"text":"€"}\n');
  });
});
