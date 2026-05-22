#!/usr/bin/env node
/**
 * Tmux Agent - Simple socket client for pi subprocess communication
 *
 * Usage:
 *   node tmux-agent-cli.js --socket <path> [--cwd <dir>] --task "<task>"
 *
 * This runs in a tmux window and:
 * 1. Connects to the Unix socket (parent-side)
 * 2. Waits for task message
 * 3. Spawns `pi "<task>"` as child process
 * 4. Streams output via socket messages
 */

import net from "node:net";
import { spawn } from "node:child_process";

// Simple argument parsing
const args = process.argv.slice(2).reduce((acc, val, idx, arr) => {
  if (val === "--socket" && idx + 1 < arr.length) acc.socket = arr[++idx];
  else if (val === "--cwd" && idx + 1 < arr.length) acc.cwd = arr[++idx];
  else if (val === "--task") acc.task = arr.slice(idx + 1).join(" ");
  return acc;
}, { socket: "", cwd: process.cwd(), task: "" });

if (!args.socket) {
  console.error("Usage: node tmux-agent.js --socket <path> [--cwd <dir>] --task \"<task>\"");
  process.exit(1);
}

let client = null;
let piProcess = null;
let output = "";
let currentId = null;
let aborted = false;

function send(msg) {
  if (client) {
    client.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }
}

function sendProgress(text, turn = 0) {
  send({ method: "progress", params: { output: text.slice(-500), turn }, id: null });
}

function sendResult(text) {
  send({ method: "result", params: { output: text, usage: {} }, id: currentId });
}

function sendError(message) {
  send({ method: "error", params: { message }, id: currentId });
}

// Connect to parent socket
console.error(`[tmux-agent] Connecting to ${args.socket}`);
client = net.createConnection(args.socket, () => {
  console.error("[tmux-agent] Connected");
  send({ method: "progress", params: { output: "[ready]" }, id: null });
});

client.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === "task" && msg.params?.task) {
        currentId = msg.id;
        const task = msg.params.task;
        console.error(`[tmux-agent] Got task: ${task.slice(0, 50)}...`);
        runTask(task);
      } else if (msg.method === "abort") {
        console.error("[tmux-agent] Abort received");
        aborted = true;
        if (piProcess) {
          piProcess.kill("SIGTERM");
          setTimeout(() => piProcess && piProcess.kill("SIGKILL"), 3000);
        }
        sendError("Task aborted");
        process.exit(0);
      } else if (msg.method === "ping") {
        send({ method: "pong", id: msg.id });
      }
    } catch (e) {
      console.error("[tmux-agent] Parse error:", e.message);
    }
  }
});

client.on("close", () => {
  console.error("[tmux-agent] Parent disconnected");
  if (piProcess) piProcess.kill("SIGTERM");
  process.exit(0);
});

client.on("error", (err) => {
  console.error("[tmux-agent] Socket error:", err.message);
  process.exit(1);
});

function runTask(task) {
  const piArgs = ["--no-input", task];
  console.error(`[tmux-agent] Spawning: pi ${piArgs.join(" ")}`);

  piProcess = spawn("pi", piArgs, {
    cwd: args.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let turnCount = 0;
  let lastProgress = 0;

  piProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    // Send progress every 500 chars
    if (output.length - lastProgress > 500) {
      sendProgress(output, turnCount);
      lastProgress = output.length;
    }
  });

  piProcess.stderr.on("data", (chunk) => {
    // Could pipe to parent, but tmux window already shows it
    console.error("[pi] " + chunk.toString().slice(0, 200));
  });

  piProcess.on("close", (code) => {
    if (aborted) return;
    if (code === 0) {
      sendResult(output);
    } else {
      sendError(`pi exited with code ${code}`);
    }
    process.exit(0);
  });

  piProcess.on("error", (err) => {
    sendError(`Failed to spawn pi: ${err.message}`);
    process.exit(1);
  });
}

// Keep alive for signals
process.on("SIGTERM", () => {
  if (piProcess) piProcess.kill("SIGTERM");
  process.exit(0);
});
