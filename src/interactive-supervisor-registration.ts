import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  INTERACTIVE_SUPERVISOR_SHORTCUT,
  type InteractiveSupervisorItem,
  showInteractiveSupervisor,
} from "./interactive-supervisor-ui";
import {
  cancelInteractiveSubagent,
  cancelInteractiveSubagentByState,
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

const SUPERVISOR_CAPTURE_MAX_BYTES = 16 * 1024;
const SUPERVISOR_CAPTURE_MAX_LINES = 200;

interface SupervisorProjection {
  items: InteractiveSupervisorItem[];
  nodes: Map<string, ProjectedLineageNode>;
}

function directSupervisorItems(): InteractiveSupervisorItem[] {
  return [...interactiveSubagentRegistry.values()]
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.id.localeCompare(right.id),
    )
    .map((state) => ({ state, depth: 0, actionable: true }));
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
    if (!seen.has(state.id)) {
      items.push({ state, depth: 0, actionable: true });
      seen.add(state.id);
    }
  }
  return {
    items,
    nodes: new Map(flattened.map((node) => [node.manifest.agentId, node])),
  };
}

export function registerInteractiveSupervisor(pi: ExtensionAPI): void {
  const open = async (ctx: {
    ui: Parameters<typeof showInteractiveSupervisor>[0];
    sessionManager?: { getSessionId?: () => string };
  }) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    let projection = await loadSupervisorProjection(sessionId).catch(
      () => undefined,
    );
    await showInteractiveSupervisor(ctx.ui, {
      items: () => projection?.items ?? directSupervisorItems(),
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
      cancel: (id) => {
        const direct = cancelInteractiveSubagent(id);
        if (direct) return direct;
        const item = projection?.items.find(
          (candidate) => candidate.state.id === id,
        );
        if (!item?.actionable) return undefined;
        cancelInteractiveSubagentByState(item.state);
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
              cancelInteractiveSubagentByState(nodeState);
            }
          },
        });
        ctx.ui.notify(
          `Subtree cancellation: ${result.cancelled.length} cancelled, ${result.alreadyTerminal.length} already terminal, ${result.stale.length} stale, ${result.failed.length} failed.`,
          result.failed.length > 0 ? "warning" : "info",
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
