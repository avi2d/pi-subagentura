import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type InteractiveSubagentStatus = "running" | "cancelled" | "unknown";

export interface InteractiveSubagentState {
  id: string;
  name: string;
  task: string;
  paneId: string;
  sessionFile: string;
  cwd: string;
  model?: string;
  startedAt: number;
  status: InteractiveSubagentStatus;
  attachCommand: string;
  selectPaneCommand: string;
  launchScriptFile: string;
}

const g = typeof global !== "undefined" ? global : globalThis;

if (!g.__piSubagenturaInteractiveRegistry) {
  g.__piSubagenturaInteractiveRegistry = new Map<string, InteractiveSubagentState>();
}

export const interactiveSubagentRegistry = g.__piSubagenturaInteractiveRegistry as Map<
  string,
  InteractiveSubagentState
>;

function commandExists(command: string): boolean {
  try {
    execFileSync("/bin/sh", ["-lc", `command -v ${shellEscape(command)}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function isTmuxAvailable(): boolean {
  return Boolean(process.env.TMUX && commandExists("tmux"));
}

export function tmuxSetupHint(): string {
  return "Start pi inside tmux, for example: tmux new -A -s pi 'pi'";
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  );
}

function defaultSessionRoot(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR
    ? resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
    : join(homedir(), ".pi", "agent", "sessions");
}

function sessionDirFor(cwd: string): string {
  const cwdLabel = `${safeSegment(basename(cwd))}-${randomBytes(3).toString("hex")}`;
  return join(defaultSessionRoot(), "subagentura", cwdLabel);
}

export function createInteractiveSubagentPaths(params: {
  id: string;
  name: string;
  cwd: string;
}): { sessionFile: string; artifactDir: string; promptFile: string; systemPromptFile: string; launchScriptFile: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = safeSegment(params.name);
  const dir = sessionDirFor(params.cwd);
  const artifactDir = join(dir, "artifacts", params.id);
  return {
    sessionFile: join(dir, `${timestamp}-${params.id}.jsonl`),
    artifactDir,
    promptFile: join(artifactDir, `${label}-prompt.md`),
    systemPromptFile: join(artifactDir, `${label}-system.md`),
    launchScriptFile: join(artifactDir, `${label}-launch.sh`),
  };
}

export function buildInteractivePrompt(params: {
  task: string;
  contextText?: string | null;
}): string {
  if (!params.contextText) return params.task;
  return [
    "You are an interactive sub-agent running in your own Pi session.",
    "The parent session context is included below for reference.",
    "",
    "--- Parent session context ---",
    params.contextText,
    "--- End parent session context ---",
    "",
    "Task:",
    params.task,
  ].join("\n");
}

export function buildPiInteractiveCommand(params: {
  sessionFile: string;
  name: string;
  promptFile: string;
  systemPromptFile?: string;
  model?: string;
  cwd: string;
}): string {
  const parts = ["pi", "--session", shellEscape(params.sessionFile), "--name", shellEscape(params.name)];
  if (params.model) {
    parts.push("--model", shellEscape(params.model));
  }
  if (params.systemPromptFile) {
    parts.push("--append-system-prompt", shellEscape(params.systemPromptFile));
  }
  parts.push(shellEscape(`@${params.promptFile}`));
  return `cd ${shellEscape(params.cwd)} && ${parts.join(" ")}`;
}

function getPaneLocation(paneId: string): { session: string; window: string; pane: string } {
  const output = execFileSync(
    "tmux",
    ["display-message", "-p", "-t", paneId, "#{session_name}\t#{window_index}\t#{pane_index}"],
    { encoding: "utf8" },
  ).trim();
  const [session, window, pane] = output.split("\t");
  return { session, window, pane };
}

export function buildTmuxAttachCommands(paneId: string): {
  attachCommand: string;
  selectPaneCommand: string;
} {
  const location = getPaneLocation(paneId);
  const targetWindow = `${location.session}:${location.window}`;
  return {
    attachCommand: `tmux attach -t ${shellEscape(location.session)} \\; select-window -t ${shellEscape(targetWindow)} \\; select-pane -t ${shellEscape(paneId)}`,
    selectPaneCommand: `tmux select-pane -t ${shellEscape(paneId)}`,
  };
}

export function createTmuxPane(name: string, cwd: string): string {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is not available. ${tmuxSetupHint()}`);
  }
  const args = ["split-window", "-d", "-h", "-P", "-F", "#{pane_id}", "-c", cwd];
  if (process.env.TMUX_PANE) {
    args.splice(4, 0, "-t", process.env.TMUX_PANE);
  }
  const paneId = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!paneId.startsWith("%")) {
    throw new Error(`Unexpected tmux pane id: ${paneId || "(empty)"}`);
  }
  try {
    execFileSync("tmux", ["select-pane", "-t", paneId, "-T", name], { encoding: "utf8" });
  } catch {
    // Pane title is cosmetic and can fail on older tmux versions.
  }
  return paneId;
}

