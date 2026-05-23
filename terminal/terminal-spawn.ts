/**
 * Terminal Spawn Tool - Register terminal_spawn tool
 *
 * Spawns pi in a tmux or wezterm terminal with:
 * - Real-time visibility (watch agent work)
 * - Job registry integration (status tracking)
 * - Socket-based IPC for result retrieval
 *
 * Combines the real-time terminal visibility of tmux_spawn/wezterm_spawn
 * with the job registry tracking of async subagents.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { jobRegistry, type JobState, type SubagentResult, type SubagentLiveStatus, generateJobId } from "../helpers";
import { deliverNotification } from "../subagent";
import type { SocketServer } from "../tmux/tmux-agent";
import { createSocketServer } from "../tmux/tmux-agent";

const FOOTER_KEY = "subagentura-running";

/** Track active terminal spawn jobs for completion */
const activeTerminalJobs = new Map<string, {
	socketServer: SocketServer;
	windowId: string;
	backend: "tmux" | "wezterm";
}>();

const TerminalSpawnParams = Type.Object({
	task: Type.String({ description: "Task for the terminal agent" }),
	persona: Type.Optional(Type.String({ description: "Persona/system prompt for the agent" })),
	model: Type.Optional(Type.String({ description: "Model to use (e.g. 'minimax/MiniMax-M2.7')" })),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	backend: Type.Union([
		Type.Literal("tmux", { description: "Use tmux terminal backend" }),
		Type.Literal("wezterm", { description: "Use wezterm terminal backend" }),
	], {
		description: "Terminal backend to use",
	}),
	maxAge: Type.Optional(Type.Number({ description: "TTL in ms for completed job retention" })),
	notifyOnComplete: Type.Optional(Type.Union([
		Type.Literal("notify", { description: "Send notification when complete" }),
		Type.Literal("inject", { description: "Inject result as user message when complete" }),
	])),
});

async function isTmuxAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("tmux", ["-V"], (err) => resolve(!err));
	});
}

async function isWeztermAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("wezterm", ["--version"], (err) => resolve(!err));
	});
}

function killTmuxWindow(windowName: string): Promise<void> {
	return new Promise((resolve) => {
		execFile("tmux", ["kill-window", "-t", windowName], () => resolve());
	});
}

function killWeztermPane(paneId: string): Promise<void> {
	return new Promise((resolve) => {
		execFile("wezterm", ["cli", "kill-pane", "--pane-id", paneId], () => resolve());
	});
}

