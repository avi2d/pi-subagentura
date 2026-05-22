/**
 * Wezterm Spawn Tool - Register wezterm_spawn tool
 *
 * Spawns pi in a new Wezterm pane with session persistence.
 * User can continue the session from any terminal.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

export function registerWeztermSpawn(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wezterm_spawn",
    label: "Wezterm Agent",
    description:
      "Spawn an agent in a new Wezterm pane with session persistence.\n" +
      "The user can continue chatting with the agent after the initial task completes.\n" +
      "Use when you want visible execution with session persistence.",
    parameters: WeztermSpawnParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const targetCwd = params.cwd ?? ctx.cwd;
      const timeoutMs = params.timeout ?? 60000;
      const sessionId = randomBytes(8).toString("hex");
      const sessionDir = join("/tmp", `pi-sessions`, `wezterm-${sessionId}`);

      const weztermOk = await isWeztermAvailable();
      if (!weztermOk) {
        return {
          content: [{ type: "text", text: "wezterm not found. Install wezterm to use wezterm_spawn." }],
          isError: true,
          details: {} as Record<string, unknown>,
        };
      }

      try {
        // Create session directory
        await mkdir(sessionDir, { recursive: true, mode: 0o700 });

        // Spawn pi in a new Wezterm pane
        // The pane will show the pi TUI and user can continue after task completes
        const taskEscaped = params.task.replace(/"/g, '\\"');
        
        // Spawn wezterm with pi running the task
        // Use --continue to pass the task and --cwd to set working directory
        const paneId = `pi-agent-${sessionId}`;
        
        // Build the pi command
        const piCmd = `pi --session-dir "${sessionDir}" --continue "${taskEscaped}"`;
        
        // Spawn in a new pane in the current window (or create new window)
        // --cwd sets the working directory for the new pane
        await new Promise<void>((resolve, reject) => {
          execFile(
            "wezterm",
            [
              "cli",
              "split-pane",
              "--cwd",
              targetCwd,
              "--",
              "bash",
              "-c",
              `echo "Session: ${sessionId}" && echo "Session dir: ${sessionDir}" && echo "" && ${piCmd} && echo "" && echo "Session saved. Continue with:" && echo "  pi --session-dir ${sessionDir} --continue \\"<task\\"" && sleep 5`,
            ],
            (err) => {
              if (err) reject(new Error(`wezterm cli split-pane failed: ${err.message}`));
              else resolve();
            },
          );
        });

        // Give pi time to start and show output
        await new Promise((r) => setTimeout(r, 2000));

        // Send initial progress
        onUpdate?.({
          content: [{
            type: "text",
            text: `[wezterm_spawn] Started pi session in new pane\nSession ID: ${sessionId}\nSession dir: ${sessionDir}\n\nYou can continue this session with:\n  pi --session-dir ${sessionDir} --continue "<task>"\n`,
          }],
          details: { sessionId, sessionDir } as Record<string, unknown>,
        });

        // Wait a bit for pi to process and stream any output
        let output = "";
        const startTime = Date.now();
        
        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            // Check if we've timed out
            if (Date.now() - startTime > timeoutMs) {
              clearInterval(checkInterval);
              resolve();
              return;
            }
            
            // For now, we just wait for the timeout
            // The actual pi output is visible in the Wezterm pane
            // This is a limitation of the wezterm CLI approach
          }, 1000);
          
          // Initial delay before returning
          setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
          }, 3000);
        });

        return {
          content: [{
            type: "text",
            text: `Session started in Wezterm pane.\n\nSession ID: ${sessionId}\nSession dir: ${sessionDir}\n\nContinue with:\n  pi --session-dir ${sessionDir} --continue "<task>"\n`,
          }],
          details: {
            sessionId,
            sessionDir,
            message: "Session started in Wezterm pane. User can continue via pi --session-dir.",
          } as Record<string, unknown>,
        };
      } catch (err) {
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
