import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  getWorkflowCompletionPresentation,
  workflowJobRegistry,
  type WorkflowJobState,
} from "./workflow-jobs";
import { formatWorkflowUsage } from "./workflow-core";

export type WorkflowTreeAction =
  { kind: "cancel"; workflowId: string } | { kind: "close" };

type WorkflowTreeDone = (action: WorkflowTreeAction) => void;

interface WorkflowTreeOptions {
  done: WorkflowTreeDone;
  requestRender?: () => void;
  notify?: (message: string) => void;
}

interface WorkflowRow {
  job: WorkflowJobState;
  depth: number;
  text: string;
  selectable: boolean;
}

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
    const jobs = selectableJobs();
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
    for (const job of workflowJobRegistry.values()) {
      const isExpanded = this.expanded.has(job.id);
      rows.push({
        job,
        depth: 0,
        selectable: true,
        text: `${isExpanded ? "▾" : "▸"} ${formatWorkflowSummary(job)}`,
      });
      if (isExpanded) {
        rows.push(...formatWorkflowDetails(job));
      }
    }
    return rows;
  }

  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.changed();
  }

  private cancel(job: WorkflowJobState): void {
    if (job.status !== "running") {
      this.opts.notify?.(
        `Workflow ${job.id} is ${job.status}; nothing to cancel.`,
      );
      return;
    }
    job.abort.abort();
    job.status = "cancelled";
    this.opts.notify?.(`Cancelled workflow ${job.id}.`);
    this.changed();
    this.opts.done({ kind: "cancel", workflowId: job.id });
  }

  private changed(): void {
    this.invalidate();
    this.opts.requestRender?.();
  }
}

export async function showWorkflowTree(
  ui: ExtensionUIContext,
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

function selectableJobs(): WorkflowJobState[] {
  return [...workflowJobRegistry.values()];
}

function formatWorkflowSummary(job: WorkflowJobState): string {
  const s = job.snapshot;
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
  parts.push(`${s.tokensSpent} output tokens`);
  if (s.usage) parts.push(formatWorkflowUsage(s.usage));
  if (s.currentPhase) parts.push(`phase: ${s.currentPhase}`);
  return parts.join(" · ");
}

function formatWorkflowDetails(job: WorkflowJobState): WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  for (const phase of job.snapshot.phases) {
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: `◆ phase: ${phase}`,
    });
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
