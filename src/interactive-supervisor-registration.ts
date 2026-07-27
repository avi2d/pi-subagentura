import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  INTERACTIVE_SUPERVISOR_SHORTCUT,
  type AsyncSupervisorItem,
  type InteractiveSupervisorItem,
  showInteractiveSupervisor,
} from "./interactive-supervisor-ui";
import {
  cancelInteractiveSubagent,
  cancelInteractiveDescendantByState,
  captureInteractiveSubagent,
  focusInteractiveSubagent,
  interactiveSubagentRegistry,
  showInteractiveSubagentNativeViewer,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import {
  cancelLineageSubtreeBestEffort,
  flattenLineageTree,
  projectLineageStore,
  resolveLineageStorePaths,
  type ProjectedLineageNode,
} from "./interactive-lineage";
import { getMux, type MuxName } from "./multiplexer";
import {
  abortJobTree,
  inProcessJobBelongsToOwner,
  jobRegistry,
  scheduleJobCleanup,
  type JobState,
} from "./helpers";
import { snapshotInProcessSession } from "./cancellation-snapshots";
import { updateRunningSubagentFooter } from "./artifact-poller";
import {
  normalizeCancelledWorkflowState,
  workflowJobsForOwner,
} from "./workflow-jobs";
import type {
  ActiveSessionContextToken,
  SessionContextRef,
} from "./session-context";

const SUPERVISOR_CAPTURE_MAX_BYTES = 16 * 1024;
const SUPERVISOR_CAPTURE_MAX_LINES = 200;

interface SupervisorProjection {
  items: InteractiveSupervisorItem[];
  nodes: Map<string, ProjectedLineageNode>;
}

export function directSupervisorItems(
  sessionId?: string,
): InteractiveSupervisorItem[] {
  return [...interactiveSubagentRegistry.values()]
    .filter(
      (state) => sessionId === undefined || state.parentSessionId === sessionId,
    )
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.id.localeCompare(right.id),
    )
    .map((state) => ({
      kind: "interactive",
      state,
      depth: 0,
      actionable: state.status === "running" || state.status === "idle",
    }));
}

export function buildAsyncSupervisorItems(
  interactiveItems: InteractiveSupervisorItem[],
  owner: ActiveSessionContextToken | undefined,
): AsyncSupervisorItem[] {
  const processJobs = [...jobRegistry.values()]
    .filter((job) => inProcessJobBelongsToOwner(job, owner))
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.id.localeCompare(right.id),
    );
  const visibleJobs = new Map(processJobs.map((job) => [job.id, job]));
  const processItems: AsyncSupervisorItem[] = processJobs.map((job) => ({
    kind: "in-process",
    job,
    depth: inProcessSupervisorDepth(job, visibleJobs),
    actionable: job.status === "running",
    reasons: job.status === "running" ? undefined : [job.status],
  }));
  const workflowItems: AsyncSupervisorItem[] = workflowJobsForOwner(owner)
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.id.localeCompare(right.id),
    )
    .map((job) => ({
      kind: "workflow",
      job,
      depth: 0,
      actionable: job.status === "running",
      reasons: job.status === "running" ? undefined : [job.status],
    }));
  const normalizedInteractive: AsyncSupervisorItem[] = interactiveItems.map(
    (item) => ({ ...item, kind: "interactive" }),
  );
  return [...processItems, ...workflowItems, ...normalizedInteractive];
}

function inProcessSupervisorDepth(
  job: JobState,
  visibleJobs: Map<string, JobState>,
  visiting = new Set<string>(),
): number {
  const parent = job.parentJobId ? visibleJobs.get(job.parentJobId) : undefined;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(job.id);
  if (!job.parentJobId || visiting.has(job.id)) return 0;
  if (!parent) return 0;
  return 1 + inProcessSupervisorDepth(parent, visibleJobs, nextVisiting);
}

