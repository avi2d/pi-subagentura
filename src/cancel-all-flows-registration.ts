/**
 * Registers the ctrl+alt+x shortcut and /cancel-all-flows command.
 *
 * Both invoke the shared cancelAllFlows helper.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cancelAllFlows } from "./cancel-all-flows";

export function registerCancelAllFlows(pi: ExtensionAPI): void {
  // ── ctrl+alt+x shortcut ────────────────────────────────────────────
  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut("ctrl+alt+x", {
      description:
        "Cancel all active sub-agent flows (jobs, workflows, running interactive agents)",
      handler: async (ctx) => {
        // Stop foreground token use before waiting on child cancellations
        if (typeof ctx.abort === "function") {
          ctx.abort();
        }
        const result = await cancelAllFlows();
        const parts: string[] = [];
        if (result.jobsAborted > 0) parts.push(`${result.jobsAborted} job(s)`);
        if (result.workflowsAborted > 0)
          parts.push(`${result.workflowsAborted} workflow(s)`);
        if (result.interactiveKilled > 0)
          parts.push(`${result.interactiveKilled} interactive agent(s)`);
        if (result.interactivePreserved > 0)
          parts.push(`${result.interactivePreserved} idle agent(s) preserved`);

        if (parts.length === 0) {
          ctx.ui.notify("No active flows to cancel.", "info");
        } else {
          ctx.ui.notify(`Cancelled: ${parts.join(", ")}`, "warning");
        }
      },
    });
  }

  // ── /cancel-all-flows command fallback ──────────────────────────────
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("cancel-all-flows", {
      description:
        "Cancel all active sub-agent flows (jobs, workflows, running interactive agents)",
      handler: async (_args, ctx) => {
        // Stop foreground token use before waiting on child cancellations
        if (typeof ctx.abort === "function") {
          ctx.abort();
        }
        const result = await cancelAllFlows();
        const parts: string[] = [];
        if (result.jobsAborted > 0) parts.push(`${result.jobsAborted} job(s)`);
        if (result.workflowsAborted > 0)
          parts.push(`${result.workflowsAborted} workflow(s)`);
        if (result.interactiveKilled > 0)
          parts.push(`${result.interactiveKilled} interactive agent(s)`);
        if (result.interactivePreserved > 0)
          parts.push(`${result.interactivePreserved} idle agent(s) preserved`);

        if (parts.length === 0) {
          ctx.ui.notify("No active flows to cancel.", "info");
        } else {
          ctx.ui.notify(`Cancelled: ${parts.join(", ")}`, "warning");
        }
      },
    });
  }
}
