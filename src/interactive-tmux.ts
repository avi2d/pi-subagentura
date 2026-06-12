import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CLI_SOURCE } from "./subagent-artifact-cli";
import { artifactPath, lastEvent, type SubagentArtifact, type SubagentEvent } from "./artifact";

/**
 * System prompt sent to every interactive sub-agent. Tells the child how to
 * signal completion so the parent can be notified, and where to write its
 * result. The persona (if provided) is placed ABOVE this so the protocol —
 * the part that keeps the parent-child notification loop working — is the
 * most recent instruction the LLM reads (recency wins for instruction
 * following).
 *
 * `artifactDir` is the resolved absolute path baked into the prompt so the
 * child can use it directly in `write` tool calls. Bash commands and `cli.mjs`
 * calls still work via the exported `ARTIFACT_DIR` env var from the launch
 * script, but the `write` tool treats its `path` argument as a literal string,
 * so we must give it the absolute path up front.
 */
export function buildChildSubagentProtocol(artifactDir: string): string {
	const cliPath = `${artifactDir}/cli.mjs`;
	const outputPath = `${artifactDir}/output.md`;
	return `You are running inside a Pi sub-agent launched by a parent agent. The parent agent reads your work from two files in your artifact directory and from one CLI command. You MUST follow this protocol or your work will be lost.

BE BRIEF. The parent does not need a play-by-play of your reasoning — it needs a concise final answer in output.md and a one-sentence summary in step 3. Skip the recap, the apology, and the "let me know if..." closer. Long preambles waste tokens and delay the done signal.

Your artifact directory is: ${artifactDir}

  output.md      — your final result (prose, findings, code, whatever the parent asked for)
  events.ndjson  — append-only lifecycle log (managed by the wrapper, you do not write to it)
  cli.mjs        — the wrapper's lifecycle helper, invoked via bash

Use the literal path above in your \`write\` tool calls — the \`write\` tool does not expand \$ARTIFACT_DIR or any other shell variable, so a path like "\$ARTIFACT_DIR/output.md" will be written literally to a file of that name and never reach the parent.

When your task is done, follow this checklist in order. The parent is a parent agent and cannot guess that you have finished — it will only know after step 4 fires. Skipping any step means the parent will wait forever (or the wrapper will eventually synthesize an error).

  1. Stop calling tools. If you are mid-tool-call, finish it.
  2. Write your final result to ${outputPath} using the \`write\` tool. Use the exact path above. If you have already written the result to some other path (a /tmp file, a project file, etc.), copy or append it to output.md so the parent can read it.
  3. Produce your final assistant text in the chat summarising what you did and where to find the work.
  4. Run exactly one of these bash commands. \$ARTIFACT_DIR is exported to your shell by the wrapper, so the quoted forms expand correctly even if the path contains spaces:

       "$ARTIFACT_DIR/cli.mjs" done 0       # success
       "$ARTIFACT_DIR/cli.mjs" error "short reason"   # unrecoverable failure

  5. Stay in the REPL. Do not call \`/exit\` or press Ctrl-D. The REPL stays open after step 4 so the user (or the parent) can follow up; the wrapper's EXIT trap will only fire if you actually exit. If you exit, the wrapper will treat it as a crash and the parent will not see your final answer.

Do not call 'cancelled' yourself — the parent agent writes that event only when it explicitly aborts you via the cancel_interactive_subagent tool.

For reference: ${cliPath} is the lifecycle CLI. Each invocation appends one NDJSON line to events.ndjson. The parent reads that file every few seconds. The atomic write pattern (write to .tmp, then rename onto output.md) is fine if you want crash-safety.

─── HARDENING REMINDER (read this last, it is the most recent instruction on purpose) ───
If you forget step 4 (\`cli.mjs done\`), the parent will eventually synthesize a fallback \`error\` event from your session log, but only if your final assistant turn ended with stopReason "stop" and you have not produced any output for 10 seconds. That fallback may not include the full result if output.md is missing. The reliable path is: write output.md FIRST, then call \`cli.mjs done 0\`. If the wrapper detects an auto-fallback it will not double-inject, so do not worry about being late — but a late done is still better than no done. If you have finished your work, your single next action should be the \`cli.mjs done\` command, not another tool call.`;
}

/**
 * Sub-agent status for the interactive (tmux-backed) registry.
 *
 * - "running"  — child is processing a turn (last artifact event is "started" or absent)
 * - "idle"     — child finished a turn, REPL is open, pane alive; ready for a follow-up prompt
 * - "cancelled" — parent called cancel_interactive_subagent; terminal, no follow-up allowed
 * - "exited"   — child pi process is actually gone (pane dead, or it called `error`); terminal
 * - "unknown"  — can't determine (rare; pane dead but no recorded event)
 */
