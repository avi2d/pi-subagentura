#!/usr/bin/env node
/**
 * Tmux Agent Helper - Runs in tmux window, handles socket communication
 *
 * This script is spawned by tmux_spawn tool. It:
 * 1. Connects to the parent's Unix socket
 * 2. Waits for task message
 * 3. Spawns pi with the task
 * 4. Sends progress/result back via socket
 *
 * Usage:
 *   pi-tmux-helper --socket <path> [--cwd <dir>]
 */

import { connect as netConnect, type Socket as NetSocket } from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ── CLI Parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  socket: string;
  cwd: string;
  task?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { socket: "", cwd: process.cwd() };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--socket" && i + 1 < args.length) {
      result.socket = args[++i];
    } else if (args[i] === "--cwd" && i + 1 < args.length) {
      result.cwd = args[++i];
    } else if (args[i] === "--task" && i + 1 < args.length) {
      // Task can have spaces, so grab rest of line
      result.task = args.slice(i + 1).join(" ");
      break;
    }
  }

  if (!result.socket) {
    console.error("pi-tmux-helper: --socket <path> required");
    process.exit(1);
  }

  return result;
}

// ── Socket Client ────────────────────────────────────────────────────────────

interface RpcMessage {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: number | string | null;
}

class SocketClient {
  private socket: NetSocket | null = null;
  private connected = false;
  private messageQueue: string[] = [];
  private onDisconnect: (() => void) | null = null;

  constructor(private socketPath: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Socket connection timeout (10s)"));
      }, 10000);

      this.socket = netConnect(this.socketPath, () => {
        clearTimeout(timeout);
        this.connected = true;
        // Send queued messages
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift()!;
          this.socket!.write(msg + "\n");
        }
        resolve();
      });

      this.socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.socket.on("close", () => {
        this.connected = false;
        this.onDisconnect?.();
      });
    });
  }

  send(msg: RpcMessage): void {
    const line = JSON.stringify(msg) + "\n";
    if (this.connected && this.socket) {
      this.socket.write(line);
    } else {
      this.messageQueue.push(line);
    }
  }

  sendProgress(output: string, turn: number = 0): void {
    this.send({
      jsonrpc: "2.0",
      method: "progress",
      params: { output, turn },
      id: null, // notification
    });
  }

  sendResult(output: string, usage: Record<string, unknown> = {}): void {
    this.send({
      jsonrpc: "2.0",
      method: "result",
      params: { output, usage },
      id: 1,
    });
  }

  sendError(message: string): void {
    this.send({
      jsonrpc: "2.0",
      method: "error",
      params: { message },
      id: 1,
    });
  }

  onMessage(handler: (msg: RpcMessage) => void): void {
    let buffer = "";
    this.socket?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line) as RpcMessage;
            handler(msg);
          } catch {
            // Ignore parse errors
          }
        }
      }
    });
  }

  onDisconnected(handler: () => void): void {
    this.onDisconnect = handler;
  }

  close(): void {
    this.socket?.end();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const client = new SocketClient(args.socket);

  let currentTask: string | null = null;
  let piProcess: ReturnType<typeof spawn> | null = null;
  let aborted = false;

  console.error(`pi-tmux-helper: connecting to ${args.socket}`);

  try {
    // Connect to parent socket
    await client.connect();
    console.error("pi-tmux-helper: connected");

    // Signal ready (parent waits for .ready file separately)
    // We could write a ready file here if needed

    // Handle incoming messages
    client.onMessage((msg) => {
      if (msg.method === "task" && msg.params?.task) {
        currentTask = msg.params.task as string;
        runTask(currentTask);
      } else if (msg.method === "abort") {
        aborted = true;
        if (piProcess) {
          piProcess.kill("SIGTERM");
          setTimeout(() => {
            if (piProcess) {
              piProcess.kill("SIGKILL");
            }
          }, 5000);
        }
        client.sendError("Task aborted by parent");
        process.exit(0);
      } else if (msg.method === "ping") {
        client.send({ jsonrpc: "2.0", method: "pong", id: msg.id ?? null });
      }
    });

    client.onDisconnected(() => {
      console.error("pi-tmux-helper: parent disconnected");
      if (piProcess) {
        piProcess.kill("SIGTERM");
      }
      process.exit(0);
    });

  } catch (err) {
    console.error(`pi-tmux-helper: failed to connect: ${err}`);
    process.exit(1);
  }

  function runTask(task: string) {
    console.error(`pi-tmux-helper: running task: ${task.slice(0, 50)}...`);

    // Spawn pi with the task
    // Pass task via stdin to avoid shell escaping issues
    piProcess = spawn("pi", ["--no-input", task], {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_NO_INTERACT: "1" },
    });

    let output = "";
    let turnCount = 0;

    piProcess.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      // Send progress (could be smarter about turn detection)
      if (output.length > 100) {
        client.sendProgress(output.slice(-500), turnCount);
      }
    });

    piProcess.stderr?.on("data", (chunk: Buffer) => {
      // Could send to parent as progress too
      console.error(`pi: ${chunk.toString()}`);
    });

    piProcess.on("close", (code) => {
      if (aborted) return;
      if (code === 0) {
        client.sendResult(output);
      } else {
        client.sendError(`pi exited with code ${code}: ${output}`);
      }
      process.exit(0);
    });

    piProcess.on("error", (err) => {
      client.sendError(`Failed to spawn pi: ${err.message}`);
      process.exit(1);
    });
  }

  // Keep process alive
  process.stdin.resume();
}

main().catch((err) => {
  console.error(`pi-tmux-helper: fatal error: ${err}`);
  process.exit(1);
});