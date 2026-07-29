/** Session lifecycle handlers and interactive poller setup.

 * Extracted from src/subagent.ts so the extension entrypoint can stay focused
 * on registration and public exports.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deleteInteractiveStatesFile } from "./artifact";
import { clearSessionParsers, pollArtifactChanges } from "./artifact-poller";
import { flushDeliveries } from "./delivery";
import { flushInProcessDeliveries } from "./notifications";
import { inProcessJobBelongsToOwner, jobRegistry } from "./helpers";
import { snapshotInProcessSession } from "./cancellation-snapshots";
import { rehydrateInteractiveSubagents } from "./rehydrate";
import {
  cancelInteractiveSubagentByState,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { cleanupWorkflowJobsForOwner } from "./workflow-jobs";
import {
  advanceSessionContextGeneration,
  createSessionContextRef,
  getSessionContextStack,
  registerSessionContext,
  removeSessionContext,
  setActiveSessionRefs,
  type ActiveSessionContextToken,
  type SessionContextRef,
} from "./session-context";
import { closeActiveInteractiveSupervisor } from "./interactive-supervisor-ui";

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
}

function ensureInteractivePoller(globalState: any): void {
  if (globalState.__piSubagenturaInteractivePollerHandle) return;
  const handle = setInterval(() => {
    for (const context of [...getSessionContextStack()]) {
      if (context.lifecycle !== "started") continue;
      void pollArtifactChanges(context.pi, {
        id: context.id,
        generation: context.generation,
      }).catch((err) => {
        console.error("[subagentura] artifact poll failed", err);
      });
    }
  }, 5000);
  handle.unref?.();
  globalState.__piSubagenturaInteractivePollerHandle = handle;
}

// Older releases could start a poller during extension preload, before project
// package overrides selected the live runtime. Replace that orphan on session_start.
function discardPreSessionPollerState(
  globalState: any,
  sessionContext: SessionContextRef,
): void {
  const contexts = [...getSessionContextStack()];
  const hasStartedContext = contexts.some(
    (context) => context.lifecycle === "started",
  );
  const ownIndex = contexts.findIndex(
    (context) => context.id === sessionContext.id,
  );
  for (const [index, context] of contexts.entries()) {
    // A started context after this ancestor belongs to an older nested
    // lifecycle whose shutdown was omitted. Stack position, not a
    // SessionManager accessor, is the reliable ownership signal.
    const staleDescendant =
      ownIndex >= 0 && index > ownIndex && context.lifecycle === "started";
    if (staleDescendant) {
      context.lifecycle = "shutdown";
      advanceSessionContextGeneration(context.id);
      removeSessionContext(context.id);
    }
  }
  const handle = globalState.__piSubagenturaInteractivePollerHandle;
  if (hasStartedContext || !handle) return;
  try {
    clearInterval(handle);
  } catch {
    /* A stale legacy handle must not block the live session's poller. */
  }
  globalState.__piSubagenturaInteractivePollerHandle = undefined;
}