export function registerTerminalSpawn(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "terminal_spawn",
		label: "Terminal Agent",
		description: [
			"Spawn an agent in a tmux or wezterm terminal with real-time visibility.",
			"Provides full terminal visibility while also registering in job registry.",
			"",
			"Key features:",
			"  - Watch agent work in real-time via terminal",
			"  - Job tracked in registry for status/result retrieval",
			"  - User can interact with terminal directly",
			"",
			"Params similar to subagent_isolated, plus backend selection.",
			"",
			"Returns jobId immediately - use get_subagent_status to monitor,",
			"get_subagent_result when complete.",
		].join("\n"),
		parameters: TerminalSpawnParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const targetCwd = params.cwd ?? ctx.cwd;
			const backend = params.backend;
			const windowId = `pi-agent-${randomBytes(4).toString("hex")}`;

			// Check backend availability
			if (backend === "tmux") {
				const tmuxOk = await isTmuxAvailable();
				if (!tmuxOk) {
					return {
						content: [{ type: "text", text: "tmux not found. Install tmux to use backend 'tmux'." }],
						isError: true,
						details: {},
					};
				}
			} else if (backend === "wezterm") {
				const weztermOk = await isWeztermAvailable();
				if (!weztermOk) {
					return {
						content: [{ type: "text", text: "wezterm not found. Install wezterm to use backend 'wezterm'." }],
						isError: true,
						details: {},
					};
				}
			}

			const jobId = generateJobId();

			// For terminal spawns, we don't accumulate terminal output in liveStatus
			// since the user is watching the terminal directly. We just track minimal status.
			const liveStatus: SubagentLiveStatus = {
				turn: 0,
				output: "(watch terminal for real-time output)",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			};

			let socketServer: SocketServer | undefined;
			let cleanupDone = false;

			const cleanup = async () => {
				if (cleanupDone) return;
				cleanupDone = true;
				try {
					await socketServer?.close();
				} catch {}
				if (socketServer) {
					try {
						if (backend === "tmux") {
							await killTmuxWindow(windowId);
						} else if (backend === "wezterm") {
							await killWeztermPane(windowId);
						}
					} catch {}
				}
			};

			try {
				// Create socket server for IPC
				// Note: For terminal spawns, we don't accumulate output in liveStatus
				// since user watches terminal directly. Progress messages are ignored.
				socketServer = await createSocketServer(windowId, targetCwd);

				// Build the pi command
				const helperPath = require.resolve(`../${backend}/${backend}-agent-cli.js`);
				const taskEscaped = params.task.replace(/"/g, '\\"');
				const personaArg = params.persona ? `--persona "${params.persona.replace(/"/g, '\\"')}"` : "";
				const modelArg = params.model ? `--model ${params.model}` : "";
				const piCmd = `node "${helperPath}" --socket "${socketServer.socketPath}" --cwd "${targetCwd}" --task "${taskEscaped}" ${personaArg} ${modelArg}`.trim();

				// Spawn in tmux or wezterm
				if (backend === "tmux") {
					await new Promise<void>((resolve, reject) => {
						execFile(
							"tmux",
							["new-window", "-n", windowId, "-c", targetCwd, piCmd],
							(err) => {
								if (err) reject(new Error(`tmux new-window failed: ${err.message}`));
								else resolve();
							},
						);
					});
				} else if (backend === "wezterm") {
					await new Promise<void>((resolve, reject) => {
						execFile(
							"wezterm",
							["cli", "spawn", "--new-window", "--cwd", targetCwd, "--", "bash", "-l", "-c", `${piCmd}; exec bash`],
							(err) => {
								if (err) reject(new Error(`wezterm cli spawn failed: ${err.message}`));
								else resolve();
							},
						);
					});
				}

				// Wait for agent to be ready
				const { existsSync } = await import("node:fs");
				const startTime = Date.now();
				const readyTimeout = 10000;
				while (Date.now() - startTime < readyTimeout) {
					if (existsSync(socketServer.readyFilePath)) break;
					await new Promise((r) => setTimeout(r, 100));
				}

				// Send task to the agent
				socketServer.sendTask(params.task);

				// Create the result promise - this will resolve when the agent completes
				// No timeout - terminal spawn is for real-time viewing, user controls when done
				const resultPromise = new Promise<SubagentResult>((resolve) => {
					let done = false;

					socketServer!.onMessage = (msg: any) => {
						if (done) return;

						if (msg.method === "result") {
							done = true;
							resolve({
								output: (msg.params?.output as string) || "(no output)",
								usage: msg.params?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
								model: params.model ?? "unknown",
								isError: false,
							});
						} else if (msg.method === "error") {
							done = true;
							resolve({
								output: `Agent error: ${msg.params?.message}`,
								usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
								model: params.model ?? "unknown",
								isError: true,
								errorMessage: msg.params?.message,
							});
						} else if (msg.method === "progress" && msg.params?.turn !== undefined) {
							// Track turn count from progress if available
							liveStatus.turn = msg.params.turn as number;
						}
					};
				});

				// Register job in registry
				const jobState: JobState = {
					id: jobId,
					status: "running",
					liveStatus,
					session: null, // No AgentSession for terminal spawns
					startedAt: Date.now(),
					promise: resultPromise,
					modelLabel: params.model,
					notifyOnComplete: params.notifyOnComplete,
					notificationDelivered: false,
					maxAge: params.maxAge,
				};

				jobRegistry.set(jobId, jobState);

				// Track for completion
				activeTerminalJobs.set(jobId, {
					socketServer: socketServer!,
					windowId,
					backend,
				});

				// Update footer status
				const runningCount = [...jobRegistry.values()].filter((j) => j.status === "running").length;
				try {
					ctx.ui.setStatus(FOOTER_KEY, `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`);
				} catch {}

				// Handle completion
				resultPromise.then((result) => {
					if (jobState.status === "cancelled") return;
					jobState.status = result.isError ? "error" : "done";
					jobState.result = result;

					// Clean up tracking
					activeTerminalJobs.delete(jobId);

					// Schedule cleanup if maxAge specified
					if (params.maxAge && params.maxAge > 0) {
						setTimeout(() => jobRegistry.delete(jobId), params.maxAge);
					}

					// Deliver notification if requested
					if (jobState.notifyOnComplete && !jobState.notificationDelivered) {
						jobState.notificationDelivered = true;
						deliverNotification(jobState, result);
					}
				});

				// Return immediately with jobId
				return {
					content: [{
						type: "text" as const,
						text: `Job ${jobId} started in ${backend} window: ${windowId}\n\n` +
							`Watch the agent work in real-time in the ${backend} window.\n` +
							`When done, close the window to trigger completion.\n` +
							`You'll receive a ${params.notifyOnComplete ?? "notification"} when the job completes.\n\n` +
							`Use get_subagent_status({ jobId: "${jobId}" }) to check status.\n` +
							`Use get_subagent_result({ jobId: "${jobId}" }) to get final output.`,
					}],
					details: {
						jobId,
						status: "started",
						windowId,
						backend,
					},
				};
			} catch (err) {
				await cleanup();
				return {
					content: [{
						type: "text" as const,
						text: `terminal_spawn failed: ${err instanceof Error ? err.message : String(err)}`,
					}],
					isError: true,
					details: {},
				};
			}
		},
	});

	// ── Complete Terminal Job Tool ──────────────────────────────────────────
	pi.registerTool({
		name: "complete_terminal_job",
		label: "Complete Terminal Job",
		description:
			"Signal a terminal_spawn job to complete. " +
			"Captures current output, exits bridge process, but keeps pi running in terminal. " +
			"Use when done watching but want to continue chatting with pi directly.",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job ID returned by terminal_spawn" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const job = activeTerminalJobs.get(params.jobId);

			if (!job) {
				// Check if job exists in registry (might have already completed)
				const registryJob = jobRegistry.get(params.jobId);
				if (!registryJob) {
					return {
						content: [{ type: "text", text: `Job ${params.jobId} not found.` }],
						isError: true,
						details: {},
					};
				}
				if (registryJob.status === "done" || registryJob.status === "error") {
					return {
						content: [{ type: "text", text: `Job ${params.jobId} already ${registryJob.status}.` }],
						isError: true,
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: `Job ${params.jobId} is not a terminal_spawn job or already completed.` }],
					isError: true,
					details: {},
				};
			}

			// Send complete signal to the agent CLI
			job.socketServer.sendComplete();

			return {
				content: [{
					type: "text" as const,
					text: `Complete signal sent to job ${params.jobId}.\n\n` +
						`Pi is still running in the ${job.backend} window!\n` +
						`Continue chatting with pi directly in that terminal.\n` +
						`Session is saved for later if needed.\n\n` +
						`You'll receive a notification with the current output.`,
				}],
				details: {
					jobId: params.jobId,
					status: "completing",
					backend: job.backend,
				},
			};
		},
	});
}
