/**
 * Tmux Spawn Tool - Register tmux_spawn tool
 *
 * This is a separate module to avoid complex string manipulation in subagent.ts.
 * Import and call registerTmuxSpawn(pi) from subagent.ts extension factory.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SocketServer } from "./tmux-agent";
import { createSocketServer } from "./tmux-agent";

// ── Process Exit Cleanup ─────────────────────────────────────────────────

/** Track active tmux windows and sockets for cleanup on abnormal exit */
const activeWindows = new Set<string>();
const activeSockets = new Set<string>();

/**
 * Register a tmux window name and socket path for cleanup.
 * Called when a spawn successfully starts.
 */
function trackWindow(socketPath: string, windowName: string): void {
  activeSockets.add(socketPath);
  activeWindows.add(windowName);
}

/**
 * Unregister a tmux window and socket after successful cleanup.
 * Called when a spawn completes normally.
 */
function untrackWindow(socketPath: string, windowName: string): void {
  activeSockets.delete(socketPath);
  activeWindows.delete(windowName);
}

// ── Process exit handlers ────────────────────────────────────────────────

// Only register exit handlers once per process
let exitHandlersRegistered = false;

function registerExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  const cleanup = async () => {
    // Kill all tracked tmux windows
    for (const win of activeWindows) {
      try {
        await new Promise<void>((resolve) => {
          execFile("tmux", ["kill-window", "-t", win], (err) => resolve());
        });
      } catch {
        // Best-effort cleanup
      }
    }
    activeWindows.clear();

    // Close all tracked sockets
    for (const path of activeSockets) {
      try {
        // Import dynamically to avoid circular deps at module load
        const { rm } = await import("node:fs/promises");
        await rm(path, { force: true });
      } catch {
        // Best-effort cleanup
      }
    }
    activeSockets.clear();
  };

  // Clean up on abnormal process exit
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  // Also clean up on uncaught exceptions
  process.on("uncaughtException", (err) => {
    console.error("[tmux-spawn] uncaught exception:", err.message);
    cleanup().finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[tmux-spawn] unhandled rejection:", reason);
    cleanup().finally(() => process.exit(1));
  });
}

const TmuxSpawnParams = Type.Object({
  task: Type.String({ description: "Task for the tmux agent" }),
  name: Type.Optional(Type.String({ description: "tmux window name hint" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 60000)" })),
});

function isTmuxAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tmux", ["-V"], (err) => resolve(!err));
  });
}

function killTmuxWindow(windowName: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("tmux", ["kill-window", "-t", windowName], (err) => {
      if (err) {
        console.error(`[tmux-spawn] failed to kill window ${windowName}: ${err.message}`);
      }
      resolve();
    });
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

export function registerTmuxSpawn(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "tmux_spawn",
    label: "Tmux Agent",
    description:
      "Spawn an agent in a dedicated tmux window with socket-based IPC.\\n" +
      "Provides full visibility into agent execution via terminal.\\n" +
      "Use when you need to see what the agent is doing in real-time.",
    parameters: TmuxSpawnParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const targetCwd = params.cwd ?? ctx.cwd;
      const timeoutMs = params.timeout ?? 60000;
      const windowName = `pi-agent-${randomBytes(4).toString("hex")}`;

      const tmuxOk = await isTmuxAvailable();
      if (!tmuxOk) {
        return {
          content: [{ type: "text", text: "tmux not found. Install tmux to use tmux_spawn." }],
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
        await killTmuxWindow(windowName);
        if (socketServer) {
          untrackWindow(socketServer.socketPath, windowName);
        }
      };

      try {
        // Register exit handlers once
        registerExitHandlers();

        // Create socket server (parent-side listener)
        socketServer = await createSocketServer(windowName, targetCwd, async (msg) => {
          if (msg.method === "progress" && msg.params?.output) {
            onUpdate?.({
              content: [{ type: "text", text: msg.params.output as string }],
              details: {} as Record<string, unknown>,
            });
          }
        });

        // Track for cleanup on abnormal exit
        trackWindow(socketServer.socketPath, windowName);

        // Build command to run in tmux window
        // The tmux-agent-cli.js is a CommonJS script that:
        // 1. Connects to our socket
        // 2. Waits for task message
        // 3. Spawns pi with the task
        // 4. Streams output back via socket
        const helperPath = require.resolve("./tmux-agent-cli.js");
        const taskEscaped = params.task.replace(/"/g, '\\"');
        const piCmd = `node "${helperPath}" --socket "${socketServer.socketPath}" --cwd "${targetCwd}" --task "${taskEscaped}"`;

        // Spawn tmux window
        await new Promise<void>((resolve, reject) => {
          execFile(
            "tmux",
            ["new-window", "-n", windowName, "-c", targetCwd, piCmd],
            (err) => {
              if (err) reject(new Error(`tmux new-window failed: ${err.message}`));
              else resolve();
            },
          );
        });

        // Wait for subagent to be ready (signaled by .ready file)
        const ready = await waitForReady(socketServer.readyFilePath, 10000);
        if (!ready) {
          await cleanup();
          return {
            content: [{ type: "text", text: "Tmux agent failed to start within 10s" }],
            isError: true,
            details: {} as Record<string, unknown>,
          };
        }

        // Send task to the tmux agent
        console.error("[tmux-spawn] Calling sendTask with:", params.task);
        socketServer.sendTask(params.task);
        console.error("[tmux-spawn] sendTask called");

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
              text: `tmux_spawn failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }
    },
  });
}