export type InteractiveSubagentStatus = "running" | "idle" | "cancelled" | "exited" | "unknown";

export interface InteractiveSubagentState {
	id: string;
	name: string;
	task: string;
	paneId: string;
	/** tmux window name (set when spawned in background mode via new-window -n). */
	windowName?: string;
	sessionFile: string;
	cwd: string;
	model?: string;
	startedAt: number;
	/**
	 * Lifecycle status. Transition triggers:
	 * - spawn sets "running" (interactive-tmux.ts setup)
	 * - cli.mjs done / error event in events.ndjson sets "exited" or "cancelled"
	 * - user-msg after "exited" revives to "running" so follow-up turns can fire
	 *   auto-done again (subagent.ts processSessionLogEntry)
	 * - cancel_interactive_subagent tool sets "cancelled"
	 */
	status: InteractiveSubagentStatus;
	/** Captured child pi exit code (0 = success). Undefined while still running. */
	exitCode?: number;
	attachCommand: string;
	selectPaneCommand: string;
	launchScriptFile: string;
	/** Absolute path to the artifact directory (events.ndjson + output.md). */
	artifactDir: string;
	/**
	 * Timestamp of the last artifact event we delivered a notification for.
	 *
	 * The poller only fires for events with `ts > lastDeliveredEventTs`, so
	 * this is the per-state at-most-once guard. Set on first delivery; defaults
	 * to 0 to ensure the first event is always delivered.
	 */
	lastDeliveredEventTs?: number;
	/**
	 * Byte offset into the child's session JSONL that we have already processed.
	 * The poller tail-reads the session file from this offset each tick and synthesizes
	 * `tool_activity` events for any new tool calls. Same at-most-once guarantee as
	 * `lastDeliveredEventTs`, but byte-granular for append-only JSONL efficiency.
	 */
	lastDeliveredSessionByte?: number;
	/** Most recent tool_activity summary, for the TUI widget. */
	lastToolSummary?: string;
	lastToolName?: string;
	lastActivityAt?: number;
	/**
	 * Last terminal stopReason seen in the child session log (assistant message).
	 * One of "stop" | "length" | "error" | "aborted". Updated whenever we tail-read a new
 * assistant message. Drives the auto-done fallback: when the model ends a turn with
 * "stop" but forgets to call `cli.mjs done`, the parent synthesizes a completion event.
	 */
	lastStopReason?: "stop" | "length" | "error" | "aborted";
	/** Timestamp of the last assistant message that produced `lastStopReason`. Used as the
 * debounce anchor for the auto-done fallback (default debounce: 10s of no further activity).
	 */
	lastStopReasonAt?: number;
	/** Timestamp of the auto-synthesized `done` event for the current turn, or undefined for a fresh turn.
 * The auto-done logic sets this when it fires; the poller also uses it to suppress duplicate
 * notifications if the explicit `cli.mjs done` lands shortly after the fallback synthesis.
 * Cleared on a new user-role message in the session log (next turn starts).
	 */
	autoDoneForTurnAt?: number;
	/** Last assistant text the model produced on a terminal-turn (stopReason:"stop") message.
 * Captured at session-log tail-read time. Used as fallback content in the synthesized error
 * event when output.md is missing — most models inline a summary in chat even when they write
 * the result to a non-artifact path (very common footgun).
	 */
	lastStopText?: string;
	/**
	 * Notification delivery mode requested by spawner's notifyOnComplete param.
	 * "notify" (default) emits a UI hint on completion. "inject" also injects
	 * output.md as a user message so the parent LLM processes it in its next turn.
	 */
	notifyOnComplete?: "notify" | "inject";
	/** At-most-once guard for the inject path (mirrors lastDeliveredEventTs). */
	/**
 * Timestamp of the last artifact `done` event whose output was injected into the parent.
 * Mirrors `lastDeliveredEventTs` but only for the inject path. Compared against the current `done`
 * event's `ts` so each NEW turn re-injects (follow-up support). Set on first inject; `undefined` means
 * "never injected".
 */
	lastInjectedEventTs?: number;
	/**
	 * Auto-fallback "already notified" flag (PR #11). Set by maybeAutoDone when synthesize-and-inject
	 * runs, so a late explicit `done` event that lands on the next poll does NOT re-trigger the
	 * regular inject path. Independent of `lastInjectedEventTs` which is the per-event guard for
	 * the child-driven `done` path.
	 */
	injected?: boolean;
}