export function registerSessionHandlers(pi: ExtensionAPI): SessionContextRef {
  const sessionContext = createSessionContextRef(pi);
  const g2 = getGlobalState() as any;
  registerSessionContext(sessionContext);
  setActiveSessionRefs(sessionContext);

  g2.__piSubagenturaPiRef = pi;
  g2.__piSubagenturaParentStreaming = false;

  pi.on("agent_start", () => {
    g2.__piSubagenturaParentStreaming = true;
  });
  pi.on("agent_settled", () => {
    g2.__piSubagenturaParentStreaming = false;
    flushDeliveries(pi, sessionContext.ui, {
      id: sessionContext.id,
      generation: sessionContext.generation,
    });
    flushInProcessDeliveries();
  });

  // Capture ctx.ui for the artifact poller (it runs from a setInterval and has no ctx).
  // The handler is registered on every default-export invocation; the last one wins,
  // which is the same pi the poller uses via __piSubagenturaPiRef.
  pi.on("session_start", (event, ctx) => {
    const previousOwner: ActiveSessionContextToken = {
      id: sessionContext.id,
      generation: sessionContext.generation,
    };
    discardPreSessionPollerState(g2, sessionContext);
    cleanupWorkflowJobsForOwner(previousOwner);
    sessionContext.generation++;
    sessionContext.lifecycle = "started";
    sessionContext.ui = ctx.ui;
    sessionContext.sessionManager = ctx.sessionManager;
    registerSessionContext(sessionContext);
    setActiveSessionRefs(sessionContext);
    g2.__piSubagenturaUi = ctx.ui;
    g2.__piSubagenturaSessionManager = ctx.sessionManager;
    g2.__piSubagenturaPiRef = pi;
    g2.__piSubagenturaParentStreaming = false;

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
    ensureInteractivePoller(g2);
  });

  pi.on("session_shutdown", () => {
    closeActiveInteractiveSupervisor();
    // Don't null the ui ref here — the poller may still fire one last tick on shutdown,
    // and stale ctx errors are already caught at the call sites.
  });

  // ── Session shutdown: abort all jobs, kill tmux panes, stop the poller ─
  (pi as any).on?.(
    "session_shutdown",
    (
      event: { reason?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      const g2 = getGlobalState() as any;
      const contextStack = getSessionContextStack();
      const contextIndex = contextStack.findIndex(
        (entry) => entry.id === sessionContext.id,
      );
      if (contextIndex < 0) return;

      // Only started ancestors registered before this context may keep the
      // shared poller and registries alive. Descendants are structurally owned
      // by this context; a missed nested shutdown must not outlive its parent.
      const startedAncestors = contextStack
        .slice(0, contextIndex)
        .filter((context) => context.lifecycle === "started");
      const descendants = contextStack.slice(contextIndex + 1);

      const shutdownOwner: ActiveSessionContextToken = {
        id: sessionContext.id,
        generation: sessionContext.generation,
      };
      let shutdownSessionId: string | undefined;
      try {
        shutdownSessionId = ctx?.sessionManager?.getSessionId?.();
      } catch {
        shutdownSessionId = undefined;
      }
      sessionContext.lifecycle = "shutdown";
      advanceSessionContextGeneration(sessionContext.id);
      removeSessionContext(sessionContext.id);
      for (const descendant of descendants) {
        descendant.lifecycle = "shutdown";
        advanceSessionContextGeneration(descendant.id);
        removeSessionContext(descendant.id);
      }
      setActiveSessionRefs(startedAncestors[startedAncestors.length - 1]);
      g2.__piSubagenturaParentStreaming = false;

      // Context-owned workflows must be torn down even when a nested session
      // remains active above or below this handler in the global stack.
      cleanupWorkflowJobsForOwner(shutdownOwner);

      // A live ancestor may defer global teardown while this nested context
      // cleans its own state. Descendants never participate in this decision:
      // if their shutdown hook was omitted, their lifecycle is stale.
      if (startedAncestors.length > 0) {
        const preserveInteractivePanes =
          event?.reason === "reload" ||
          event?.reason === "resume" ||
          event?.reason === "quit";
        // An absent session id must match nothing. `parentSessionId` is
        // legitimately undefined for states spawned without a parent session,
        // and `undefined === undefined` would kill every unrelated pane.
        const ownedStates =
          shutdownSessionId === undefined
            ? []
            : [...interactiveSubagentRegistry.values()].filter(
                (state) => state.parentSessionId === shutdownSessionId,
              );
        for (const state of ownedStates) {
          interactiveSubagentRegistry.delete(state.id);
          if (
            !preserveInteractivePanes &&
            (state.status === "running" || state.status === "idle")
          ) {
            try {
              cancelInteractiveSubagentByState(state);
            } catch {
              /* best effort */
            }
          }
        }

        const cancellation = {
          source: "session_shutdown" as const,
          initiator: shutdownSessionId,
          reason: `session_shutdown (${event?.reason ?? "unknown"})`,
        };
        const ownedJobs = [...jobRegistry.entries()].filter(([, job]) =>
          inProcessJobBelongsToOwner(job, shutdownOwner),
        );
        // Snapshot every owned job before any abort can wait for idle. The
        // top-level path and cancelInProcessFromSupervisor both guarantee a
        // partial-output snapshot; a nested shutdown must not lose it.
        for (const [, job] of ownedJobs) {
          if (job.status !== "running") continue;
          job.cancellation = { ...cancellation, at: Date.now() };
          job.cancellationSnapshot = snapshotInProcessSession({
            kind: "in-process",
            jobId: job.id,
            session: job.session,
            cwd: job.cwd ?? ctx?.cwd ?? process.cwd(),
            parentSessionId: shutdownSessionId,
            model: job.modelLabel,
            activeTool: job.liveStatus?.activeTool,
            partialOutput: job.liveStatus?.output,
            startedAt: job.startedAt,
            source: "session_shutdown",
            initiator: cancellation.initiator,
            reason: cancellation.reason,
          });
        }
        for (const [jobId, job] of ownedJobs) {
          if (job.status === "running") {
            try {
              if (job.abort) job.abort.abort(cancellation);
              else void job.session.abort().catch(() => {});
            } catch {
              /* session may already be disposed */
            }
          }
          jobRegistry.delete(jobId);
        }
        return;
      }

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
        clearSessionParsers();
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

      const shutdownCancellation = {
        source: "session_shutdown" as const,
        initiator: shutdownSessionId,
        reason: `session_shutdown (${event?.reason ?? "unknown"})`,
      };
      // Snapshot all in-process jobs before any abort can wait for idle.
      for (const job of jobRegistry.values()) {
        if (job.status !== "running") continue;
        job.cancellation = { ...shutdownCancellation, at: Date.now() };
        job.cancellationSnapshot = snapshotInProcessSession({
          kind: "in-process",
          jobId: job.id,
          session: job.session,
          cwd: job.cwd ?? ctx?.cwd ?? process.cwd(),
          model: job.modelLabel,
          activeTool: job.liveStatus?.activeTool,
          partialOutput: job.liveStatus?.output,
          source: "session_shutdown",
          initiator: shutdownCancellation.initiator,
          reason: shutdownCancellation.reason,
        });
      }
      // Abort all running subagent sessions before clearing. Prefer the
      // controller so descendants are torn down too.
      for (const job of jobRegistry.values()) {
        if (job.status === "running") {
          try {
            if (job.abort) job.abort.abort(shutdownCancellation);
            else job.session.abort().catch(() => {});
          } catch {
            /* session may already be disposed */
          }
        }
      }

      jobRegistry.clear();
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

  return sessionContext;
}
