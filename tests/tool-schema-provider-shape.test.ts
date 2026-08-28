/**
 * Every tool schema this package hands the harness has to survive being
 * forwarded to a provider verbatim.
 *
 * The Anthropic Messages API rejects `oneOf`, `allOf` and `anyOf` at the root
 * of a tool's `input_schema` with a 400. Pi's own Anthropic adapter happens to
 * project the schema down to `{type, properties, required}` before sending it,
 * so a root composition keyword is invisible there. Not every adapter does:
 * `pi-claude-bridge` forwards the schema as given, and v3.4.0 shipped a
 * `Type.Intersect` root on `subagent_interactive` that took down every turn on
 * that provider, sub-agent calls and plain prompts alike.
 *
 * So this asserts the property on the schemas as registered, rather than on a
 * copy of one adapter's projection. A schema is only correct here if it is
 * correct for an adapter that does nothing.
 */
import { describe, expect, it, vi } from "vitest";

import registerExtension from "../src/subagent";

const ROOT_COMPOSITION_KEYWORDS = ["oneOf", "allOf", "anyOf"] as const;

/** Collect `{name, parameters}` for every tool the extension registers. */
function registeredTools(): { name: string; parameters: unknown }[] {
  const tools: { name: string; parameters: unknown }[] = [];
  const api = {
    registerTool: vi.fn((tool: { name: string; parameters: unknown }) => {
      tools.push({ name: tool.name, parameters: tool.parameters });
    }),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };
  registerExtension(api as never);
  return tools;
}

describe("registered tool parameter schemas", () => {
  it("registers tools at all", () => {
    const names = registeredTools().map((t) => t.name);
    expect(names).toContain("subagent_interactive");
    expect(names.length).toBeGreaterThan(5);
  });

  it("carries no composition keyword at the root of any schema", () => {
    const offenders = registeredTools()
      .map(({ name, parameters }) => {
        const keys = Object.keys((parameters ?? {}) as object);
        const found = ROOT_COMPOSITION_KEYWORDS.filter((k) => keys.includes(k));
        return found.length ? `${name}: ${found.join("+")}` : null;
      })
      .filter((x): x is string => x !== null);

    expect(offenders).toEqual([]);
  });

  it("declares every schema as a plain object schema", () => {
    for (const { name, parameters } of registeredTools()) {
      const schema = (parameters ?? {}) as { type?: unknown };
      expect(`${name}:${String(schema.type)}`).toBe(`${name}:object`);
    }
  });
});
