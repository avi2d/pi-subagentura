import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORCHESTRATOR_PROMPT_PATH = fileURLToPath(
  new URL("../skills/orchestrator/SKILL.md", import.meta.url),
);

let cachedPrompt: string | null = null;

function envEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && !["0", "false", "no", "off"].includes(normalized);
}

export function isOrchestratorEnabled(
  pi: Pick<ExtensionAPI, "getFlag">,
): boolean {
  return (
    Boolean(pi.getFlag("orchestrator")) ||
    envEnabled(process.env.PI_ORCHESTRATOR)
  );
}

export function readOrchestratorPrompt(): string {
  cachedPrompt ??= readFileSync(ORCHESTRATOR_PROMPT_PATH, "utf8").trim();
  return cachedPrompt;
}

export function registerOrchestratorPrompt(pi: ExtensionAPI): void {
  pi.registerFlag("orchestrator", {
    description:
      "Append pi-subagentura's parent-orchestrator guidance to the system prompt",
    type: "boolean",
    default: false,
  });

  pi.on("before_agent_start", (event) => {
    if (!isOrchestratorEnabled(pi)) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${readOrchestratorPrompt()}`,
    };
  });
}