declare global {
	var __piSubagenturaInteractiveRegistry: Map<string, InteractiveSubagentState> | undefined;
}

if (!globalThis.__piSubagenturaInteractiveRegistry) {
	globalThis.__piSubagenturaInteractiveRegistry = new Map<string, InteractiveSubagentState>();
}

export const interactiveSubagentRegistry = globalThis.__piSubagenturaInteractiveRegistry!;

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

export function buildTmuxAttachCommands(
  paneId: string,
  opts: { windowName?: string } = {},
): { attachCommand: string; selectPaneCommand: string } {
  if (opts.windowName) {
    // Background mode: pane lives in a named detached window. Attach command
    // chains `attach -t <session>` with `select-window -t <windowName>` so it
    // works from outside the session too. Inside-tmux callers get the same
    // effect via `\\;` chaining — the attach errors with "nested sessions"
    // but the select-window still runs.
    const location = getPaneLocation(paneId);
    return {
      attachCommand: `tmux attach -t ${shellEscape(location.session)} \\; select-window -t ${shellEscape(opts.windowName)}`,
      selectPaneCommand: `tmux select-window -t ${shellEscape(opts.windowName)}`,
    };
  }
  const location = getPaneLocation(paneId);
  const targetWindow = `${location.session}:${location.window}`;
  return {
    attachCommand: `tmux attach -t ${shellEscape(location.session)} \\; select-window -t ${shellEscape(targetWindow)} \\; select-pane -t ${shellEscape(paneId)}`,
    selectPaneCommand: `tmux select-pane -t ${shellEscape(paneId)}`,
  };
}

