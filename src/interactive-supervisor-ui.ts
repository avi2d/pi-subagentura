import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JobState } from "./helpers";
import {
  cancelInteractiveSubagent,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import type { WorkflowJobState } from "./workflow-jobs";

export const INTERACTIVE_SUPERVISOR_SHORTCUT = "ctrl+alt+a";
const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const DETAIL_OUTPUT_MAX_BYTES = 4 * 1024;
const DETAIL_EVENTS_MAX_BYTES = 8 * 1024;
const DETAIL_PREVIEW_MAX_CHARS = 512;
const DETAIL_EVENT_COUNT = 3;
const DETAIL_WORKFLOW_AGENT_COUNT = 20;

export type InteractiveSupervisorAction = { kind: "close" };
type SupervisorDone = (action: InteractiveSupervisorAction) => void;
let activeDone: SupervisorDone | undefined;

interface SupervisorItemBase {
  depth: number;
  actionable: boolean;
  reasons?: string[];
}

export interface InteractiveSupervisorItem extends SupervisorItemBase {
  kind?: "interactive";
  state: InteractiveSubagentState;
}

export interface InProcessSupervisorItem extends SupervisorItemBase {
  kind: "in-process";
  job: JobState;
}

export interface WorkflowSupervisorItem extends SupervisorItemBase {
  kind: "workflow";
  job: WorkflowJobState;
}

export type AsyncSupervisorItem =
  InteractiveSupervisorItem | InProcessSupervisorItem | WorkflowSupervisorItem;

export interface InteractiveSupervisorOptions {
  done: SupervisorDone;
  requestRender?: () => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  cancel?: typeof cancelInteractiveSubagent;
  cancelInProcess?: (job: JobState) => boolean;
  cancelWorkflow?: (job: WorkflowJobState) => boolean;
  focus?: (state: InteractiveSubagentState) => void | Promise<void>;
  view?: (state: InteractiveSubagentState) => void | Promise<void>;
  nativeView?: (state: InteractiveSubagentState) => void | Promise<void>;
  cancelSubtree?: (state: InteractiveSubagentState) => void | Promise<void>;
  refreshIntervalMs?: number;
  now?: () => number;
  items?: () => AsyncSupervisorItem[];
  refresh?: () => void | Promise<void>;
}

export class InteractiveSupervisorComponent {
  private selectedIndex = 0;
  private selectedKey?: string;
  private expanded = new Set<string>();
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private refreshing = false;

  constructor(private readonly opts: InteractiveSupervisorOptions) {
    const refreshIntervalMs =
      opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (refreshIntervalMs > 0 && opts.requestRender) {
      this.timer = setInterval(() => void this.refresh(), refreshIntervalMs);
      this.timer.unref?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const items = this.items();
    const lines = [
      trunc("┌ Async Subagents", width),
      trunc(
        "│ ↑↓/jk select • enter/→ details • x cancel • interactive: v/n/f/a/X • r refresh • q/esc close",
        width,
      ),
    ];

    if (items.length === 0) {
      lines.push(trunc("│ No async subagents.", width));
    } else {
      items.forEach((item, index) => {
        const selected = index === this.selectedIndex;
        const itemKey = supervisorItemKey(item);
        const expanded = this.expanded.has(itemKey);
        const marker = selected ? "▶" : "○";
        const unavailable = item.actionable
          ? ""
          : ` · unavailable (${item.reasons?.join(", ") ?? "unsafe"})`;
        lines.push(
          trunc(
            `│ ${"  ".repeat(item.depth)}${marker} ${expanded ? "▾" : "▸"} ${formatAsyncSupervisorSummary(
              item,
              this.now(),
            )}${unavailable}`,
            width,
          ),
        );
        if (expanded) lines.push(...formatAsyncDetails(item, width));
      });
    }

    lines.push(trunc(`└${"─".repeat(Math.max(0, width - 2))}┘`, width));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, "q") ||
      matchesKey(data, Key.ctrlAlt("a"))
    ) {
      this.opts.done({ kind: "close" });
      return;
    }

    const items = this.items();
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selectIndex(items, this.selectedIndex - 1);
      this.changed();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selectIndex(items, this.selectedIndex + 1);
      this.changed();
      return;
    }
    if (matchesKey(data, "r")) {
      void this.refresh();
      return;
    }

    const selectedItem = items[this.selectedIndex];
    if (!selectedItem) return;
    const itemKey = supervisorItemKey(selectedItem);
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      this.toggle(itemKey);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.expanded.delete(itemKey);
      this.changed();
      return;
    }
    if (matchesKey(data, "x")) {
      this.cancelItem(selectedItem);
      return;
    }
    if (matchesKey(data, "a")) {
      const state = this.interactiveStateForAction(selectedItem, "attach");
      if (state) this.opts.notify?.(state.attachCommand, "info");
      return;
    }
    if (matchesKey(data, "v")) {
      const state = this.interactiveStateForAction(selectedItem, "view");
      if (state) void this.runAction("view", state, this.opts.view);
      return;
    }
    if (matchesKey(data, "n")) {
      const state = this.interactiveStateForAction(selectedItem, "native view");
      if (state)
        void this.runAction("open native view", state, this.opts.nativeView);
      return;
    }
    if (matchesKey(data, "f")) {
      const state = this.interactiveStateForAction(selectedItem, "focus");
      if (!state) return;
      if (!selectedItem.actionable) {
        this.opts.notify?.(
          "This lineage node is not safe to focus.",
          "warning",
        );
        return;
      }
      void this.runAction("focus", state, this.opts.focus);
      return;
    }
    if (matchesKey(data, Key.shift("x"))) {
      this.cancelInteractiveSubtree(selectedItem);
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private items(): AsyncSupervisorItem[] {
    const items = this.opts.items?.() ?? supervisorItems();
    const stableIndex = this.selectedKey
      ? items.findIndex((item) => supervisorItemKey(item) === this.selectedKey)
      : -1;
    this.selectedIndex =
      stableIndex >= 0
        ? stableIndex
        : clampIndex(this.selectedIndex, items.length);
    this.selectedKey = items[this.selectedIndex]
      ? supervisorItemKey(items[this.selectedIndex])
      : undefined;
    return items;
  }

  private selectIndex(items: AsyncSupervisorItem[], index: number): void {
    this.selectedIndex = clampIndex(index, items.length);
    this.selectedKey = items[this.selectedIndex]
      ? supervisorItemKey(items[this.selectedIndex])
      : undefined;
  }

  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.changed();
  }

  private cancelItem(item: AsyncSupervisorItem): void {
    let cancelled = false;
    let label = "subagent";
    if (!item.actionable) {
      this.opts.notify?.("This async item is not safe to cancel.", "warning");
      return;
    }
    if (item.kind === "in-process") {
      cancelled = this.opts.cancelInProcess?.(item.job) ?? false;
      label = item.job.id;
    } else if (item.kind === "workflow") {
      cancelled = this.opts.cancelWorkflow?.(item.job) ?? false;
      label = item.job.name;
    } else {
      cancelled = Boolean(
        (this.opts.cancel ?? cancelInteractiveSubagent)(item.state.id),
      );
      label = item.state.name;
    }
    this.opts.notify?.(
      cancelled ? `Cancelled ${label}.` : `${label} is no longer running.`,
      cancelled ? "warning" : "error",
    );
    this.changed();
  }

  private cancelInteractiveSubtree(item: AsyncSupervisorItem): void {
    const state = interactiveState(item);
    if (!state) {
      this.opts.notify?.(
        "Subtree cancellation is only available for interactive agents.",
        "info",
      );
      return;
    }
    if (!item.actionable) {
      this.opts.notify?.(
        "This lineage subtree is not safe to cancel.",
        "warning",
      );
      return;
    }
    void this.runAction("cancel subtree", state, this.opts.cancelSubtree);
  }

  private interactiveStateForAction(
    item: AsyncSupervisorItem,
    action: string,
  ): InteractiveSubagentState | undefined {
    const state = interactiveState(item);
    if (!state) {
      this.opts.notify?.(
        `${action} is only available for interactive agents.`,
        "info",
      );
    }
    return state;
  }

  private changed(): void {
    if (this.disposed) return;
    this.invalidate();
    this.opts.requestRender?.();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // Avoid `await undefined` — that yields a microtask and breaks the
      // no-refresh path, which previously called changed() synchronously.
      if (this.opts.refresh) await this.opts.refresh();
    } finally {
      this.refreshing = false;
      this.changed();
    }
  }

  private async runAction(
    label: string,
    state: InteractiveSubagentState,
    action?: (state: InteractiveSubagentState) => void | Promise<void>,
  ): Promise<void> {
    if (!action) {
      this.opts.notify?.(`${label} is not available in this session.`, "info");
      return;
    }
    try {
      await action(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.opts.notify?.(`Unable to ${label}: ${message}`, "error");
    } finally {
      this.changed();
    }
  }
}

