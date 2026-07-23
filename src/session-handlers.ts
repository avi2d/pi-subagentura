/**
 * Session lifecycle handlers and interactive poller setup.
 *
 * Extracted from src/subagent.ts so the extension entrypoint can stay focused
 * on registration and public exports.
 */

import {
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { deleteInteractiveStatesFile } from "./artifact";
import { pollArtifactChanges } from "./artifact-poller";
import { flushDeliveries } from "./delivery";
import { flushInProcessDeliveries } from "./notifications";
import { jobRegistry } from "./helpers";
import { snapshotInProcessSession } from "./cancellation-snapshots";
import { rehydrateInteractiveSubagents } from "./rehydrate";
import {
  cancelInteractiveSubagentByState,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { workflowJobRegistry } from "./workflow-jobs";

type SessionManagerLike = {
  getSessionId?: () => string;
};

interface ExtensionSessionContext {
  sessionId?: string;
  pi: ExtensionAPI;
  ui: ExtensionUIContext | undefined;
  sessionManager: SessionManagerLike | undefined;
  parentStreaming: boolean;
  isRoot: boolean;
}

declare global {
  var __piSubagenturaSessionContexts: ExtensionSessionContext[] | undefined;
}

function getSessionContextStack(): ExtensionSessionContext[] {
  const g = getGlobalState() as {
    __piSubagenturaSessionContexts?: ExtensionSessionContext[];
  };
  if (!g.__piSubagenturaSessionContexts) {
    g.__piSubagenturaSessionContexts = [];
  }
  return g.__piSubagenturaSessionContexts;
}

function getCurrentSessionId(
  sessionManager: SessionManagerLike | undefined,
): string | undefined {
  try {
    return sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function setActiveExtensionContext(
  context: ExtensionSessionContext | undefined,
): void {
  const g2 = getGlobalState() as {
    __piSubagenturaPiRef?: ExtensionAPI;
    __piSubagenturaUi?: ExtensionUIContext;
    __piSubagenturaSessionManager?: SessionManagerLike;
    __piSubagenturaParentStreaming?: boolean;
  };
  if (!context) {
    g2.__piSubagenturaPiRef = undefined;
    g2.__piSubagenturaUi = undefined;
    g2.__piSubagenturaSessionManager = undefined;
    g2.__piSubagenturaParentStreaming = false;
    return;
  }

  g2.__piSubagenturaPiRef = context.pi;
  g2.__piSubagenturaUi = context.ui;
  g2.__piSubagenturaSessionManager = context.sessionManager;
  g2.__piSubagenturaParentStreaming = context.parentStreaming;
}

function ownsSessionContext(
  candidate: ExtensionSessionContext,
  sessionId: string | undefined,
): boolean {
  if (sessionId === undefined) return false;
  return candidate.sessionId === sessionId;
}

function popSessionContext(sessionId: string | undefined): {
  restoredContext?: ExtensionSessionContext;
  isRootShutdown: boolean;
  removedContext?: ExtensionSessionContext;
} {
  const stack = getSessionContextStack();
  const [rootContext] = stack;

  if (stack.length === 0) {
    setActiveExtensionContext(undefined);
    return { isRootShutdown: true };
  }

  let removedIndex = -1;
  let removedContext: ExtensionSessionContext | undefined;
  if (sessionId) {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (ownsSessionContext(stack[index], sessionId)) {
        removedIndex = index;
        break;
      }
    }
  }

  // If we cannot identify the context, fallback to the active session.
  if (removedIndex < 0) {
    removedContext = stack.pop();
  } else {
    removedContext = stack.splice(removedIndex, 1)[0];
  }

  const isRootShutdown = Boolean(
    removedContext?.isRoot ||
    (removedContext && stack.length > 0 && removedContext === rootContext),
  );

  if (isRootShutdown) {
    stack.length = 0;
    setActiveExtensionContext(undefined);
    return { removedContext, isRootShutdown: true };
  }

  if (stack.length === 0) {
    setActiveExtensionContext(undefined);
    return { removedContext, isRootShutdown: true };
  }

  // If the removed context was not the currently active one, keep the head
  // context unchanged. Otherwise restore the next-live child.
  const nextActive = stack[stack.length - 1];
  setActiveExtensionContext(nextActive);
  return { removedContext, restoredContext: nextActive, isRootShutdown: false };
}

function pushSessionContext(context: ExtensionSessionContext): void {
  const stack = getSessionContextStack();

  // Replace an existing entry for the same session to avoid stale duplicates.
  if (context.sessionId !== undefined) {
    for (let index = 0; index < stack.length; index += 1) {
      if (stack[index].sessionId === context.sessionId) {
        stack.splice(index, 1);
        break;
      }
    }
  }

  // Root sessions are always the first context.
  context.isRoot = stack.length === 0;

  stack.push(context);
  setActiveExtensionContext(context);
}

function updateStreamingState(isStreaming: boolean): void {
  const stack = getSessionContextStack();
  const current = stack[stack.length - 1];
  const g2 = getGlobalState() as {
    __piSubagenturaParentStreaming?: boolean;
    __piSubagenturaPiRef?: ExtensionAPI;
    __piSubagenturaUi?: ExtensionUIContext;
  };
  g2.__piSubagenturaParentStreaming = isStreaming;
  if (current) {
    current.parentStreaming = isStreaming;
    setActiveExtensionContext(current);
  }
}

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
}

export function registerSessionHandlers(pi: ExtensionAPI): void {
  const g2 = getGlobalState() as any;
  setActiveExtensionContext({
    pi,
    ui: g2.__piSubagenturaUi,
    sessionManager: g2.__piSubagenturaSessionManager as
      SessionManagerLike | undefined,
    parentStreaming: g2.__piSubagenturaParentStreaming ?? false,
    isRoot: true,
  });

  pi.on("agent_start", () => {
    updateStreamingState(true);
  });
  pi.on("agent_settled", () => {
    updateStreamingState(false);
    flushDeliveries(pi, g2.__piSubagenturaUi);
    flushInProcessDeliveries();
  });

  // Capture ctx.ui for the artifact poller (it runs from a setInterval and has no ctx).
  // The handler is registered on every default-export invocation so each session can
  // restore itself on top of the context stack.
  pi.on("session_start", (event, ctx) => {
    const sessionId = getCurrentSessionId(
      ctx?.sessionManager as SessionManagerLike | undefined,
    );
    pushSessionContext({
      pi,
      ui: ctx?.ui,
      sessionManager: ctx?.sessionManager as SessionManagerLike | undefined,
      sessionId,
      parentStreaming: false,
      isRoot: false,
    });
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
    const handle = setInterval(() => {
      void pollArtifactChanges(pi).catch((err) => {
        console.error("[subagentura] artifact poll failed", err);
      });
    }, 5000);
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
      const shutdownSessionId = getCurrentSessionId(
        ctx?.sessionManager as SessionManagerLike | undefined,
      );
      const shutdownState = popSessionContext(shutdownSessionId);

      // Child/session-scoped shutdown: only clear resources owned by the session
      // that is closing. Keep global registries and running poller intact for parent
      // sessions.
      if (!shutdownState.isRootShutdown) {
        const preserveInteractivePanes =
          event?.reason === "reload" ||
          event?.reason === "resume" ||
          event?.reason === "quit";

        // Snapshot live state objects before clearing. Non-preserving shutdowns
        // kill their panes; reload/resume/quit leave them for rehydration.
        const runningStates: InteractiveSubagentState[] = [];
        for (const state of interactiveSubagentRegistry.values()) {
          if (state.parentSessionId !== shutdownSessionId) {
            continue;
          }
          if (state.status === "running" || state.status === "idle") {
            runningStates.push(state);
          }
        }

        try {
          for (const [id, state] of interactiveSubagentRegistry.entries()) {
            if (state.parentSessionId === shutdownSessionId) {
              interactiveSubagentRegistry.delete(id);
            }
          }
        } catch {
          /* best effort */
        }

        if (!preserveInteractivePanes) {
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

        // Snapshot and abort in-process jobs owned by the child session.
        for (const [jobId, job] of jobRegistry.entries()) {
          if (job.ownerSessionId !== shutdownSessionId) continue;
          if (job.status === "running") {
            job.cancellation = { ...shutdownCancellation, at: Date.now() };
            job.cancellationSnapshot = snapshotInProcessSession({
              kind: "in-process",
              jobId,
              session: job.session,
              cwd: job.cwd ?? ctx?.cwd ?? process.cwd(),
              model: job.modelLabel,
              activeTool: job.liveStatus?.activeTool,
              partialOutput: job.liveStatus?.output,
              source: "session_shutdown",
              initiator: shutdownCancellation.initiator,
              reason: shutdownCancellation.reason,
            });
            if (job.abort) {
              try {
                job.abort.abort(shutdownCancellation);
              } catch {
                /* already aborted */
              }
            } else {
              job.session.abort().catch(() => {});
            }
          }
          jobRegistry.delete(jobId);
        }

        // Workflow workers are bound to one session context.
        for (const [workflowId, workflow] of workflowJobRegistry.entries()) {
          if (
            (workflow as { ownerSessionId?: string }).ownerSessionId !==
            shutdownSessionId
          ) {
            continue;
          }
          workflow.suppressCompletionNotification = true;
          if (workflow.status === "running") {
            workflow.abort.abort();
          }
          workflowJobRegistry.delete(workflowId);
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

      let shutdownInitiator: string | undefined;
      try {
        shutdownInitiator = ctx?.sessionManager?.getSessionId?.();
      } catch {
        shutdownInitiator = undefined;
      }
      const shutdownCancellation = {
        source: "session_shutdown" as const,
        initiator: shutdownInitiator,
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
