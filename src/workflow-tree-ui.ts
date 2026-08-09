import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  getWorkflowCompletionPresentation,
  workflowJobsForOwner,
  type WorkflowJobState,
} from "./workflow-jobs";
import {
  formatWorkflowUsage,
  formatWorkflowUsageFields,
  formatWorkflowUsageLegend,
  presentWorkflowUsage,
} from "./workflow-core";
import { formatWorkflowPlanRows } from "./workflow-plan-ui";
import type { WorkflowPlanState } from "./workflow-plan-state";
import type { SessionOwnerToken } from "./session-scope";
import type { WorkflowProjection } from "./workflow-projection-repository";

const MAX_WORKFLOW_TREE_AGENT_ROWS = 20;

type WorkflowSnapshotWithPlanState = WorkflowJobState["snapshot"] & {
  planState?: WorkflowPlanState;
};

export type WorkflowTreeAction =
  { kind: "cancel"; workflowId: string } | { kind: "close" };

type WorkflowTreeDone = (action: WorkflowTreeAction) => void;

interface WorkflowTreeOptions {
  done: WorkflowTreeDone;
  owner?: SessionOwnerToken;
  durableProjections?: readonly WorkflowProjection[];
  requestRender?: () => void;
  notify?: (message: string) => void;
}

interface WorkflowRow {
  job?: WorkflowJobState;
  projection?: WorkflowProjection;
  depth: number;
  text: string;
  selectable: boolean;
}

type WorkflowTreeSelection =
  | { kind: "live"; id: string; job: WorkflowJobState }
  | { kind: "durable"; id: string; projection: WorkflowProjection };

export class WorkflowTreeComponent {
  private selectedWorkflowIndex = 0;
  private expanded = new Set<string>();
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly opts: WorkflowTreeOptions) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const rows = this.rows();
    const lines: string[] = [];
    lines.push(trunc("┌ Workflow Tree", width));
    lines.push(
      trunc(
        "│ ↑↓ select • enter/→ expand • ← collapse • c cancel • q/esc close",
        width,
      ),
    );
    lines.push(trunc(`│ ${formatWorkflowUsageLegend()}`, width));

    if (rows.length === 0) {
      lines.push(trunc("│ No workflow jobs.", width));
    } else {
      let workflowOrdinal = -1;
      for (const row of rows) {
        if (row.selectable) workflowOrdinal++;
        const selected =
          row.selectable && workflowOrdinal === this.selectedWorkflowIndex;
        const marker = selected ? "▶" : row.selectable ? "○" : " ";
        const indent = "  ".repeat(row.depth);
        lines.push(trunc(`│ ${marker} ${indent}${row.text}`, width));
      }
    }

    lines.push(trunc(`└${"─".repeat(Math.max(0, width - 2))}┘`, width));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    const jobs = selectableWorkflows(
      this.opts.owner,
      this.opts.durableProjections,
    );
    if (data === "q" || data === "\x1b") {
      this.opts.done({ kind: "close" });
      return;
    }
    if (jobs.length === 0) return;

    if (data === "\x1b[A" || data === "k") {
      this.selectedWorkflowIndex = Math.max(0, this.selectedWorkflowIndex - 1);
      this.changed();
      return;
    }
    if (data === "\x1b[B" || data === "j") {
      this.selectedWorkflowIndex = Math.min(
        jobs.length - 1,
        this.selectedWorkflowIndex + 1,
      );
      this.changed();
      return;
    }

    const selected = jobs[this.selectedWorkflowIndex];
    if (!selected) return;

    if (data === "\r" || data === "\n" || data === "\x1b[C") {
      this.toggle(selected.id);
      return;
    }
    if (data === "\x1b[D") {
      this.expanded.delete(selected.id);
      this.changed();
      return;
    }
    if (data === "c") {
      this.cancel(selected);
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private rows(): WorkflowRow[] {
    const rows: WorkflowRow[] = [];
    for (const item of selectableWorkflows(
      this.opts.owner,
      this.opts.durableProjections,
    )) {
      const isExpanded = this.expanded.has(item.id);
      if (item.kind === "live") {
        rows.push({
          job: item.job,
          depth: 0,
          selectable: true,
          text: `${isExpanded ? "▾" : "▸"} ${formatWorkflowSummary(item.job)}`,
        });
        if (isExpanded) rows.push(...formatWorkflowDetails(item.job));
      } else {
        rows.push({
          projection: item.projection,
          depth: 0,
          selectable: true,
          text: `${isExpanded ? "▾" : "▸"} ${formatDurableWorkflowSummary(item.projection)}`,
        });
        if (isExpanded) {
          rows.push(...formatDurableWorkflowDetails(item.projection));
        }
      }
    }
    return rows;
  }

  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.changed();
  }

  private cancel(item: WorkflowTreeSelection): void {
    if (item.kind === "durable") {
      if (item.projection.terminal) {
        this.opts.notify?.(
          `Workflow ${item.id} is ${item.projection.terminal.status}; nothing to cancel.`,
        );
        return;
      }
      this.opts.notify?.(`Cancelling durable workflow ${item.id}.`);
      this.opts.done({ kind: "cancel", workflowId: item.id });
      return;
    }
    const job = item.job;
    if (job.status !== "running") {
      this.opts.notify?.(
        `Workflow ${job.id} is ${job.status}; nothing to cancel.`,
      );
      return;
    }
    this.opts.notify?.(`Cancelling workflow ${job.id}.`);
    this.opts.done({ kind: "cancel", workflowId: job.id });
  }

  private changed(): void {
    this.invalidate();
    this.opts.requestRender?.();
  }
}