export async function showInteractiveSupervisor(
  ui: ExtensionUIContext,
  options: Omit<
    InteractiveSupervisorOptions,
    "done" | "requestRender" | "notify"
  > = {},
): Promise<InteractiveSupervisorAction> {
  const custom = (ui as ExtensionUIContext & { custom?: Function }).custom;
  if (typeof custom !== "function") {
    ui.notify(
      "The async subagent supervisor is only available in Pi TUI sessions. Use the status and cancellation tools in this mode.",
      "info",
    );
    return { kind: "close" };
  }

  let component: InteractiveSupervisorComponent | undefined;
  try {
    return await custom.call(
      ui,
      (
        tui: { requestRender?: () => void },
        _theme: unknown,
        _kb: unknown,
        done: SupervisorDone,
      ) => {
        activeDone = done;
        component = new InteractiveSupervisorComponent({
          ...options,
          done,
          requestRender: () => tui.requestRender?.(),
          notify: (message, level) => ui.notify(message, level),
        });
        return component;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          minWidth: 60,
          maxHeight: "85%",
        },
      },
    );
  } finally {
    activeDone = undefined;
    component?.dispose();
  }
}

export function closeActiveInteractiveSupervisor(): void {
  activeDone?.({ kind: "close" });
}

export function formatSupervisorSummary(
  state: InteractiveSubagentState,
  now: number,
): string {
  const icon = statusIcon(state.status);
  const elapsed = formatElapsed(Math.max(0, now - state.startedAt));
  const activity =
    state.lastToolSummary ?? state.lastToolName ?? "no activity yet";
  return `${icon} ${state.status} ${state.name} (${state.id.slice(0, 8)}) · ${state.mux} · ${elapsed} · ${activity}`;
}

