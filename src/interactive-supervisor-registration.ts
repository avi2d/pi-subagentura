import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  INTERACTIVE_SUPERVISOR_SHORTCUT,
  showInteractiveSupervisor,
} from "./interactive-supervisor-ui";
import {
  captureInteractiveSubagent,
  focusInteractiveSubagent,
} from "./interactive-tmux";

const SUPERVISOR_CAPTURE_MAX_BYTES = 16 * 1024;
const SUPERVISOR_CAPTURE_MAX_LINES = 200;

export function registerInteractiveSupervisor(pi: ExtensionAPI): void {
  const open = async (ctx: {
    ui: Parameters<typeof showInteractiveSupervisor>[0];
  }) => {
    await showInteractiveSupervisor(ctx.ui, {
      focus: focusInteractiveSubagent,
      view: async (state) => {
        const capture = await captureInteractiveSubagent(state, {
          maxBytes: SUPERVISOR_CAPTURE_MAX_BYTES,
          maxLines: SUPERVISOR_CAPTURE_MAX_LINES,
        });
        const suffix = capture.truncated ? "\n… output truncated" : "";
        ctx.ui.notify(
          capture.output.length > 0
            ? `${state.name} terminal output:\n${capture.output}${suffix}`
            : `${state.name} has no captured terminal output yet.`,
          "info",
        );
      },
    });
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