export async function showWorkflowTree(
  ui: ExtensionUIContext,
  owner?: SessionOwnerToken,
  durableProjections: readonly WorkflowProjection[] = [],
): Promise<WorkflowTreeAction> {
  const custom = (ui as any).custom;
  if (typeof custom !== "function") {
    ui.notify("Workflow tree UI is not available in this Pi session.");
    return { kind: "close" };
  }
  return custom.call(
    ui,
    (
      tui: { requestRender?: () => void },
      _theme: unknown,
      _kb: unknown,
      done: WorkflowTreeDone,
    ) =>
      new WorkflowTreeComponent({
        done,
        owner,
        durableProjections,
        requestRender: () => tui.requestRender?.(),
        notify: (message) => ui.notify(message),
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        minWidth: 60,
        maxHeight: "80%",
      },
    },
  );
}

function selectableWorkflows(
  owner?: SessionOwnerToken,
  durableProjections: readonly WorkflowProjection[] = [],
): WorkflowTreeSelection[] {
  const live = workflowJobsForOwner(owner);
  const liveIds = new Set(live.map((job) => job.id));
  return [
    ...live.map((job): WorkflowTreeSelection => ({
      kind: "live",
      id: job.id,
      job,
    })),
    ...durableProjections
      .filter((projection) => !liveIds.has(projection.runId))
      .map((projection): WorkflowTreeSelection => ({
        kind: "durable",
        id: projection.runId,
        projection,
      })),
  ];
}
function formatWorkflowSummary(job: WorkflowJobState): string {
  const s = job.snapshot;
  const planState = (s as WorkflowSnapshotWithPlanState).planState;
  const errorCount = job.result?.errorCount ?? s.errorCount;
  const presentation = getWorkflowCompletionPresentation(
    job.status,
    errorCount,
  );
  const statusPrefix = presentation.icon ? `${presentation.icon} ` : "";
  const parts = [
    `${statusPrefix}${job.name} (${job.id})`,
    `[${presentation.label}]`,
    `${s.agentsSpawned} agent${s.agentsSpawned === 1 ? "" : "s"}`,
    `${s.runningCount ?? 0} running`,
  ];
  if (errorCount > 0) parts.push(`${errorCount} errors`);
  const usage = presentWorkflowUsage(s.usage);
  if (usage) {
    parts.push(formatWorkflowUsage(usage, { outputBudget: s.budgetTotal }));
  }
  const currentPhase = planState?.currentPhase ?? s.currentPhase;
  if (currentPhase) parts.push(`phase: ${currentPhase}`);
  return parts.join(" · ");
}

