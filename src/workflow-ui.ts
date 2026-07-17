import type { WorkflowProgress } from "./workflow-core";
import { assertNever } from "./artifact";

// ── Workflow progress renderer ───────────────────────────────────────
export function renderProgress(p: WorkflowProgress): string {
  const parts = [`● workflow — ${p.agentsSpawned} agent(s)`];
  if (p.runningCount > 0) parts.push(`⚡ ${p.runningCount} running`);
  if (p.errorCount > 0) parts.push(`⚠ ${p.errorCount} error(s)`);
  parts.push(`${p.tokensSpent} tokens`);
  const head = parts.join(", ");
  switch (p.kind) {
    case "phase":
      return `${head}\n  ◆ phase: ${p.phase}`;
    case "log":
      return `${head}\n  ${p.message}`;
    case "agent_start": {
      const tag = p.model ? ` @${p.model}` : "";
      return `${head}\n  → started${p.label ? ` ${p.label}` : ""}${tag}`;
    }
    case "agent_done": {
      const tag = p.model ? ` @${p.model}` : "";
      return `${head}\n  → done${p.label ? ` ${p.label}` : ""}${tag}`;
    }
    default:
      return assertNever(p);
  }
}