function stateForNode(node: ProjectedLineageNode): InteractiveSubagentState {
  const existing = interactiveSubagentRegistry.get(node.manifest.agentId);
  if (existing) return existing;
  const manifest = node.manifest;
  const knownBackend =
    manifest.pane.backend === "tmux" || manifest.pane.backend === "zellij";
  const mux: MuxName = manifest.pane.backend === "zellij" ? "zellij" : "tmux";
  const attach = knownBackend
    ? getMux({ preference: mux }).buildAttachCommands({
        paneId: manifest.pane.paneId,
        windowName: manifest.pane.windowName,
        session: manifest.pane.muxSession,
      })
    : { attachCommand: "unavailable", focusCommand: "unavailable" };
  return {
    id: manifest.agentId,
    name: manifest.name,
    task: manifest.taskPreview,
    paneId: manifest.pane.paneId,
    windowName: manifest.pane.windowName,
    mux,
    muxSession: manifest.pane.muxSession,
    sessionFile: manifest.childSessionFile ?? "unknown",
    cwd: manifest.cwd,
    parentSessionId: manifest.ownerSessionId,
    startedAt: Date.parse(manifest.startedAt),
    status: node.state === "actionable" ? "running" : "unknown",
    attachCommand: attach.attachCommand,
    selectPaneCommand: attach.focusCommand,
    launchScriptFile: "unknown",
    artifactDir: manifest.artifactDir ?? "unknown",
  };
}

async function loadSupervisorProjection(
  sessionId: string | undefined,
): Promise<SupervisorProjection | undefined> {
  const rootId = process.env.PI_SUBAGENTURA_ROOT_ID ?? sessionId;
  if (!rootId) return undefined;
  const sessionRoot =
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT ??
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    join(homedir(), ".pi", "agent", "sessions");
  const paths = await resolveLineageStorePaths(sessionRoot, rootId);
  const projection = await projectLineageStore(
    paths.nodesDir,
    basename(paths.treeDir),
    async (manifest) => {
      if (
        manifest.pane.backend !== "tmux" &&
        manifest.pane.backend !== "zellij"
      ) {
        return true;
      }
      return !(await getMux({
        preference: manifest.pane.backend,
      }).isPaneAliveAsync(manifest.pane.paneId, manifest.pane.muxSession));
    },
  );
  const flattened = flattenLineageTree(projection.roots);
  const seen = new Set(flattened.map((node) => node.manifest.agentId));
  for (const node of projection.nonActionable) {
    if (!seen.has(node.manifest.agentId)) {
      flattened.push(node);
      seen.add(node.manifest.agentId);
    }
  }
  const items: InteractiveSupervisorItem[] = flattened.map((node) => ({
    state: stateForNode(node),
    depth: node.depth,
    actionable: node.state === "actionable",
    reasons: node.reasons,
  }));
  for (const state of interactiveSubagentRegistry.values()) {
    if (sessionId !== undefined && state.parentSessionId !== sessionId)
      continue;
    if (!seen.has(state.id)) {
      items.push({
        state,
        depth: 0,
        actionable: state.status === "running" || state.status === "idle",
      });
      seen.add(state.id);
    }
  }
  return {
    items,
    nodes: new Map(flattened.map((node) => [node.manifest.agentId, node])),
  };
}

