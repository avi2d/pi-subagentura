#!/usr/bin/env node
/**
 * Tmux Agent - Spawns pi session in tmux window with session persistence
 * 
 * Usage:
 *   node tmux-agent-cli.js --socket <path> --cwd <dir> --task "<task>"
 *
 * Architecture:
 * 1. Creates a session directory
 * 2. Runs pi with the task via --continue
 * 3. pi processes task and saves session
 * 4. User can continue session with: pi --session-dir <sessionDir> --continue "next task"
 * 5. Main agent gets result via socket (if still connected)
 */

import net from "node:net";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

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

// Parse args
const args = process.argv.slice(2).reduce((acc, val, idx, arr) => {
  if (val === "--socket" && idx + 1 < arr.length) acc.socket = arr[++idx];
  else if (val === "--cwd" && idx + 1 < arr.length) acc.cwd = arr[++idx];
  else if (val === "--task") acc.task = arr.slice(idx + 1).join(" ");
  return acc;
}, { socket: "", cwd: process.cwd(), task: "" });

if (!args.socket) {
  console.error("Usage: node tmux-agent-cli.js --socket <path> --cwd <dir> --task <task>");
  process.exit(1);
}

// Generate session directory path from socket path
const sessionDir = args.socket + "_sessions";
const sessionId = Date.now() + "_" + Math.random().toString(36).slice(2, 8);

debugLog("Starting tmux-agent-cli", { socket: args.socket, cwd: args.cwd, sessionDir, taskLength: args.task.length });

let client = null;
let output = "";
let done = false;

function send(msg) {
  if (client && client.writable) {
    client.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }
}

function sendProgress(output) {
  send({ method: "progress", params: { output: output.slice(-500) } });
}

function sendResult(output, usage = {}) {
  send({ method: "result", params: { output, usage } });
}

function sendError(message) {
  send({ method: "error", params: { message } });
}

// Connect to parent socket
debugLog("Connecting to socket", args.socket);
client = net.createConnection(args.socket, () => {
  debugLog("Connected to socket");
  send({ method: "progress", params: { output: "[ready]" } });
  
  // Create session directory and spawn pi
  initSession();
});

client.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      debugLog("Received from parent:", msg.method || msg.type);
      
      if (msg.method === "abort") {
        debugLog("Abort received");
        sendError("Task aborted");
      }
    } catch (e) {
      debugLog("Parse error:", e.message);
    }
  }
});

client.on("close", () => {
  debugLog("Parent disconnected");
});

client.on("error", (err) => {
  debugLog("Socket error:", err.message);
});

function initSession() {
  // Create session directory
  try {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    debugLog("Created session dir:", sessionDir);
  } catch (e) {
    debugLog("Failed to create session dir:", e.message);
    sendError("Failed to create session: " + e.message);
    return;
  }
  
  // Write session info
  const sessionInfo = {
    sessionId,
    sessionDir,
    task: args.task,
    startedAt: new Date().toISOString()
  };
  
  try {
    writeFileSync(sessionDir + "/session_info.json", JSON.stringify(sessionInfo, null, 2));
    debugLog("Wrote session info");
  } catch (e) {
    debugLog("Failed to write session info:", e.message);
  }
  
  // Send session info to parent
  send({ method: "session", params: { sessionId, sessionDir } });
  
  // Spawn pi with --continue to process the task
  runPiSession();
}

function runPiSession() {
  debugLog("Spawning pi --session-dir", sessionDir, "--continue with task");
  
  console.error("\n╔══════════════════════════════════════════════════════════════╗");
  console.error("║  Pi Session: " + sessionId.slice(0, 20).padEnd(44) + "║");
  console.error("║  Session dir: " + sessionDir.slice(0, 50).padEnd(44) + "║");
  console.error("╠══════════════════════════════════════════════════════════════╣");
  console.error("║  User can continue with:                                    ║");
  console.error("║    pi --session-dir " + sessionDir.slice(0, 40).padEnd(46) + "║");
  console.error("║    pi --session-dir " + sessionDir.slice(0, 40) + " --continue \"task\"" + "║");
  console.error("╚══════════════════════════════════════════════════════════════╝\n");
  
  // Spawn pi with --continue to process the task
  const piProcess = spawn("pi", ["--session-dir", sessionDir, "--continue", args.task], {
    cwd: args.cwd,
    stdio: ["inherit", "pipe", "pipe"]
  });
  
  let lastProgress = 0;
  
  piProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    
    // Send progress every 500 chars
    if (output.length - lastProgress > 500) {
      sendProgress(output);
      lastProgress = output.length;
    }
    
    // Write to terminal so user sees it
    process.stdout.write(text);
  });
  
  piProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    // Check for completion notification
    if (text.includes("Done after")) {
      debugLog("Pi completed task");
    }
    process.stderr.write(text);
  });
  
  piProcess.on("close", (code) => {
    debugLog("pi exited with code", code);
    
    if (done) return;
    done = true;
    
    if (code === 0) {
      sendResult(output);
    } else {
      sendError("pi exited with code " + code);
    }
    
    console.error("\n╔══════════════════════════════════════════════════════════════╗");
    console.error("║  Task completed. Session saved.                              ║");
    console.error("║  Continue with: pi --session-dir " + sessionDir.slice(0, 33) + " --continue" + "   ║");
    console.error("╚══════════════════════════════════════════════════════════════╝\n");
  });
  
  piProcess.on("error", (err) => {
    debugLog("pi spawn error:", err.message);
    sendError("Failed to spawn pi: " + err.message);
  });
}

process.on("SIGTERM", () => {
  debugLog("SIGTERM received");
  process.exit(0);
});
