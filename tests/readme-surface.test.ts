import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import registerExtension from "../src/subagent";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const README = readFileSync(resolve(REPO, "README.md"), "utf8");

function section(start: string, end: string): string {
  const startIndex = README.indexOf(start);
  const endIndex = README.indexOf(end, startIndex + start.length);
  expect(startIndex, `README is missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `README is missing ${end}`).toBeGreaterThan(startIndex);
  return README.slice(startIndex, endIndex);
}

/** Registers the extension in the requested parent mode and records its surface. */
function registerSurface(onlyInteractive: boolean) {
  const tools: string[] = [];
  const commands: string[] = [];
  const api = {
    registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
    registerCommand: vi.fn((name: string) => commands.push(name)),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    on: vi.fn(),
  };
  const previousChild = process.env.PI_SUBAGENTURA_CHILD;
  const previousMode = process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE;
  delete process.env.PI_SUBAGENTURA_CHILD;
  if (onlyInteractive) process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE = "1";
  else delete process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE;
  try {
    registerExtension(api as any);
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENTURA_CHILD;
    else process.env.PI_SUBAGENTURA_CHILD = previousChild;
    if (previousMode === undefined)
      delete process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE;
    else process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE = previousMode;
  }
  return { tools, commands };
}

describe("README public surface", () => {
  it("inventories every registered public tool and slash command", () => {
    const { tools, commands } = registerSurface(false);

    const toolInventory = section(
      "## Agent-facing tools",
      "## How it compares",
    );
    const commandInventory = section(
      "## User commands",
      "## Agent-facing tools",
    );

    expect(tools).toHaveLength(21);
    expect(commands).toHaveLength(8);
    for (const name of tools) {
      expect(toolInventory, `Missing tool inventory row for ${name}`).toContain(
        `| \`${name}\``,
      );
    }
    for (const name of commands) {
      expect(
        commandInventory,
        `Missing command inventory row for /${name}`,
      ).toContain(`| \`/${name}\``);
    }
  });

  it("inventories the only-interactive mode subset and what it drops", () => {
    const full = registerSurface(false);
    const mode = registerSurface(true);
    const dropped = full.tools.filter((name) => !mode.tools.includes(name));

    const registered = section(
      "### Registered in only-interactive mode",
      "### Not registered in only-interactive mode",
    );
    const notRegistered = section(
      "### Not registered in only-interactive mode",
      "## Reusable workflows",
    );

    expect(mode.tools).toHaveLength(8);
    expect(mode.commands).toEqual(["cancel-all-flows"]);
    expect(dropped).toHaveLength(13);

    for (const name of mode.tools) {
      expect(
        registered,
        `Missing only-interactive tool row for ${name}`,
      ).toContain(`| \`${name}\``);
    }
    for (const name of mode.commands) {
      expect(
        registered,
        `Missing only-interactive command mention for /${name}`,
      ).toContain(`\`/${name}\``);
    }
    for (const name of dropped) {
      expect(
        notRegistered,
        `Tool ${name} is dropped in only-interactive mode but not documented as removed`,
      ).toContain(`\`${name}\``);
      expect(
        registered,
        `Tool ${name} is not registered in only-interactive mode but is listed as registered`,
      ).not.toContain(`\`${name}\``);
    }
  });
});
