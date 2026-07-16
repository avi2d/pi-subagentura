/**
 * Session lifecycle handlers and interactive poller setup.
 *
 * Extracted from src/subagent.ts so the extension entrypoint can stay focused
 * on registration and public exports.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deleteInteractiveStatesFile } from "./artifact";
import { pollArtifactChanges } from "./artifact-poller";
import { flushDeliveries } from "./delivery";
import { flushInProcessDeliveries } from "./notifications";
import { jobRegistry } from "./helpers";
import { rehydrateInteractiveSubagents } from "./rehydrate";
import {
  cancelInteractiveSubagentByState,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { workflowJobRegistry } from "./workflow-jobs";

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
}

export function registerSessionHandlers(pi: ExtensionAPI): void {
  const g2 = getGlobalState() as any;

  g2.__piSubagenturaPiRef = pi;
  g2.__piSubagenturaParentStreaming = false;

  pi.on("agent_start", () => {
    g2.__piSubagenturaParentStreaming = true;
  });
  pi.on("agent_settled", () => {
    g2.__piSubagenturaParentStreaming = false;
    flushDeliveries(pi, g2.__piSubagenturaUi);
    flushInProcessDeliveries();
  });

  // Capture ctx.ui for the artifact poller (it runs from a setInterval and has no ctx).
  // The handler is registered on every default-export invocation; the last one wins,
  // which is the same pi the poller uses via __piSubagenturaPiRef.
  pi.on("session_start", (event, ctx) => {
    g2.__piSubagenturaUi = ctx.ui;
    g2.__piSubagenturaSessionManager = ctx.sessionManager;
    // Rehydrate on startup (resumed session after quit), reload, and resume.
    // The session ID filter ensures only subagents created in this specific session
    // are rehydrated. On 'new' and 'fork' we skip — those are explicit fresh starts.
    const shouldRehydrate =
      event.reason === "startup" ||
      event.reason === "reload" ||
      event.reason === "resume";
    if (shouldRehydrate) {
      try {
        rehydrateInteractiveSubagents(
          ctx.cwd,
          ctx.sessionManager?.getSessionId?.(),
          ctx.sessionManager?.getEntries?.() ?? [],
        );
      } catch {
        /* best effort — rehydrate is a recovery path; failures fall back to empty registry */
      }
    }
  });

  pi.on("session_shutdown", () => {
    // Don't null the ui ref here — the poller may still fire one last tick on shutdown,
    // and stale ctx errors are already caught at the call sites.
  });

  // Register notification renderer before any tools
  // One global interval for the whole session. Each tick walks the artifact dir of
  // every running interactive sub-agent and fires pointer notifications for new events.
  // The poller survives parent restarts through persisted artifacts and byte cursors.
  if (!g2.__piSubagenturaInteractivePollerHandle) {
    const handle = setInterval(() => pollArtifactChanges(pi), 5000);
    // Don't pin the event loop on a long-lived parent. unref() lets the process exit
    // cleanly when nothing else is keeping it alive (no other ref'd handles).
    handle.unref?.();
    g2.__piSubagenturaInteractivePollerHandle = handle;
  }

  // ── Session shutdown: abort all jobs, kill tmux panes, stop the poller ─
  (pi as any).on?.(
    "session_shutdown",
    (
      event: { reason?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      const g2 = getGlobalState() as any;

      // Stop the global poller so it doesn't fire after we're gone. Without
      // clearInterval the handle would keep the event loop alive across restarts.
      if (g2.__piSubagenturaInteractivePollerHandle) {
        try {
          clearInterval(g2.__piSubagenturaInteractivePollerHandle);
        } catch {
          /* defensive */
        }
        g2.__piSubagenturaInteractivePollerHandle = undefined;
      }

      // Snapshot live state objects before clearing. Non-preserving shutdowns
      // kill their panes; reload/resume/quit leave them for rehydration.
      const runningStates: InteractiveSubagentState[] = [];
      for (const state of interactiveSubagentRegistry.values()) {
        if (state.status === "running" || state.status === "idle") {
          runningStates.push(state);
        }
      }

      // Drop in-memory state FIRST. An in-flight poll tick (dequeued from
      // setInterval before clearInterval ran) finds an empty registry and its
      // for-loop iterates over zero entries — no work, no notification delivery.
      try {
        interactiveSubagentRegistry.clear();
      } catch {
        /* best effort */
      }

      const preserveInteractivePanes =
        event?.reason === "reload" ||
        event?.reason === "resume" ||
        event?.reason === "quit";
      if (!preserveInteractivePanes) {
        // Kill the panes using the already-snapshotted states.
        // cancelInteractiveSubagentByState is used (not the id-based variant)
        // because the registry was already cleared above.
        for (const state of runningStates) {
          try {
            cancelInteractiveSubagentByState(state);
          } catch {
            /* best effort */
          }
        }
      }

      // Abort all running subagent sessions before clearing
      for (const job of jobRegistry.values()) {
        if (job.status === "running") {
          try {
            job.session.abort().catch(() => {});
          } catch {
            /* session may already be disposed */
          }
        }
      }

      // Workflow workers are bound to this parent context. Suppress completion
      // before aborting so late settlement cannot notify a replacement session.
      for (const workflow of workflowJobRegistry.values()) {
        workflow.suppressCompletionNotification = true;
        if (workflow.status === "running") workflow.abort.abort();
      }

      jobRegistry.clear();
      workflowJobRegistry.clear();
      g2.__piSubagenturaPiRef = undefined;
      g2.__piSubagenturaSessionManager = undefined;
      g2.__piSubagenturaParentStreaming = false;
      // Clean-slate the state file on /new. On quit/reload/resume we KEEP the file so the
      // next session_start can rehydrate the sub-agents (their panes survive).
      if (event?.reason === "new" && ctx?.cwd) {
        try {
          deleteInteractiveStatesFile(ctx.cwd);
        } catch {
          /* best effort */
        }
      }
    },
  );
}
