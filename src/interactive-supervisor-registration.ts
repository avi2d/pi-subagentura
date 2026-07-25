import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  INTERACTIVE_SUPERVISOR_SHORTCUT,
  showInteractiveSupervisor,
} from "./interactive-supervisor-ui";

export function registerInteractiveSupervisor(pi: ExtensionAPI): void {
  const open = async (ctx: {
    ui: Parameters<typeof showInteractiveSupervisor>[0];
  }) => {
    await showInteractiveSupervisor(ctx.ui);
  };

  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut(INTERACTIVE_SUPERVISOR_SHORTCUT, {
      description: "Open the interactive subagent supervisor",
      handler: open,
    });
  }
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("subagents", {
      description: "Open the interactive subagent supervisor",
      handler: async (_args, ctx) => open(ctx),
    });
  }
}