function supervisorStates(): InteractiveSubagentState[] {
  return [...interactiveSubagentRegistry.values()].sort(
    (left, right) =>
      left.startedAt - right.startedAt || left.id.localeCompare(right.id),
  );
}

function supervisorItems(): AsyncSupervisorItem[] {
  return supervisorStates().map((state) => ({
    kind: "interactive",
    state,
    depth: 0,
    actionable: true,
  }));
}

function supervisorItemKey(item: AsyncSupervisorItem): string {
  if (item.kind === "in-process") return `in-process:${item.job.id}`;
  if (item.kind === "workflow") return `workflow:${item.job.id}`;
  return `interactive:${item.state.id}`;
}

function interactiveState(
  item: AsyncSupervisorItem,
): InteractiveSubagentState | undefined {
  if (item.kind === "in-process" || item.kind === "workflow") return undefined;
  return item.state;
}

function formatAsyncSupervisorSummary(
  item: AsyncSupervisorItem,
  now: number,
): string {
  if (item.kind === "in-process") {
    const job = item.job;
    const elapsed = formatElapsed(Math.max(0, now - job.startedAt));
    const activity = job.liveStatus.activeTool
      ? `tool: ${job.liveStatus.activeTool.name}`
      : `turn ${job.liveStatus.turn}`;
    return `[in-process] ${statusIcon(job.status)} ${job.status} ${job.id} · ${elapsed} · ${activity}`;
  }
  if (item.kind === "workflow") {
    const job = item.job;
    const elapsed = formatElapsed(Math.max(0, now - job.startedAt));
    const phase = job.snapshot.currentPhase
      ? ` · phase: ${job.snapshot.currentPhase}`
      : "";
    return `[workflow] ${statusIcon(job.status)} ${job.status} ${job.name} (${job.id}) · ${elapsed} · ${job.snapshot.agentsSpawned} agents · ${job.snapshot.runningCount ?? 0} running${phase}`;
  }
  return `[interactive] ${formatSupervisorSummary(item.state, now)}`;
}

function formatAsyncDetails(
  item: AsyncSupervisorItem,
  width: number,
): string[] {
  if (item.kind === "in-process") {
    return formatInProcessDetails(item.job, width);
  }
  if (item.kind === "workflow") {
    return formatWorkflowDetails(item.job, width);
  }
  return formatInteractiveDetails(item.state, width);
}

function formatInProcessDetails(job: JobState, width: number): string[] {
  const activeTool = job.liveStatus.activeTool?.name ?? "none";
  const fields = [
    `Job: ${job.id}`,
    `Model: ${job.modelLabel ?? "default"}`,
    `cwd: ${job.cwd ?? "unknown"}`,
    `Turn: ${job.liveStatus.turn}`,
    `Active tool: ${activeTool}`,
    `Usage: ${job.liveStatus.usage.input} input · ${job.liveStatus.usage.output} output`,
    `Output preview: ${compactText(job.liveStatus.output) || "none yet"}`,
  ];
  return fields.map((field) => trunc(`│     ${field}`, width));
}

