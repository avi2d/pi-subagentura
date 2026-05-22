#!/usr/bin/env node
/**
 * Wezterm Agent CLI - Runs in Wezterm pane, bridges socket ↔ pi session
 *
 * This script:
 * 1. Connects to parent socket
 * 2. Creates session directory
 * 3. Spawns pi with the task via --continue
 * 4. Streams output back via socket
 * 5. Sends result when done
 */

import { connect as netConnect, type Socket as NetSocket } from "node:net";
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
    const logFile = DEBUG_DIR + "/wezterm-agent-" + process.pid + ".log";
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
  console.error("Usage: wezterm-agent-cli.js --socket <path> --cwd <dir> --task <task>");
  process.exit(1);
}

debugLog("Starting wezterm-agent-cli", { socket: args.socket, cwd: args.cwd, taskLength: args.task.length });

let client: NetSocket | null = null;
let piProcess: ReturnType<typeof spawn> | null = null;
let output = "";
let done = false;

function send(msg: Record<string, unknown>) {
  if (client && client.writable) {
    client.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }
}

function sendProgress(output: string, turn = 0) {
  send({ method: "progress", params: { output: output.slice(-500), turn }, id: null });
}

function sendResult(output: string, usage: Record<string, unknown> = {}) {
  send({ method: "result", params: { output, usage }, id: 1 });
}

function sendError(message: string) {
  send({ method: "error", params: { message }, id: 1 });
}

// Session directory from socket path
const sessionDir = args.socket + "_sessions";
const sessionId = Date.now() + "_" + Math.random().toString(36).slice(2, 8);

// Create session directory
try {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  debugLog("Created session dir:", sessionDir);
} catch (e: any) {
  debugLog("Failed to create session dir:", e.message);
}

// Connect to parent socket
debugLog("Connecting to socket", args.socket);
client = netConnect(args.socket, () => {
  debugLog("Connected to socket");
  sendProgress("[ready]");
  runPiSession();
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
        if (piProcess) {
          piProcess.kill("SIGTERM");
        }
        sendError("Task aborted");
        process.exit(0);
      }
    } catch (e) {
      // ignore parse errors
    }
  }
});

client.on("close", () => {
  debugLog("Parent disconnected");
});

client.on("error", (err) => {
  debugLog("Socket error:", err.message);
});

function runPiSession() {
  debugLog("Spawning pi with task in session");
  
  console.error("\n╔══════════════════════════════════════════════════════════════╗");
  console.error("║  Pi Session: " + sessionId.slice(0, 20).padEnd(44) + "║");
  console.error("║  Session dir: " + sessionDir.slice(0, 46).padEnd(46) + "║");
  console.error("╠══════════════════════════════════════════════════════════════╣");
  console.error("║  User can continue with:                                    ║");
  console.error("║    pi --session-dir " + sessionDir.slice(0, 36).padEnd(46) + "║");
  console.error("╚══════════════════════════════════════════════════════════════╝\n");
  
  // Spawn pi with session dir and continue
  piProcess = spawn("pi", ["--session-dir", sessionDir, "--continue", args.task], {
    cwd: args.cwd,
    stdio: ["inherit", "pipe", "pipe"],
  });
  
  let lastProgress = 0;
  let turnCount = 0;
  
  piProcess.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    
    // Send progress every 500 chars
    if (output.length - lastProgress > 500) {
      sendProgress(output, turnCount);
      lastProgress = output.length;
    }
    
    // Write to terminal so user sees it
    process.stdout.write(text);
  });
  
  piProcess.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    // Check for turn completion to track turns
    if (text.includes("Done after")) {
      debugLog("Pi completed turn");
      turnCount++;
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
    console.error("║  Continue with: pi --session-dir " + sessionDir.slice(0, 29) + " --continue" + "   ║");
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
