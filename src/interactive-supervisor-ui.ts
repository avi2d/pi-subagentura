import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  cancelInteractiveSubagent,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";

export const INTERACTIVE_SUPERVISOR_SHORTCUT = "ctrl+alt+a";
const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const DETAIL_OUTPUT_MAX_BYTES = 4 * 1024;
const DETAIL_EVENTS_MAX_BYTES = 8 * 1024;
const DETAIL_PREVIEW_MAX_CHARS = 512;
const DETAIL_EVENT_COUNT = 3;

export type InteractiveSupervisorAction = { kind: "close" };
type SupervisorDone = (action: InteractiveSupervisorAction) => void;
let activeDone: SupervisorDone | undefined;

export interface InteractiveSupervisorItem {
  state: InteractiveSubagentState;
  depth: number;
  actionable: boolean;
  reasons?: string[];
}

export interface InteractiveSupervisorOptions {
  done: SupervisorDone;
  requestRender?: () => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  cancel?: typeof cancelInteractiveSubagent;
  focus?: (state: InteractiveSubagentState) => void | Promise<void>;
  view?: (state: InteractiveSubagentState) => void | Promise<void>;
  nativeView?: (state: InteractiveSubagentState) => void | Promise<void>;
  cancelSubtree?: (state: InteractiveSubagentState) => void | Promise<void>;
  refreshIntervalMs?: number;
  now?: () => number;
  items?: () => InteractiveSupervisorItem[];
  refresh?: () => void | Promise<void>;
}

export class InteractiveSupervisorComponent {
  private selectedIndex = 0;
  private expanded = new Set<string>();
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly timer?: ReturnType<typeof setInterval>;
  private disposed = false;

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
    this.selectedIndex = clampIndex(this.selectedIndex, items.length);
    const lines = [
      trunc("┌ Interactive Subagents", width),
      trunc(
        "│ ↑↓/jk select • enter/→ details • v view • n native • f focus • a attach • x cancel • X subtree • r refresh • q/esc close",
        width,
      ),
    ];

    if (items.length === 0) {
      lines.push(trunc("│ No interactive subagents.", width));
    } else {
      items.forEach((item, index) => {
        const { state } = item;
        const selected = index === this.selectedIndex;
        const expanded = this.expanded.has(state.id);
        const marker = selected ? "▶" : "○";
        lines.push(
          trunc(
            `│ ${"  ".repeat(item.depth)}${marker} ${expanded ? "▾" : "▸"} ${formatSupervisorSummary(
              state,
              this.now(),
            )}${item.actionable ? "" : ` · unavailable (${item.reasons?.join(", ") ?? "unsafe"})`}`,
            width,
          ),
        );
        if (expanded) lines.push(...formatDetails(state, width));
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
    this.selectedIndex = clampIndex(this.selectedIndex, items.length);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.changed();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selectedIndex = Math.min(
        Math.max(0, items.length - 1),
        this.selectedIndex + 1,
      );
      this.changed();
      return;
    }
    if (matchesKey(data, "r")) {
      void this.refresh();
      return;
    }

    const selectedItem = items[this.selectedIndex];
    if (!selectedItem) return;
    const selected = selectedItem.state;
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      this.toggle(selected.id);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.expanded.delete(selected.id);
      this.changed();
      return;
    }
    if (matchesKey(data, "a")) {
      this.opts.notify?.(selected.attachCommand, "info");
      return;
    }
    if (matchesKey(data, "x")) {
      if (!selectedItem.actionable) {
        this.opts.notify?.(
          "This lineage node is not safe to act on.",
          "warning",
        );
        return;
      }
      const cancelled = (this.opts.cancel ?? cancelInteractiveSubagent)(
        selected.id,
      );
      if (cancelled)
        this.opts.notify?.(`Cancelled ${selected.name}.`, "warning");
      else
        this.opts.notify?.(
          `Subagent ${selected.id} no longer exists.`,
          "error",
        );
      this.changed();
      return;
    }
    if (matchesKey(data, "v")) {
      void this.runAction("view", selected, this.opts.view);
      return;
    }
    if (matchesKey(data, "n")) {
      void this.runAction("open native view", selected, this.opts.nativeView);
      return;
    }
    if (matchesKey(data, "f")) {
      if (!selectedItem.actionable) {
        this.opts.notify?.(
          "This lineage node is not safe to focus.",
          "warning",
        );
        return;
      }
      void this.runAction("focus", selected, this.opts.focus);
      return;
    }
    if (matchesKey(data, Key.shift("x"))) {
      if (!selectedItem.actionable) {
        this.opts.notify?.(
          "This lineage subtree is not safe to cancel.",
          "warning",
        );
        return;
      }
      void this.runAction("cancel subtree", selected, this.opts.cancelSubtree);
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

  private items(): InteractiveSupervisorItem[] {
    return this.opts.items?.() ?? supervisorItems();
  }

  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.changed();
  }

  private changed(): void {
    if (this.disposed) return;
    this.invalidate();
    this.opts.requestRender?.();
  }

  private async refresh(): Promise<void> {
    if (!this.opts.refresh) {
      this.changed();
      return;
    }
    try {
      await this.opts.refresh();
    } finally {
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
      "The interactive subagent supervisor is only available in Pi TUI sessions. Use the interactive status tools in this mode.",
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

function supervisorItems(): InteractiveSupervisorItem[] {
  return supervisorStates().map((state) => ({
    state,
    depth: 0,
    actionable: true,
  }));
}

function formatDetails(
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
    `Attach: ${state.attachCommand}`,
  ];
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
    return buffer.toString("utf8");
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

function statusIcon(status: InteractiveSubagentState["status"]): string {
  switch (status) {
    case "running":
      return "→";
    case "idle":
      return "●";
    case "cancelled":
      return "⊘";
    case "exited":
      return "✓";
    case "unknown":
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
