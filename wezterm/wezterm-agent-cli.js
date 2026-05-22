#!/usr/bin/env node
/**
 * Wezterm Agent - Spawns pi session in new Wezterm pane
 * 
 * This script is spawned by wezterm_spawn tool. It:
 * 1. Creates a session directory for pi
 * 2. Spawns pi with the task via --continue
 * 3. pi runs in the Wezterm pane, user can continue after
 */

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
  if (val === "--session-dir" && idx + 1 < arr.length) acc.sessionDir = arr[++idx];
  else if (val === "--cwd" && idx + 1 < arr.length) acc.cwd = arr[++idx];
  else if (val === "--task") acc.task = arr.slice(idx + 1).join(" ");
  return acc;
}, { sessionDir: "", cwd: process.cwd(), task: "" });

if (!args.sessionDir) {
  console.error("Usage: wezterm-agent-cli.js --session-dir <path> --cwd <dir> --task <task>");
  process.exit(1);
}

debugLog("Starting wezterm-agent-cli", { sessionDir: args.sessionDir, cwd: args.cwd, taskLength: args.task.length });

// Session directory is created by wezterm-spawn.ts
// This script just logs and the actual pi spawn happens via wezterm CLI
debugLog("Wezterm will spawn pi with session-dir:", args.sessionDir);
console.error("\n╔══════════════════════════════════════════════════════════════╗");
console.error("║  Pi session starting in Wezterm pane                        ║");
console.error("║  Session dir: " + (args.sessionDir.slice(0, 45) || "").padEnd(46) + "║");
console.error("╚══════════════════════════════════════════════════════════════╝\n");
