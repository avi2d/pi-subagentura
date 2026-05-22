#!/usr/bin/env node
/**
 * Tmux Agent - Socket bridge to pi RPC mode
 * 
 * This runs in a tmux window and:
 * 1. Connects to the Unix socket (parent-side)
 * 2. Spawns `pi --mode rpc` as a child process
 * 3. Bridges socket <-> pi stdin/stdout for persistent sessions
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

// Parse args
const args = process.argv.slice(2).reduce((acc, val, idx, arr) => {
  if (val === "--socket" && idx + 1 < arr.length) acc.socket = arr[++idx];
  else if (val === "--cwd" && idx + 1 < arr.length) acc.cwd = arr[++idx];
  else if (val === "--task") acc.task = arr.slice(idx + 1).join(" ");
  return acc;
}, { socket: "", cwd: process.cwd(), task: "" });

if (!args.socket) {
  console.error("Usage: node tmux-agent-cli.js --socket <path> [--cwd <dir>] --task <task>");
  process.exit(1);
}

debugLog("Starting tmux-agent-cli", { socket: args.socket, cwd: args.cwd });

let client = null;
let piProcess = null;
let output = "";
let sessionActive = false;

function send(msg) {
  if (client && client.writable) {
    client.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }
}

function sendProgress(output, turn = 0) {
  send({ method: "progress", params: { output: output.slice(-500), turn } });
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
  
  // Now spawn pi in RPC mode
  spawnPi();
});

client.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      debugLog("Received from parent:", msg.method || msg.type, msg.id || "");
      
      if (msg.method === "task" || msg.type === "prompt") {
        // Forward to pi stdin as RPC prompt
        if (piProcess && piProcess.stdin) {
          const task = msg.params?.task || msg.message;
          const id = String(msg.id || Date.now());
          debugLog("Sending to pi:", task?.substring(0, 50));
          piProcess.stdin.write(JSON.stringify({ 
            type: "prompt", 
            id: id,
            message: task 
          }) + "\n");
        }
      } else if (msg.method === "abort" || msg.type === "abort") {
        debugLog("Abort received");
        if (piProcess) {
          piProcess.stdin.write(JSON.stringify({ type: "abort", id: "abort" }) + "\n");
        }
      } else if (msg.method === "ping") {
        send({ method: "pong", id: msg.id });
      }
    } catch (e) {
      debugLog("Parse error:", e.message);
    }
  }
});

client.on("close", () => {
  debugLog("Parent disconnected");
  if (piProcess) {
    piProcess.kill("SIGTERM");
  }
  process.exit(0);
});

client.on("error", (err) => {
  debugLog("Socket error:", err.message);
  process.exit(1);
});

function spawnPi() {
  debugLog("Spawning pi --mode rpc in", args.cwd);
  
  piProcess = spawn("pi", ["--mode", "rpc"], {
    cwd: args.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_OFFLINE: "0" }
  });

  // Wait a bit for pi to initialize before we start responding to events
  setTimeout(() => {
    debugLog("pi initialization delay passed");
  }, 1000);

  piProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    // Parse RPC events from pi
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handlePiEvent(event);
      } catch {
        // Not JSON, might be regular stderr
        debugLog("pi stderr:", text.slice(0, 200));
      }
    }
  });

  piProcess.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handlePiEvent(event);
      } catch (e) {
        debugLog("stdout parse error:", e.message);
      }
    }
  });

  piProcess.on("close", (code) => {
    debugLog("pi exited with code", code);
    send({ method: "closed", params: { code } });
    process.exit(0);
  });

  piProcess.on("error", (err) => {
    debugLog("pi spawn error:", err.message);
    sendError("Failed to spawn pi: " + err.message);
    process.exit(1);
  });
}

function handlePiEvent(event) {
  debugLog("pi event:", event.type || event.method, event.id || "");
  
  // Handle extension_ui_request - send back a dummy response so pi doesn't hang
  if (event.type === "extension_ui_request") {
    debugLog("Extension UI request:", event.method, event.id);
    // Send a response to unblock pi
    try {
      if (piProcess && piProcess.stdin) {
        const response = JSON.stringify({
          type: "extension_ui_response",
          id: event.id,
          cancelled: false
        }) + "\n";
        debugLog("Writing response to pi stdin, length:", response.length);
        const written = piProcess.stdin.write(response);
        debugLog("Write result:", written);
        // Also try flushing
        if (piProcess.stdin.flush) {
          piProcess.stdin.flush();
        }
      } else {
        debugLog("piProcess or stdin is null");
      }
    } catch (e) {
      debugLog("Error writing to stdin:", e.message);
    }
    return;
  }
  
  // Forward relevant events to parent
  if (event.type === "response" && event.success) {
    // Extract final output from agent_end or messages
    const resultText = extractResult(event);
    if (resultText !== null) {
      sendResult(resultText);
    }
  } else if (event.type === "response" && !event.success) {
    sendError(event.error || "Unknown error");
  } else if (event.type === "agent_end") {
    // Get last assistant message as result
    const messages = event.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        const content = messages[i].content;
        if (Array.isArray(content)) {
          const text = content.filter(c => c.type === "text").map(c => c.text).join("");
          if (text) {
            sendResult(text);
            return;
          }
        }
        break;
      }
    }
  } else if (event.type === "extension_ui_request") {
    // Acknowledge extension UI requests
    debugLog("Extension UI:", event.method);
  } else if (event.type === "message_update") {
    // Streaming update - send progress
    const content = event.message?.content;
    if (Array.isArray(content)) {
      const text = content.filter(c => c.type === "text").map(c => c.text).join("");
      if (text) {
        sendProgress(text, event.message.role === "assistant" ? 1 : 0);
      }
    }
  }
}

function extractResult(event) {
  // Try to get result from various event formats
  if (event.data?.output) return event.data.output;
  if (event.messages) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i];
      if (msg.role === "assistant") {
        const content = msg.content;
        if (Array.isArray(content)) {
          const text = content.filter(c => c.type === "text").map(c => c.text).join("");
          if (text) return text;
        }
      }
    }
  }
  return null;
}

process.on("SIGTERM", () => {
  debugLog("SIGTERM received");
  if (piProcess) piProcess.kill("SIGTERM");
  process.exit(0);
});

debugLog("Ready, waiting for connection...");
