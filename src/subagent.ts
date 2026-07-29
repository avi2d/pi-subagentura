/**
 * pi-subagentura — In-process and interactive sub-agent tools for Pi.
 *
 * ## Public API
 *
 * **Extension entry** — default export: the extension activator function.
 *
 * **Type** — `SubagentDetails`: discriminated-union partial-result type surfaced
 * to the parent session's message renderer.
 *
 * ## Internal / testing re-exports
 *
 * The named exports below are re-exported from implementation modules for test
 * access and internal wiring. They are NOT part of the supported public API
 * and may change without a major version bump. Prefer importing from the source
 * module (`./helpers`, `./interactive-tmux`, etc.) if you depend on them.
 *
 * @module pi-subagentura
 */

import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
  type SubagentLiveStatus,
  type SubagentResult,
  type Usage,
} from "./helpers";
import { registerWorkflowTool } from "./workflow";
import {
  ONLY_INTERACTIVE_MAINTENANCE_TOOLS,
  registerInProcessMaintenanceTools,
  registerInProcessSubagentTools,
} from "./tools/in-process";
import { registerInteractiveSubagentTools } from "./tools/interactive";
import { registerSessionHandlers } from "./session-handlers";
import { registerChildProtocol } from "./child-protocol";
import { registerCancelAllFlows } from "./cancel-all-flows-registration";
import { renderSubagentNotify } from "./rendering";
import { registerInteractiveSupervisor } from "./interactive-supervisor-registration";
/** @internal Session-rehydration helper used by session-handlers.ts */
export { rehydrateInteractiveSubagents } from "./rehydrate";
/**
 * Discriminated union describing the live status of a sub-agent job.
 * Used by `renderSubagentResult` and surfaced via `AgentToolResult.details`.
 *
 * Cases:
 * - `"started"` — async job launched, jobId available
 * - `"running"` — (in-process only) polling for live status
 * - `"done"` | `"error"` — completed with usage info
 * - `"cancelled"` | `"not_found"` — terminal states
 * - `"invalid_id"` — caller passed an unrecognised id
 */
export type SubagentDetails =
  | {
      status: "started";
      jobId: string;
      contextMessages: number;
      thinkingLevel?: ThinkingLevel;
    }
  | {
      status: "running";
      subagentStatus: SubagentLiveStatus;
      model?: string;
      thinkingLevel?: ThinkingLevel;
    }
  | {
      status: "done" | "error";
      usage: Usage;
      model?: string;
      usageSummary?: string;
      thinkingLevel?: ThinkingLevel;
      contextMessages?: number;
    }
  | { status: "cancelled" | "not_found" }
  | { status: "invalid_id"; id: string };

const ORCHESTRATOR_SYSTEM_PROMPT = readFileSync(
  new URL("../ORCHESTRATOR_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();

/**
 * Reduced orchestration guidance for only-interactive mode: the full prompt
 * instructs the model to use in-process and script-orchestration tools that are
 * not registered in that mode.
 */
const ONLY_INTERACTIVE_ORCHESTRATOR_SYSTEM_PROMPT = readFileSync(
  new URL("../ORCHESTRATOR_ONLY_INTERACTIVE_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();

/**
 * Detects only-interactive mode from load-time signals — deliberately NOT from
 * `pi.getFlag("only-interactive")`.
 *
 * `getFlag` is unusable during activation: Pi must load extensions first to
 * learn which flags exist, and applies CLI flag values only afterwards
 * (`resourceLoader.reload()` runs every extension factory before
 * `applyExtensionFlagValues()` in @earendil-works/pi-coding-agent's
 * `core/agent-session-services.js`). Until that point `getFlag` returns the
 * default `registerFlag` seeded — i.e. `false` — so a flag read here always
 * loses. Flags are only readable lazily, from inside an event handler; see the
 * `before_agent_start` handler below, which is why `--orchestrator` can use
 * `getFlag`.
 *
 * This mode decides *tool registration*, which happens during activation, so it
 * reads the signals that already exist then: the env var (programmatic and test
 * use) and raw argv (so the documented CLI flag works). `--only-interactive` is
 * still registered via `registerFlag` so `--help` lists it and Pi's flag
 * validation accepts it.
 */
function isOnlyInteractiveMode(): boolean {
  return (
    process.env.PI_SUBAGENTURA_ONLY_INTERACTIVE === "1" ||
    process.argv.includes("--only-interactive")
  );
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENTURA_CHILD === "1") {
    registerChildProtocol(pi);
    if (typeof pi.registerMessageRenderer === "function") {
      pi.registerMessageRenderer("subagent-notify", renderSubagentNotify);
    }
    const sessionScope = registerSessionHandlers(pi);
    registerInteractiveSubagentTools(pi, sessionScope);
    registerSubagentArtifactsCleanupTool(pi, sessionScope);
    registerSubagentModelListTool(pi);
    registerInteractiveSupervisor(pi, sessionScope);
    return;
  }
  if (typeof pi.registerMessageRenderer !== "function") {
    throw new Error(
      "pi-subagentura requires Pi >= 0.80.6 with agent_settled and custom message renderer support",
    );
  }
  pi.registerFlag("orchestrator", {
    description: "Append the bundled orchestration system prompt",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("only-interactive", {
    description:
      "Register only attachable interactive sub-agent tools, model listing, and artifact cleanup",
    type: "boolean",
    default: false,
  });
  const onlyInteractive = isOnlyInteractiveMode();
  pi.on("before_agent_start", (event) => {
    if (pi.getFlag("orchestrator") !== true) return;
    const prompt = onlyInteractive
      ? ONLY_INTERACTIVE_ORCHESTRATOR_SYSTEM_PROMPT
      : ORCHESTRATOR_SYSTEM_PROMPT;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    };
  });
  pi.registerMessageRenderer("subagent-notify", renderSubagentNotify);
  const sessionScope = registerSessionHandlers(pi);
  registerInteractiveSubagentTools(pi, sessionScope);
  if (onlyInteractive) {
    registerInProcessMaintenanceTools(pi, {
      scope: sessionScope,
      include: ONLY_INTERACTIVE_MAINTENANCE_TOOLS,
    });
  } else {
    registerWorkflowTool(pi, sessionScope);
    registerInProcessSubagentTools(pi, sessionScope);
    registerInProcessMaintenanceTools(pi, sessionScope);
  }
  registerInteractiveSupervisor(pi, sessionScope);
  // ── Cancel-all-flows shortcut and command ──────────────────────
  registerCancelAllFlows(pi, sessionScope);
}

/**
 * ── Internal helpers (re-exported for test access) ──
 *
 * These are implementation details of the in-process sub-agent machinery.
 * They are re-exported here so that tests and internal consumers (e.g.
 * session-handlers.ts) can import them through the package entry point.
 *
 * API consumers SHOULD NOT depend on these exports directly — they may
 * be renamed, moved, or removed in a minor release.
 */
export {
  formatUsage,
  SubagentResult,
  SubagentLiveStatus,
  ACTIVE_TOOL_DEBOUNCE_MS,
  // ── Async job machinery ──
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
export { getInjectCount, MAX_INJECT } from "./notifications";
/** @internal Interactive-subagent registry, consumed by session-handlers and tests */
export { interactiveSubagentRegistry } from "./interactive-tmux";
/** @internal Inject-count guard; exported for test assertions */
/** @internal Artifact-change poller; exported for test access */
export { pollArtifactChanges } from "./artifact-poller";
/** @internal Interactive-artifact lookup; exported for test access */
export { findArtifactById } from "./tools/interactive";