export function sendCommandToTmuxPane(paneId: string, command: string): void {
  execFileSync("tmux", ["send-keys", "-t", paneId, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", paneId, "Enter"], { encoding: "utf8" });
}

export function writeLaunchScript(path: string, command: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ["#!/bin/bash", "set -e", command, ""].join("\n"), { mode: 0o755 });
}

export function launchInteractiveSubagent(params: {
  name: string;
  task: string;
  persona?: string;
  model?: string;
  cwd: string;
  contextText?: string | null;
}): InteractiveSubagentState {
  const id = randomBytes(4).toString("hex");
  const cwd = resolve(params.cwd);
  const paths = createInteractiveSubagentPaths({ id, name: params.name, cwd });
  const prompt = buildInteractivePrompt({ task: params.task, contextText: params.contextText });

  mkdirSync(paths.artifactDir, { recursive: true });
  writeFileSync(paths.promptFile, prompt, { encoding: "utf8", mode: 0o600 });

  const systemPromptFile = params.persona ? paths.systemPromptFile : undefined;
  if (params.persona) {
    writeFileSync(paths.systemPromptFile, params.persona, { encoding: "utf8", mode: 0o600 });
  }

  const paneId = createTmuxPane(params.name, cwd);
  const command = buildPiInteractiveCommand({
    sessionFile: paths.sessionFile,
    name: params.name,
    promptFile: paths.promptFile,
    systemPromptFile,
    model: params.model,
    cwd,
  });
  writeLaunchScript(paths.launchScriptFile, command);
  sendCommandToTmuxPane(paneId, `bash ${shellEscape(paths.launchScriptFile)}`);

  const attach = buildTmuxAttachCommands(paneId);
  const state: InteractiveSubagentState = {
    id,
    name: params.name,
    task: params.task,
    paneId,
    sessionFile: paths.sessionFile,
    cwd,
    model: params.model,
    startedAt: Date.now(),
    status: "running",
    attachCommand: attach.attachCommand,
    selectPaneCommand: attach.selectPaneCommand,
    launchScriptFile: paths.launchScriptFile,
  };
  interactiveSubagentRegistry.set(id, state);
  return state;
}


export function isTmuxPaneAlive(paneId: string): boolean {
  try {
    execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function cancelInteractiveSubagent(id: string): InteractiveSubagentState | undefined {
  const state = interactiveSubagentRegistry.get(id);
  if (!state) return undefined;
  try {
    if (isTmuxPaneAlive(state.paneId)) {
      execFileSync("tmux", ["kill-pane", "-t", state.paneId], { encoding: "utf8" });
    }
  } catch {
    // Best effort.
  }
  state.status = "cancelled";
  return state;
}

export function pruneDeadInteractiveSubagents(): void {
  for (const state of interactiveSubagentRegistry.values()) {
    if (state.status === "running" && !isTmuxPaneAlive(state.paneId)) {
      state.status = existsSync(state.sessionFile) ? "unknown" : "unknown";
    }
  }
}

export function formatInteractiveState(state: InteractiveSubagentState): string {
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  return [
    `${state.name} (${state.id}) — ${state.status}, ${elapsed}s`,
    `Pane: ${state.paneId}`,
    `Session: ${state.sessionFile}`,
    `Attach: ${state.attachCommand}`,
    `From inside tmux: ${state.selectPaneCommand}`,
  ].join("\n");
}
