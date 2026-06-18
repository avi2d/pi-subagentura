import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(
  join(import.meta.dirname, "workflows", "ralplan-occ.js"),
  "utf8",
);

describe("ralplan-occ.js banned tokens", () => {
  const patterns: Array<{ regex: RegExp; label: string }> = [
    { regex: /\bDate\.now\s*\(/, label: "Date.now(" },
    { regex: /\bMath\.random\s*\(/, label: "Math.random(" },
    { regex: /\bnew\s+Date\s*\(\s*\)/, label: "new Date()" },
    { regex: /\brequire\s*\(/, label: "require(" },
    { regex: /\bprocess\./, label: "process." },
    { regex: /\bfs\./, label: "fs." },
    { regex: /\bpath\./, label: "path." },
  ];

  for (const { regex, label } of patterns) {
    it(`${label} is not present in the script`, () => {
      const match = SCRIPT.match(regex);
      expect(match).toBeNull();
    });
  }
});

describe("signal array invariants (drift fence)", () => {
  it("DELIBERATE_SIGNALS has exactly 22 entries", () => {
    // Extract the DELIBERATE_SIGNALS array literal from the script
    const match = SCRIPT.match(/const DELIBERATE_SIGNALS = (\[[\s\S]*?\]);/);
    expect(match).not.toBeNull();
    const arrayText = match![1];
    // Count string literals: each entry is "..." (comma-separated)
    const entries = arrayText.match(/"[^"]*"/g);
    expect(entries).toHaveLength(22);
  });

  it("WORD_BOUNDARY_SIGNALS has exactly 1 entry: 'rm'", () => {
    const match = SCRIPT.match(/const WORD_BOUNDARY_SIGNALS = (\[[\s\S]*?\]);/);
    expect(match).not.toBeNull();
    const arrayText = match![1];
    const entries = arrayText.match(/"[^"]*"/g);
    expect(entries).toHaveLength(1);
    expect(entries![0]).toBe('"rm"');
  });
});
