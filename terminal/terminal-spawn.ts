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
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 600000 = 10 minutes)" })),
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

      // Create job state (session will be null for terminal spawns)
      const liveStatus: SubagentLiveStatus = {
        turn: 0,
        output: "",
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
        socketServer = await createSocketServer(windowId, targetCwd, async (msg) => {
          if (msg.method === "progress" && msg.params?.output) {
            // Update liveStatus with progress
            liveStatus.output += msg.params.output as string;
          }
        });

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
        const resultPromise = new Promise<SubagentResult>((resolve) => {
          const timeoutMs = params.timeout ?? 600000; // 10 min default timeout
          const startTime = Date.now();
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
            } else if (msg.method === "progress" && msg.params?.output) {
              liveStatus.output += msg.params.output as string;
            }
          };

          // Timeout handler
          setTimeout(() => {
            if (done) return;
            done = true;
            resolve({
              output: `Timeout after ${timeoutMs}ms`,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
              model: params.model ?? "unknown",
              isError: true,
              errorMessage: "Timeout",
            });
          }, timeoutMs);
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
              `Use get_subagent_status({ jobId: "${jobId}" }) to check progress.\n` +
              `Use get_subagent_result({ jobId: "${jobId}" }) to collect output when done.\n\n` +
              `The terminal window is active - you can watch the agent work in real-time.`,
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
}
