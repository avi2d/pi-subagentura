/**
 * Session Picker - Shows a native picker UI for selecting sessions or running jobs
 */

import { Text, SelectList, Container } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { jobRegistry } from "./helpers";
import { truncateToWidth } from "@mariozechner/pi-tui";

export const SessionPickerParams = Type.Object({
  sessionDirs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Directories to scan for session files. Defaults to common pi session locations.",
    }),
  ),
});

interface SessionInfo {
  path: string;
  timestamp: string;
  taskPreview: string;
}

interface RunningJobInfo {
  id: string;
  status: string;
  modelLabel?: string;
}

async function scanSessions(dirs: string[]): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const fullPath = resolve(dir, file);
        try {
          const content = readFileSync(fullPath, "utf-8");
          const firstLine = content.split("\n")[0];
          const meta = JSON.parse(firstLine);
          const timestamp = meta.timestamp
            ? new Date(meta.timestamp).toLocaleString()
            : file.replace(/\.jsonl$/, "").slice(0, 16);

          let taskPreview = "Unknown task";
          try {
            const lines = content.split("\n");
            for (const line of lines) {
              if (line.includes('"role":"user"')) {
                const msgMatch = line.match(/"text":"([^"]+)"/);
                if (msgMatch) {
                  taskPreview = msgMatch[1].slice(0, 60);
                  break;
                }
              }
            }
          } catch { /* ignore */ }

          sessions.push({ path: fullPath, timestamp, taskPreview });
        } catch { /* skip invalid files */ }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

function getRunningJobs(): RunningJobInfo[] {
  return [...jobRegistry.values()]
    .filter((j) => j.status === "running")
    .map((j) => ({
      id: j.id,
      status: j.status,
      modelLabel: j.modelLabel,
    }));
}

export interface PickerResult {
  type: "session" | "job" | "cancelled";
  path?: string;
  jobId?: string;
  status?: string;
  modelLabel?: string;
}

export async function showSessionPicker(
  ctx: any,
  sessionDirs?: string[],
): Promise<PickerResult | null> {
  // Default directories
  const dirsToScan = sessionDirs ?? [
    process.env.PI_CODING_AGENT_SESSION_DIR ?? "",
    `${process.env.HOME}/.pi/agent/sessions`,
  ].filter(Boolean);

  // Scan for sessions and get running jobs
  const sessions = await scanSessions(dirsToScan);
  const runningJobs = getRunningJobs();

  // Build items
  const sessionItems = sessions.map((s) => ({
    value: `session:${s.path}`,
    label: `${s.timestamp} — ${s.taskPreview}`,
    description: s.path,
  }));

  const jobItems = runningJobs.map((j) => ({
    value: `job:${j.id}`,
    label: `${j.status} — job ${j.id.slice(0, 8)}`,
    description: j.modelLabel ? `Model: ${j.modelLabel}` : "Running",
  }));

  if (sessionItems.length === 0 && jobItems.length === 0) {
    return null;
  }

  // Check if ctx.ui.custom is available (non-interactive mode may not have it)
  if (!ctx.ui?.custom) {
    // Fallback: return session info as text when UI picker isn't available
    const lines: string[] = [];
    if (sessionItems.length > 0) {
      lines.push(`Found ${sessionItems.length} session(s):`);
      for (const s of sessions) {
        lines.push(`  - ${s.timestamp}: ${s.taskPreview}`);
        lines.push(`    Path: ${s.path}`);
      }
    }
    if (jobItems.length > 0) {
      lines.push(`\nRunning jobs (${jobItems.length}):`);
      for (const j of runningJobs) {
        lines.push(`  - ${j.status}: ${j.id}`);
        if (j.modelLabel) lines.push(`    Model: ${j.modelLabel}`);
      }
    }
    // Return a special result that indicates text output
    return { type: "cancelled" as const, path: lines.join("\n") };
  }


  // Track state
  let activeSection: "sessions" | "jobs" = "sessions";
  const hasSessions = sessionItems.length > 0;
  const hasJobs = jobItems.length > 0;

  // Show picker
  const result: string | null = await (ctx.ui.custom as any)(async (tui: any, theme: Theme, _kb: any, done: (val: string | null) => void) => {
    const container = new Container();
    const { matchesKey, Key } = await import("@mariozechner/pi-tui");

    function getCurrentItems() {
      return activeSection === "sessions" ? sessionItems : jobItems;
    }

    let selectList = new SelectList(getCurrentItems(), Math.min(getCurrentItems().length, 10), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });
    selectList.onSelect = (item: any) => done(item.value);
    selectList.onCancel = () => done(null);

    function rebuildList() {
      container.children = container.children.filter((c: any) => c !== selectList);
      selectList = new SelectList(getCurrentItems(), Math.min(getCurrentItems().length, 10), {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      selectList.onSelect = (item: any) => done(item.value);
      selectList.onCancel = () => done(null);
      container.children = container.children.slice(0, 2); // keep title/subtitle
      container.addChild(selectList);
    }

    function buildTitle() {
      const title = theme.fg("accent", theme.bold("Select Session or Job"));
      let subtitle: string;
      if (activeSection === "sessions") {
        subtitle = theme.fg("dim", `${sessions.length} saved session${sessions.length === 1 ? "" : "s"}`);
        if (hasJobs) subtitle += ` • ${theme.fg("warning", `↓ running`)}`;
      } else {
        subtitle = theme.fg("warning", `${runningJobs.length} running job${runningJobs.length === 1 ? "" : "s"}`);
        if (hasSessions) subtitle += ` • ${theme.fg("dim", `↑ saved`)}`;
      }
      return { title, subtitle };
    }

    const { title, subtitle } = buildTitle();
    container.addChild(new Text(title, 1, 0));
    container.addChild(new Text(subtitle, 1, 0));
    container.addChild(selectList);

    let helpText = "↑↓ navigate";
    if (hasSessions && hasJobs) {
      helpText += " • tab: switch section";
    }
    helpText += " • enter select • esc cancel";
    container.addChild(new Text(theme.fg("dim", helpText), 1, 0));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Tab to switch sections
        if (data === "tab" && hasSessions && hasJobs) {
          activeSection = activeSection === "sessions" ? "jobs" : "sessions";
          rebuildList();
          tui.requestRender();
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  }, { overlay: true });

  // Parse result
  if (!result) return null;

  if (result.startsWith("session:")) {
    return { type: "session", path: result.slice(8) };
  } else if (result.startsWith("job:")) {
    const jobId = result.slice(4);
    const job = runningJobs.find((j) => j.id === jobId);
    return {
      type: "job",
      jobId,
      status: job?.status ?? "unknown",
      modelLabel: job?.modelLabel,
    };
  }

  return null;
}

export function renderSessionPickerResult(result: PickerResult | null, theme: Theme): Text {
  if (!result) {
    return new Text(theme.fg("dim", "No sessions or jobs found"), 0, 0);
  }
  if (result.type === "cancelled" || (!result.path && !result.jobId)) {
    return new Text(theme.fg("dim", "No selection"), 0, 0);
  }
  if (result.type === "session") {
    const truncated = truncateToWidth(result.path!, 50);
    return new Text(theme.fg("success", `✓ Session: ${truncated}`), 0, 0);
  }
  if (result.type === "job") {
    return new Text(theme.fg("warning", `⚡ Job: ${result.jobId!.slice(0, 8)}`), 0, 0);
  }
  return new Text(theme.fg("dim", "Unknown"), 0, 0);
}
