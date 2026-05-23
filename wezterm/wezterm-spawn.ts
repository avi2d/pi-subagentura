/**
 * Wezterm Spawn Tool - Register wezterm_spawn tool
 *
 * Spawns pi in a new Wezterm pane with socket-based IPC for completion notification.
 * Uses the same socket protocol as tmux_spawn for consistency.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SocketServer } from "../tmux/tmux-agent";
import { createSocketServer } from "../tmux/tmux-agent";

// Reuse tmux exit handlers for consistency
const activePanes = new Set<string>();
const activeSockets = new Set<string>();

function trackPane(socketPath: string, paneId: string): void {
  activeSockets.add(socketPath);
  activePanes.add(paneId);
}

function untrackPane(socketPath: string, paneId: string): void {
  activeSockets.delete(socketPath);
  activePanes.delete(paneId);
}

let exitHandlersRegistered = false;

function registerExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  const cleanup = async () => {
    for (const pane of activePanes) {
      try {
        await new Promise<void>((resolve) => {
          execFile("wezterm", ["cli", "kill-pane", "--pane-id", pane], (err) => resolve());
        });
      } catch {}
    }
    activePanes.clear();

    for (const path of activeSockets) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(path, { force: true });
      } catch {}
    }
    activeSockets.clear();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
  process.on("uncaughtException", (err) => {
    console.error("[wezterm-spawn] uncaught exception:", err.message);
    cleanup().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[wezterm-spawn] unhandled rejection:", reason);
    cleanup().finally(() => process.exit(1));
  });
}

const WeztermSpawnParams = Type.Object({
  task: Type.String({ description: "Task for the wezterm agent" }),
  name: Type.Optional(Type.String({ description: "Pane label hint" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 60000)" })),
});

function isWeztermAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("wezterm", ["--version"], (err) => resolve(!err));
  });
}

async function waitForReady(readyPath: string, timeoutMs = 10000): Promise<boolean> {
  const { existsSync } = await import("node:fs");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(readyPath)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export function registerWeztermSpawn(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wezterm_spawn",
    label: "Wezterm Agent",
    description:
      "Spawn an agent in a new Wezterm pane with socket-based IPC.\n" +
      "Provides full visibility into agent execution via terminal.\n" +
      "Session persists after task completes — user can continue chatting.\n" +
      "Use when you need to see what the agent is doing in real-time.",
    parameters: WeztermSpawnParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const targetCwd = params.cwd ?? ctx.cwd;
      const timeoutMs = params.timeout ?? 60000;
      const paneId = `pi-agent-${randomBytes(4).toString("hex")}`;

      const weztermOk = await isWeztermAvailable();
      if (!weztermOk) {
        return {
          content: [{ type: "text", text: "wezterm not found. Install wezterm to use wezterm_spawn." }],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }

      let socketServer: SocketServer | undefined;
      let cleanupDone = false;
      const cleanup = async () => {
        if (cleanupDone) return;
        cleanupDone = true;
        try {
          await socketServer?.close();
        } catch {}
        if (socketServer) {
          untrackPane(socketServer.socketPath, paneId);
        }
      };

      try {
        registerExitHandlers();

        // Create socket server for IPC with subagent
        socketServer = await createSocketServer(paneId, targetCwd, async (msg) => {
          if (msg.method === "progress" && msg.params?.output) {
            onUpdate?.({
              content: [{ type: "text", text: msg.params.output as string }],
              details: {} as Record<string, unknown>,
            });
          }
        });

        trackPane(socketServer.socketPath, paneId);

        // Build command to run in wezterm pane
        const helperPath = require.resolve("./wezterm-agent-cli.js");
        const taskEscaped = params.task.replace(/"/g, '\\"');
        const piCmd = `node "${helperPath}" --socket "${socketServer.socketPath}" --cwd "${targetCwd}" --task "${taskEscaped}"`;

        // Spawn wezterm pane with the agent CLI
        await new Promise<void>((resolve, reject) => {
          execFile(
            "wezterm",
            [
              "cli",
              "spawn",
              "--cwd",
              targetCwd,
              "--",
              "bash",
              "-c",
              piCmd,
            ],
            (err) => {
              if (err) reject(new Error(`wezterm cli spawn failed: ${err.message}`));
              else resolve();
            },
          );
        });

        // Wait for subagent to be ready
        const ready = await waitForReady(socketServer.readyFilePath, 10000);
        if (!ready) {
          await cleanup();
          return {
            content: [{ type: "text", text: "Wezterm agent failed to start within 10s" }],
            isError: true,
            details: {} as Record<string, unknown>,
          };
        }

        // Send task to the wezterm agent
        socketServer.sendTask(params.task);

        // Wait for result
        const result = await new Promise<{
          output: string;
          usage: unknown;
          isError: boolean;
          duration: number;
        }>((resolve) => {
          const startTime = Date.now();
          let done = false;
          const timeoutId = setTimeout(() => {
            if (done) return;
            done = true;
            cleanup().catch(() => {});
            resolve({
              output: `Timeout after ${timeoutMs}ms`,
              usage: {},
              isError: true,
              duration: Date.now() - startTime,
            });
          }, timeoutMs);

          socketServer!.onMessage = (msg: any) => {
            if (msg.method === "result") {
              if (done) return;
              done = true;
              clearTimeout(timeoutId);
              resolve({
                output: (msg.params?.output as string) || "(no output)",
                usage: msg.params?.usage ?? {},
                isError: false,
                duration: Date.now() - startTime,
              });
            } else if (msg.method === "error") {
              if (done) return;
              done = true;
              clearTimeout(timeoutId);
              resolve({
                output: `Agent error: ${msg.params?.message}`,
                usage: {},
                isError: true,
                duration: Date.now() - startTime,
              });
            } else if (msg.method === "progress" && msg.params?.output) {
              onUpdate?.({
                content: [{ type: "text", text: msg.params.output as string }],
                details: {} as Record<string, unknown>,
              });
            }
          };
        });

        await cleanup();
        return {
          content: [{ type: "text", text: result.output }],
          details: { duration: result.duration, usage: result.usage, isError: result.isError },
        };
      } catch (err) {
        await cleanup();
        return {
          content: [
            {
              type: "text",
              text: `wezterm_spawn failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }
    },
  });
}