function formatDurableWorkflowSummary(projection: WorkflowProjection): string {
  const tasks = Object.values(projection.tasks);
  const running = tasks.filter((task) => task.status === "running").length;
  const errors = tasks.filter((task) => task.status === "failed").length;
  const marker =
    projection.status === "done"
      ? "✓ "
      : projection.status === "error"
        ? "✗ "
        : projection.status === "cancelled"
          ? "⊘ "
          : projection.status === "interrupted"
            ? "‼ "
            : "";
  const parts = [
    `${marker}durable (${projection.runId})`,
    `[${projection.status}]`,
    `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
    `${running} running`,
  ];
  if (errors > 0) parts.push(`${errors} errors`);
  const usage = presentWorkflowUsage(projection.usage);
  if (usage) parts.push(formatWorkflowUsage(usage));
  if (projection.currentPhase) {
    parts.push(`phase: ${projection.currentPhase}`);
  }
  return parts.join(" · ");
}

function formatDurableWorkflowDetails(
  projection: WorkflowProjection,
): WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  const usage = presentWorkflowUsage(projection.usage);
  if (usage) {
    for (const field of formatWorkflowUsageFields(usage)) {
      rows.push({
        projection,
        depth: 1,
        selectable: false,
        text: field,
      });
    }
  }
  let previousPhase: string | undefined;
  for (const task of Object.values(projection.tasks)) {
    if (task.phaseId !== previousPhase) {
      previousPhase = task.phaseId;
      rows.push({
        projection,
        depth: 1,
        selectable: false,
        text: `◆ phase: ${task.phaseId}`,
      });
    }
    const marker =
      task.status === "succeeded"
        ? "✓"
        : task.status === "failed"
          ? "✗"
          : task.status === "running"
            ? "→"
            : task.status === "interrupted"
              ? "‼"
              : "○";
    const error = task.error ? ` — ${task.error}` : "";
    rows.push({
      projection,
      depth: 2,
      selectable: false,
      text: `${marker} ${task.status} ${task.label ?? task.id} (attempt ${task.attempt})${error}`,
    });
  }
  if (projection.usageLowerBound) {
    rows.push({
      projection,
      depth: 1,
      selectable: false,
      text: "Usage is a committed lower bound after interruption.",
    });
  }
  if (projection.terminal?.error) {
    rows.push({
      projection,
      depth: 1,
      selectable: false,
      text: `error: ${projection.terminal.error.message}`,
    });
  }
  if (rows.length === 0) {
    rows.push({
      projection,
      depth: 1,
      selectable: false,
      text: "No durable task events yet.",
    });
  }
  return rows;
}

function formatWorkflowDetails(job: WorkflowJobState): WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  const usage = presentWorkflowUsage(job.snapshot.usage);
  if (usage) {
    for (const field of formatWorkflowUsageFields(usage, {
      outputBudget: job.snapshot.budgetTotal,
    })) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: field,
      });
    }
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: formatWorkflowUsageLegend(),
    });
  }

  const planState = (job.snapshot as WorkflowSnapshotWithPlanState).planState;
  if (planState) {
    for (const row of formatWorkflowPlanRows(planState)) {
      rows.push({
        job,
        depth: row.depth,
        selectable: false,
        text: row.text,
      });
    }
  } else {
    for (const phase of job.snapshot.phases) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: `◆ phase: ${phase}`,
      });
    }
    const records = job.snapshot.agentRecords ?? [];
    const agentRows = records.slice(-MAX_WORKFLOW_TREE_AGENT_ROWS);
    const omittedForUi =
      (job.snapshot.agentRecordsOmitted ?? 0) +
      Math.max(0, records.length - agentRows.length);
    if (omittedForUi > 0) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: `… ${omittedForUi} older agent records omitted`,
      });
    }
    for (const record of agentRows) {
      const marker =
        record.status === "running"
          ? "→"
          : record.status === "error"
            ? "✗"
            : record.status === "cancelled"
              ? "⊘"
              : "✓";
      const label = `${record.label ?? "agent"} #${record.agentId}`;
      const model = record.model ? ` @${record.model}` : "";
      const phase = record.phase ? ` (${record.phase})` : "";
      const recordUsage = presentWorkflowUsage(record.usage);
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: `${marker} ${record.status} ${label}${model}${phase}${
          recordUsage
            ? ` — ${formatWorkflowUsage(recordUsage, { ascii: true })}`
            : ""
        }`,
      });
    }
  }
  if (job.snapshot.lastMessage) {
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: job.snapshot.lastMessage,
    });
  }
  if (job.error) {
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: `error: ${job.error}`,
    });
  }
  if (rows.length === 0) {
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: "No phase or agent events yet.",
    });
  }
  return rows;
}

function trunc(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}