export function createTmuxPane(
  name: string,
  cwd: string,
  opts: { background: boolean },
): { paneId: string; windowName?: string } {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is not available. ${tmuxSetupHint()}`);
  }
  let paneId: string;
  let windowName: string | undefined;
  if (opts.background) {
    // Spawn in a new detached window — invisible to the user until they select
    // it. Each background sub-agent gets its own named window so they don't
    // clobber each other in the tmux window list.
    windowName = safeSegment(name);
    paneId = execFileSync(
      "tmux",
      ["new-window", "-d", "-n", windowName, "-P", "-F", "#{pane_id}", "-c", cwd],
      { encoding: "utf8" },
    ).trim();
  } else {
    // Visible horizontal split — parent pane keeps focus. Same session,
    // immediately adjacent to the parent's pane.
    const args = ["split-window", "-d", "-h", "-P", "-F", "#{pane_id}", "-c", cwd];
    if (process.env.TMUX_PANE) {
      args.splice(4, 0, "-t", process.env.TMUX_PANE);
    }
    paneId = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  }
  if (!paneId.startsWith("%")) {
    throw new Error(`Unexpected tmux pane id: ${paneId || "(empty)"}`);
  }
  if (!opts.background) {
    // Pane title is cosmetic and the new window already shows `name`.
    try {
      execFileSync("tmux", ["select-pane", "-t", paneId, "-T", name], { encoding: "utf8" });
    } catch {
      // Pane title is cosmetic and can fail on older tmux versions.
    }
  }
  return { paneId, windowName };
}

export function sendCommandToTmuxPane(paneId: string, command: string): void {
  execFileSync("tmux", ["send-keys", "-t", paneId, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", paneId, "Enter"], { encoding: "utf8" });
}

export function writeLaunchScript(path: string, command: string, artifactDir: string): void {
	mkdirSync(dirname(path), { recursive: true });

	// 1. Write the inline `subagent-artifact` CLI helper into the artifact dir.
	//    The wrapper and child both invoke it for lifecycle events.

	const cliPath = join(artifactDir, "cli.mjs");
	writeFileSync(cliPath, CLI_SOURCE, { mode: 0o700 });

	// 2. Write the launch script. The script:
	//    - exports ARTIFACT_DIR so the child inherits it;
	//    - calls `cli.mjs start` to record the started event;
	//    - traps EXIT to call `cli.mjs done <code>` (or `cancelled` if a .cancelled flag is present);
	//    - also writes the @pi-exit-code pane option for the readPaneExitCode fallback.
	const script = [
		"#!/bin/bash",
		"set -e",
		`export ARTIFACT_DIR=${shellEscape(artifactDir)}`,
		`"${cliPath}" start`,
		`trap 'if [ -f "${artifactDir}/.cancelled" ]; then "${cliPath}" cancelled; else "${cliPath}" done "$?"; fi; tmux set-option -p -t "$TMUX_PANE" @pi-exit-code "$?" 2>/dev/null || true' EXIT`,
		command,
		"",
	].join("\n");
	// 0o700: only the owning user can read the script (which embeds absolute
	// paths to session/prompt/system files). 0o755 would leak the layout.
	writeFileSync(path, script, { mode: 0o700 });
}

export function launchInteractiveSubagent(params: {
	name: string;
	task: string;
	persona?: string;
	model?: string;
	cwd: string;
	contextText?: string | null;
	/** Spawn in a detached named window (invisible) instead of a visible split. */
	background?: boolean;
	/**
	 * Notification delivery mode requested by the spawner. "notify" (default)
	 * emits a UI hint on completion. "inject" also injects output.md as a user
	 * message so the parent LLM processes it in its next turn.
	 */
	notifyOnComplete?: "notify" | "inject";
}): InteractiveSubagentState {

	const id = randomBytes(4).toString("hex");
	const cwd = resolve(params.cwd);
	const background = params.background !== false; // default true (hidden)
	const paths = createInteractiveSubagentPaths({ id, name: params.name, cwd });
	const prompt = buildInteractivePrompt({ task: params.task, contextText: params.contextText });

	mkdirSync(paths.artifactDir, { recursive: true });
	writeFileSync(paths.promptFile, prompt, { encoding: "utf8", mode: 0o600 });

	// Cap the persona to prevent a misbehaving parent from shipping a huge
	// system prompt to the model on every turn. 64 KiB is well above what any
	// realistic persona needs; larger values are rejected so the child session
	// fails fast with a clear error.
	const MAX_PERSONA_BYTES = 64 * 1024;
	if (params.persona !== undefined && Buffer.byteLength(params.persona, "utf8") > MAX_PERSONA_BYTES) {
		throw new Error(
			`persona too large: ${Buffer.byteLength(params.persona, "utf8")} bytes (max ${MAX_PERSONA_BYTES})`,
		);
	}

	// Always write a system prompt that includes the child protocol, and place
	// the user-supplied persona (if any) ABOVE the protocol. Recency wins for
	// instruction-following, so the protocol — the part that keeps the
	// parent-child notification loop working — is the most recent instruction
	// the LLM reads. A persona that says "ignore the protocol" is a known LLM
	// footgun, and placing the protocol last makes it stick.
	const protocol = buildChildSubagentProtocol(paths.artifactDir);
	const systemPromptContent = params.persona
		? `# Persona\n\n${params.persona}\n\n${protocol}`
		: protocol;
	writeFileSync(paths.systemPromptFile, systemPromptContent, { encoding: "utf8", mode: 0o600 });

	const systemPromptFile = paths.systemPromptFile;


	// Create the pane FIRST (so we have a target for the launch script to attach
	// to). If any later step throws, try to kill the orphan pane and rethrow.
	const { paneId, windowName } = createTmuxPane(params.name, cwd, { background });
	try {
		const command = buildPiInteractiveCommand({
			sessionFile: paths.sessionFile,
			name: params.name,
			promptFile: paths.promptFile,
			systemPromptFile,
			model: params.model,
			cwd,
		});
		writeLaunchScript(paths.launchScriptFile, command, paths.artifactDir);
		sendCommandToTmuxPane(paneId, `bash ${shellEscape(paths.launchScriptFile)}`);
	} catch (err) {
		// F2 fix: orphan-pane guard. If writeLaunchScript or sendCommandToTmuxPane
		// throws after the pane was created, kill the pane before rethrowing so
		// we don't leak it into the user's tmux.
		try {
			execFileSync("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" });
		} catch {
			/* best effort */
		}
		throw err;
	}

	const attach = buildTmuxAttachCommands(paneId, { windowName });
	const state: InteractiveSubagentState = {
		id,
		name: params.name,
		task: params.task,
		paneId,
		windowName,
		sessionFile: paths.sessionFile,
		cwd,
		model: params.model,
		startedAt: Date.now(),
		status: "running",
		attachCommand: attach.attachCommand,
		selectPaneCommand: attach.selectPaneCommand,
		launchScriptFile: paths.launchScriptFile,
		artifactDir: paths.artifactDir,
		notifyOnComplete: params.notifyOnComplete,
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

/**
 * Read the @pi-exit-code pane option set by the launch script's EXIT trap.
 * Returns the numeric exit code, or null if the option is not set (child still
 * running) or the pane is dead.
 */
export function readPaneExitCode(paneId: string): number | null {
  try {
    const value = execFileSync(
      "tmux",
      ["show-options", "-p", "-v", "-t", paneId, "@pi-exit-code"],
      // stderr must be ignored: while the child is still running the option is
      // unset and tmux would otherwise print `invalid option: @pi-exit-code` to
      // the parent's stderr (the agent's TUI). We rely on the non-zero exit +
      // catch below to detect "not set", not on stderr.
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!value) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  } catch {
    // Option unset (still running) or pane dead.
    return null;
  }
}

export function captureTmuxPane(paneId: string, lines = 80): string {
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", paneId, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
}

export function cancelInteractiveSubagent(id: string): InteractiveSubagentState | undefined {
	const state = interactiveSubagentRegistry.get(id);
	if (!state) return undefined;

	// 1. Drop a `.cancelled` flag file in the artifact dir. The wrapper's EXIT trap
	//    checks for this before writing the `done` event; if present, it writes
	//    `cancelled` instead so the artifact log is self-describing.
	try {
		writeFileSync(join(state.artifactDir, ".cancelled"), "", { mode: 0o600 });
	} catch {
		/* best effort — dir may not exist yet if the launch script is still warming up */
	}

	// 2. Update the registry. The poller combines this with the artifact's last event.
	state.status = "cancelled";

	// 3. Kill the pane. The wrapper's EXIT trap fires and records the event.
	try {
		if (isTmuxPaneAlive(state.paneId)) {
			execFileSync("tmux", ["kill-pane", "-t", state.paneId], { encoding: "utf8" });
		}
	} catch {
		// Best effort.
	}
	return state;
}

/**
 * Pure status-decision matrix used by both `pruneDeadInteractiveSubagents` (here) and the
 * artifact poller in `subagent.ts`. Pulled out so the rules are testable without a live tmux.
 *
 * Semantics: a `done` event means "this turn is finished" — the child's REPL stays open and the
 * child is ready for a follow-up prompt. Only `error` / pane-dead / `cancelled` are terminal.
 */
export function deriveInteractiveSubagentStatus(
	lastEvent: SubagentEvent | null,
	paneAlive: boolean,
): InteractiveSubagentStatus {
	if (lastEvent) {
		if (lastEvent.type === "cancelled") return "cancelled";
		if (lastEvent.type === "error") return "exited"; // child declared it unrecoverable; terminal
		if (lastEvent.type === "done") return paneAlive ? "idle" : "exited";
	}
	return paneAlive ? "running" : "unknown";
}

/**
 * Update registry status for every tracked sub-agent based on the artifact's last event and
 * tmux pane liveness. Idempotent — safe to call on every poll tick.
 *
 * Follow-up support: a `done` event with a live pane is the "idle" state, NOT exited. The child
 * is between turns, REPL is open, and `send_interactive_subagent_message` will accept more prompts.
 * Only when the pane is actually gone (or the child called `error`) is the sub-agent terminal.
 *
 * Edge case: if the pane is dead and no `done` event was recorded (tmux died before the launch
 * trap could write it), fall back to the session-file existence check — same heuristic as before.
 */
export function pruneDeadInteractiveSubagents(): void {
	for (const state of interactiveSubagentRegistry.values()) {
		if (state.status !== "running" && state.status !== "idle") continue;
		const art = artifactPath(dirname(state.artifactDir), basename(state.artifactDir));
		const last = lastEvent(art);
		const paneAlive = isTmuxPaneAlive(state.paneId);
		let next = deriveInteractiveSubagentStatus(last, paneAlive);
		// Session-file fallback: if the pane is gone and no event was recorded, the child died.
		// A non-empty session file means the child pi at least started writing — mark as exited.
		if (next === "unknown" && state.sessionFile && existsSync(state.sessionFile)) {
			next = "exited";
		}
		if (next === state.status) continue;
		state.status = next;
		if (next === "exited" && last && last.type === "done" && last.exitCode !== undefined) {
			state.exitCode = last.exitCode;
		}
	}
}

export function formatInteractiveState(state: InteractiveSubagentState): string {
	const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
	const lines: string[] = [
		`${state.name} (${state.id}) — ${state.status}, ${elapsed}s`,
		`Pane: ${state.paneId}`,
	];
	if (state.windowName) lines.push(`Window: ${state.windowName}`);
	if (state.exitCode !== undefined) lines.push(`Exit code: ${state.exitCode}`);
	lines.push(
		`Artifact: ${state.artifactDir}`,
		`Session: ${state.sessionFile}`,
		`Attach: ${state.attachCommand}`,
		`From inside tmux: ${state.selectPaneCommand}`,
	);
	return lines.join("\n");
}
