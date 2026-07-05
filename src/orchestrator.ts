import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const ORCHESTRATOR_PROMPT_PATH = fileURLToPath(
  new URL("../skills/orchestrator/SKILL.md", import.meta.url),
);
export const ORCHESTRATOR_STATUS_KEY = "subagentura-orchestrator";

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

function updateOrchestratorStatus(
  pi: Pick<ExtensionAPI, "getFlag">,
  ctx: ExtensionContext,
): boolean {
  const enabled = isOrchestratorEnabled(pi);
  try {
    ctx.ui.setStatus(
      ORCHESTRATOR_STATUS_KEY,
      enabled ? "🧭 orchestrator" : undefined,
    );
  } catch {
    /* UI context may be stale or unavailable during lifecycle transitions. */
  }
  return enabled;
}

export function registerOrchestratorPrompt(pi: ExtensionAPI): void {
  pi.registerFlag("orchestrator", {
    description:
      "Append pi-subagentura's parent-orchestrator guidance to the system prompt",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", (_event, ctx) => {
    updateOrchestratorStatus(pi, ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!updateOrchestratorStatus(pi, ctx)) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${readOrchestratorPrompt()}`,
    };
  });
}
