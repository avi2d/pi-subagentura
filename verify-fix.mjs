#!/usr/bin/env node
// Verify the fix: load models.json the same way the agent does, then run
// transformMessages with the actual model definition.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { transformMessages } = require("./node_modules/@mariozechner/pi-ai/dist/providers/transform-messages.js");
const { streamSimpleAnthropic } = require("./node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js");

// Read models.json the same way pi does
const config = JSON.parse(readFileSync("/Users/applesucks/.pi/agent/models.json", "utf8"));
const providerCfg = config.providers.minimax;
const modelDef = providerCfg.models.find((m) => m.id === "MiniMax-M3");

// Replicate pi-coding-agent's model-registry (model-registry.js:680-698)
const model = {
  id: modelDef.id,
  name: modelDef.name,
  api: modelDef.api || providerCfg.api,
  provider: "minimax",
  baseUrl: modelDef.baseUrl ?? providerCfg.baseUrl,
  reasoning: modelDef.reasoning,
  thinkingLevelMap: modelDef.thinkingLevelMap,
  input: modelDef.input,
  cost: modelDef.cost,
  contextWindow: modelDef.contextWindow,
  maxTokens: modelDef.maxTokens,
  headers: undefined,
  compat: modelDef.compat,
};

console.log("model.input:", model.input);
console.log("model.reasoning:", model.reasoning);
console.log("model.maxTokens:", model.maxTokens);
console.log("model.cost:", JSON.stringify(model.cost));

const messages = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

console.log("\n--- transformMessages ---");
try {
  const r = transformMessages(messages, model, (id) => id);
  console.log(`OK: ${r.length} messages`);
} catch (e) {
  console.log(`THREW: ${e.message}`);
  process.exit(1);
}

console.log("\n--- streamSimpleAnthropic ---");
try {
  const s = streamSimpleAnthropic(model, { systemPrompt: "", messages, tools: [] }, { apiKey: "fake" });
  const timer = setTimeout(() => {
    console.log("(no immediate error — request built successfully)");
    console.log("\n✓ FIX VERIFIED: pi-ai no longer crashes on the minimal model");
    process.exit(0);
  }, 500);
  for await (const ev of s) {
    clearTimeout(timer);
    console.log(`event: type=${ev.type}, reason=${ev.reason}`);
    if (ev.error) console.log(`  errorMessage: ${ev.error.errorMessage}`);
    break;
  }
} catch (e) {
  console.log(`THREW: ${e.message}`);
  process.exit(1);
}