function formatWorkflowDetails(job: WorkflowJobState, width: number): string[] {
  const snapshot = job.snapshot;
  const allRecords = snapshot.agentRecords ?? [];
  const records = allRecords.slice(-DETAIL_WORKFLOW_AGENT_COUNT);
  const omitted =
    (snapshot.agentRecordsOmitted ?? 0) +
    Math.max(0, allRecords.length - records.length);
  const fields = [
    `Workflow: ${job.name} (${job.id})`,
    `Phase: ${snapshot.currentPhase ?? "none"}`,
    `Agents: ${snapshot.agentsSpawned} total · ${snapshot.runningCount ?? 0} running`,
    `Errors: ${snapshot.errorCount}`,
    `Output tokens: ${snapshot.tokensSpent}`,
    `Last activity: ${snapshot.lastMessage ?? "none yet"}`,
  ];
  if (omitted > 0) fields.push(`… ${omitted} older agent records omitted`);
  for (const record of records) {
    const label = record.label ?? "agent";
    const model = record.model ? ` @${record.model}` : "";
    const phase = record.phase ? ` (${record.phase})` : "";
    fields.push(
      `Agent: ${statusIcon(record.status)} ${record.status} ${label} #${record.agentId}${model}${phase}`,
    );
  }
  return fields.map((field) => trunc(`│     ${field}`, width));
}

function formatInteractiveDetails(
  state: InteractiveSubagentState,
  width: number,
): string[] {
  const artifactDetails = readArtifactDetails(state);
  const fields = [
    `Task: ${state.task}`,
    `Model: ${state.model ?? "default"}`,
    `Pane: ${state.mux}:${state.paneId}${state.muxSession ? ` session=${state.muxSession}` : ""}`,
    `cwd: ${state.cwd}`,
    `Artifact: ${state.artifactDir}`,
    `Pi session: ${state.sessionFile}`,
    `Lifecycle: ${artifactDetails.lifecycle}`,
    `Recent events: ${artifactDetails.events}`,
    `Output preview: ${artifactDetails.output}`,
  ];
  if (!(state.mux === "tmux" && process.env.TMUX)) {
    fields.push(`Attach: ${state.attachCommand}`);
  }
  fields.push(`Focus: ${state.selectPaneCommand}`);
  return fields.map((field) => trunc(`│     ${field}`, width));
}

function readArtifactDetails(state: InteractiveSubagentState): {
  lifecycle: string;
  events: string;
  output: string;
} {
  const lifecycle = state.lifecycle
    ? compactText(
        [
          state.lifecycle.currentTurnId &&
            `turn=${state.lifecycle.currentTurnId}`,
          state.lifecycle.completionOutcome &&
            `completion=${state.lifecycle.completionOutcome}`,
          state.lifecycle.processStatus &&
            `process=${state.lifecycle.processStatus}`,
          state.lifecycle.parentCancelled && "parent-cancelled",
        ]
          .filter(Boolean)
          .join(" · "),
      ) || "active"
    : "not folded yet";
  const events = summarizeRecentEvents(
    readBoundedFileTail(
      join(state.artifactDir, "events.ndjson"),
      DETAIL_EVENTS_MAX_BYTES,
    ),
  );
  const output = compactText(
    readBoundedFileTail(
      join(state.artifactDir, "output.md"),
      DETAIL_OUTPUT_MAX_BYTES,
    ),
  );
  return {
    lifecycle,
    events: events || "none yet",
    output: output || "none yet",
  };
}

function readBoundedFileTail(filePath: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    if (!lstatSync(filePath).isFile()) return "";
    const size = statSync(filePath).size;
    const bytes = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    fd = openSync(filePath, "r");
    if (bytes > 0) readSync(fd, buffer, 0, bytes, size - bytes);
    // Drop leading UTF-8 continuation bytes so a mid-sequence cut does
    // not decode as U+FFFD.
    let start = 0;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) {
      start++;
    }
    return buffer.subarray(start).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function summarizeRecentEvents(content: string): string {
  const summaries: string[] = [];
  for (const line of content.trim().split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.type !== "string") continue;
      const detail =
        typeof event.outcome === "string"
          ? event.outcome
          : typeof event.name === "string"
            ? event.name
            : undefined;
      summaries.push(detail ? `${event.type}(${detail})` : event.type);
    } catch {
      /* A bounded tail may begin in the middle of an event record. */
    }
  }
  return summaries.slice(-DETAIL_EVENT_COUNT).join(" → ");
}

function compactText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DETAIL_PREVIEW_MAX_CHARS);
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "→";
    case "idle":
      return "●";
    case "cancelled":
      return "⊘";
    case "done":
    case "exited":
      return "✓";
    case "error":
      return "✗";
    case "unknown":
    default:
      return "?";
  }
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(0, index), Math.max(0, length - 1));
}

function trunc(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return `${text.slice(0, width - 1)}…`;
}
