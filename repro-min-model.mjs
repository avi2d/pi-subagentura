#!/usr/bin/env node
// Reproduce the EXACT pi-ai crash with the real MiniMax-M3 model definition
// from ~/.pi/agent/models.json — which is missing `input`, `reasoning`,
// `maxTokens`, `cost`, and `baseUrl` fields.

import { readFileSync } from "node:fs";
import { streamSimpleAnthropic } from "@mariozechner/pi-ai/anthropic";
// transform-messages is internal — import directly from dist
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { transformMessages } = require("./node_modules/@mariozechner/pi-ai/dist/providers/transform-messages.js");

// Real model from /Users/applesucks/.pi/agent/models.json
const realModel = {
  id: "MiniMax-M3",
  name: "MiniMax-M3",
  contextWindow: 1048576,
  supportsImages: true,
  // NO `input`, `reasoning`, `maxTokens`, `cost`, `baseUrl` fields
};

const messages = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

console.log("--- 1. transformMessages with minimal model (real shape) ---");
try {
  const r = transformMessages(messages, realModel, (id) => id);
  console.log(`OK: returned ${r.length} messages`);
} catch (e) {
  console.log(`THREW: ${e.message}`);
  console.log(`\nstack:\n${e.stack.split("\n").slice(0, 8).join("\n")}`);
}

console.log("\n--- 2. streamSimpleAnthropic with minimal model ---");
try {
  const s = streamSimpleAnthropic(
    realModel,
    { systemPrompt: "", messages, tools: [] },
    { apiKey: "fake-key" },
  );
  // Get the first event or error
  const timer = setTimeout(() => {
    console.log("(no immediate event — request built, awaiting HTTP)");
    process.exit(0);
  }, 300);
  for await (const ev of s) {
    clearTimeout(timer);
    console.log(`event: type=${ev.type}, reason=${ev.reason}`);
    if (ev.error) console.log(`  errorMessage: ${ev.error.errorMessage}`);
    if (ev.error?.errorMessage?.includes("map")) {
      console.log("\n=== REPRODUCED THE EXACT BUG ===");
      console.log("message: Cannot read properties of undefined (reading 'map')");
    }
    break;
  }
} catch (e) {
  console.log(`THREW: ${e.message}`);
  console.log(`\nstack:\n${e.stack.split("\n").slice(0, 8).join("\n")}`);
}

console.log("\n--- 3. Compare with fully-populated model ---");
const fullModel = {
  ...realModel,
  provider: "minimax",
  api: "anthropic-messages",
  maxTokens: 8192,
  baseUrl: "https://api.minimaxi.io/anthropic",
  input: ["text"],
  compat: {},
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
try {
  const r = transformMessages(messages, fullModel, (id) => id);
  console.log(`OK with full model: ${r.length} messages`);
} catch (e) {
  console.log(`THREW with full model: ${e.message}`);
}
