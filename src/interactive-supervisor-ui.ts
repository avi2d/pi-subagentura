import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
  cancelInteractiveSubagent,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";

export const INTERACTIVE_SUPERVISOR_SHORTCUT = "ctrl+alt+a";
const DEFAULT_REFRESH_INTERVAL_MS = 1_000;

export type InteractiveSupervisorAction = { kind: "close" };
type SupervisorDone = (action: InteractiveSupervisorAction) => void;
let activeDone: SupervisorDone | undefined;

interface InteractiveSupervisorOptions {
  done: SupervisorDone;
  requestRender?: () => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  cancel?: typeof cancelInteractiveSubagent;
  focus?: (state: InteractiveSubagentState) => void | Promise<void>;
  view?: (state: InteractiveSubagentState) => void | Promise<void>;
  cancelSubtree?: (state: InteractiveSubagentState) => void | Promise<void>;
  refreshIntervalMs?: number;
  now?: () => number;
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
      this.timer = setInterval(() => this.changed(), refreshIntervalMs);
      this.timer.unref?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const states = supervisorStates();
    this.selectedIndex = clampIndex(this.selectedIndex, states.length);
    const lines = [
      trunc("┌ Interactive Subagents", width),
      trunc(
        "│ ↑↓/jk select • enter/→ details • v view • f focus • a attach • x cancel • X subtree • r refresh • q/esc close",
        width,
      ),
    ];

    if (states.length === 0) {
      lines.push(trunc("│ No interactive subagents.", width));
    } else {
      states.forEach((state, index) => {
        const selected = index === this.selectedIndex;
        const expanded = this.expanded.has(state.id);
        const marker = selected ? "▶" : "○";
        lines.push(
          trunc(
            `│ ${marker} ${expanded ? "▾" : "▸"} ${formatSupervisorSummary(
              state,
              this.now(),
            )}`,
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

    const states = supervisorStates();
    this.selectedIndex = clampIndex(this.selectedIndex, states.length);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.changed();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selectedIndex = Math.min(
        Math.max(0, states.length - 1),
        this.selectedIndex + 1,
      );
      this.changed();
      return;
    }
    if (matchesKey(data, "r")) {
      this.changed();
      return;
    }

    const selected = states[this.selectedIndex];
    if (!selected) return;
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
    if (matchesKey(data, "f")) {
      void this.runAction("focus", selected, this.opts.focus);
      return;
    }
    if (matchesKey(data, Key.shift("x"))) {
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

function formatDetails(
  state: InteractiveSubagentState,
  width: number,
): string[] {
  const fields = [
    `Task: ${state.task}`,
    `Model: ${state.model ?? "default"}`,
    `Pane: ${state.mux}:${state.paneId}${state.muxSession ? ` session=${state.muxSession}` : ""}`,
    `cwd: ${state.cwd}`,
    `Artifact: ${state.artifactDir}`,
    `Pi session: ${state.sessionFile}`,
    `Attach: ${state.attachCommand}`,
  ];
  return fields.map((field) => trunc(`│     ${field}`, width));
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
