#!/usr/bin/env node
/**
 * Tmux Agent - Simple socket client for pi subprocess communication
 */

import net from "node:net";
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";

const DEBUG_DIR = process.env.SUBAGENT_DEBUG_LOG_DIR || "/tmp/pi-subagentura-logs";

function debugLog(...args) {
  const msg = "[" + new Date().toISOString() + "] " + args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ");
  console.error("[debug] " + msg);
  try {
    if (!existsSync(DEBUG_DIR)) {
      mkdirSync(DEBUG_DIR, { recursive: true, mode: 0o700 });
    }
    const logFile = DEBUG_DIR + "/tmux-agent-" + process.pid + ".log";
    writeFileSync(logFile, msg + "\n", { flag: "a" });
  } catch (e) {
    // ignore
  }
}

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

debugLog("Starting", args.socket, args.cwd, args.task.substring(0, 20));

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

debugLog("Connecting to", args.socket);
client = net.createConnection(args.socket, () => {
  debugLog("Connected");
  send({ method: "progress", params: { output: "[ready]" }, id: null });
});

client.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      debugLog("Received", msg.method);
      if (msg.method === "task" && msg.params?.task) {
        currentId = msg.id;
        debugLog("Task:", typeof msg.params.task, String(msg.params.task).substring(0, 30));
        runTask(msg.params.task);
      } else if (msg.method === "abort") {
        aborted = true;
        if (piProcess) piProcess.kill("SIGTERM");
        sendError("Task aborted");
        process.exit(0);
      } else if (msg.method === "ping") {
        send({ method: "pong", id: msg.id });
      }
    } catch (e) {
      debugLog("Parse error", e.message);
    }
  }
});

client.on("close", () => {
  debugLog("Parent disconnected");
  if (piProcess) piProcess.kill("SIGTERM");
  process.exit(0);
});

client.on("error", (err) => {
  debugLog("Socket error", err.message);
  process.exit(1);
});

function runTask(task) {
  debugLog("Running task:", task);
  const piArgs = ["-p", task];
  debugLog("Spawning pi", piArgs.join(" "));

  piProcess = spawn("pi", piArgs, {
    cwd: args.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let lastProgress = 0;

  piProcess.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (output.length - lastProgress > 500) {
      sendProgress(output);
      lastProgress = output.length;
    }
  });

  piProcess.stderr.on("data", (chunk) => {
    debugLog("pi stderr", chunk.toString().slice(0, 100));
  });

  piProcess.on("close", (code) => {
    debugLog("pi done", code);
    if (aborted) return;
    if (code === 0) {
      sendResult(output);
    } else {
      sendError("pi exited with code " + code);
    }
    process.exit(0);
  });

  piProcess.on("error", (err) => {
    debugLog("Spawn error", err.message);
    sendError("Failed to spawn pi: " + err.message);
    process.exit(1);
  });
}

process.on("SIGTERM", () => {
  debugLog("SIGTERM");
  if (piProcess) piProcess.kill("SIGTERM");
  process.exit(0);
});

debugLog("Ready");