export function registerInteractiveSupervisor(
  pi: ExtensionAPI,
  sessionContext?: SessionContextRef,
): void {
  const owner = (): ActiveSessionContextToken | undefined =>
    sessionContext
      ? { id: sessionContext.id, generation: sessionContext.generation }
      : undefined;
  const open = async (ctx: {
    ui: Parameters<typeof showInteractiveSupervisor>[0];
    sessionManager?: { getSessionId?: () => string };
  }) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const activeOwner = owner();
    let projection = await loadSupervisorProjection(sessionId).catch(
      () => undefined,
    );
    await showInteractiveSupervisor(ctx.ui, {
      items: () =>
        buildAsyncSupervisorItems(
          projection?.items ?? directSupervisorItems(sessionId),
          activeOwner,
        ),
      refresh: async () => {
        projection = await loadSupervisorProjection(sessionId).catch(
          () => projection,
        );
      },
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
      nativeView: async (state) => {
        const capture = await captureInteractiveSubagent(state, {
          maxBytes: SUPERVISOR_CAPTURE_MAX_BYTES,
          maxLines: SUPERVISOR_CAPTURE_MAX_LINES,
        });
        const opened = await showInteractiveSubagentNativeViewer(
          state,
          capture.output ||
            `${state.name} has no captured terminal output yet.`,
        );
        if (!opened) {
          ctx.ui.notify(
            "Native presentation is unavailable here; continuing with the portable Pi overlay.",
            "info",
          );
        }
      },
      cancelInProcess: (job) => {
        if (!cancelInProcessFromSupervisor(job, sessionId)) return false;
        updateRunningSubagentFooter(ctx.ui);
        return true;
      },
      cancelWorkflow: (job) => {
        if (job.status !== "running") return false;
        job.abort.abort();
        job.status = "cancelled";
        normalizeCancelledWorkflowState(job);
        return true;
      },
      cancel: (id) => {
        const direct = cancelInteractiveSubagent(id);
        if (direct) {
          updateRunningSubagentFooter(ctx.ui);
          return direct;
        }
        const item = projection?.items.find(
          (candidate) => candidate.state.id === id,
        );
        if (!item?.actionable) return undefined;
        cancelInteractiveDescendantByState(item.state);
        updateRunningSubagentFooter(ctx.ui);
        return item.state;
      },
      cancelSubtree: async (state) => {
        const confirmed = await ctx.ui.confirm(
          "Cancel interactive subagent subtree?",
          `Cancel ${state.name} and all descendants? This closes their mux panes but retains artifacts.`,
        );
        if (!confirmed) return;
        const root = projection?.nodes.get(state.id);
        if (!root) {
          cancelInteractiveSubagent(state.id);
          updateRunningSubagentFooter(ctx.ui);
          return;
        }
        const result = await cancelLineageSubtreeBestEffort(root, {
          isStale: async (node) => node.state !== "actionable",
          isTerminal: async (node) => {
            const direct = interactiveSubagentRegistry.get(
              node.manifest.agentId,
            );
            return direct
              ? direct.status === "cancelled" || direct.status === "exited"
              : false;
          },
          cancel: async (node) => {
            const nodeState = stateForNode(node);
            if (!cancelInteractiveSubagent(nodeState.id)) {
              cancelInteractiveDescendantByState(nodeState);
            }
          },
        });
        updateRunningSubagentFooter(ctx.ui);
        ctx.ui.notify(
          `Subtree cancellation: ${result.cancelled.length} cancelled, ${result.alreadyTerminal.length} already terminal, ${result.stale.length} stale, ${result.failed.length} failed.`,
          result.failed.length > 0 ? "warning" : "info",
        );
      },
    });
  };

  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut(INTERACTIVE_SUPERVISOR_SHORTCUT, {
      description: "Open the async subagent supervisor",
      handler: open,
    });
  }
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("subagents", {
      description: "Open the async subagent supervisor",
      handler: async (_args, ctx) => open(ctx),
    });
  }
}

function cancelInProcessFromSupervisor(
  job: JobState,
  sessionId: string | undefined,
): boolean {
  const info = {
    source: "supervisor" as const,
    initiator: sessionId,
    reason: `async supervisor cancelled job ${job.id}`,
  };
  if (job.status !== "running") return false;
  job.cancellation = { ...info, at: Date.now() };
  job.cancellationSnapshot = snapshotInProcessSession({
    kind: "in-process",
    jobId: job.id,
    session: job.session,
    cwd: job.cwd ?? process.cwd(),
    parentSessionId: sessionId,
    model: job.modelLabel,
    activeTool: job.liveStatus.activeTool,
    partialOutput: job.liveStatus.output,
    startedAt: job.startedAt,
    source: "supervisor",
    initiator: info.initiator,
    reason: info.reason,
  });
  abortJobTree(job.id, info);
  job.status = "cancelled";
  scheduleJobCleanup(job.id, true);
  return true;
}
