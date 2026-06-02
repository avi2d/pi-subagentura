#!/usr/bin/env node
// Replay the map.jsonl session's message history through pi-ai's exact
// request-build path, capture the full stack trace of the "Cannot read
// properties of undefined (reading 'map')" error, and identify the bad
// message.

import fs from "node:fs";
import { readFileSync } from "node:fs";
import { streamSimpleAnthropic } from "@mariozechner/pi-ai/anthropic";

// 1. Load map.jsonl and reconstruct the message history
//    by walking from the leaf back to the root via parentId.
const lines = readFileSync("map.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l, i) => ({ i: i + 1, ...JSON.parse(l) }));

const byId = new Map();
for (const e of lines) byId.set(e.id, e);

// Find the leaf — the user message that triggered the error.
// The errored assistant entry (line 34) has parentId pointing to it.
const erroredAssistant = lines.find(
  (e) =>
    e.type === "message" &&
    e.message?.role === "assistant" &&
    e.message?.errorMessage,
);
if (!erroredAssistant) {
  console.log("No errored assistant message found in map.jsonl");
  process.exit(1);
}

const leafId = erroredAssistant.parentId;
console.log(`errored assistant: id=${erroredAssistant.id}`);
console.log(`leaf (trigger): id=${leafId}`);
console.log(`errorMessage: ${erroredAssistant.message.errorMessage}`);

// Walk back to root, then reverse to get chronological order
const chain = [];
let cur = byId.get(leafId);
while (cur) {
  chain.push(cur);
  if (!cur.parentId) break;
  cur = byId.get(cur.parentId);
}
chain.reverse();

// 2. Filter to LLM-compatible messages and extract model
const modelChange = lines.find((e) => e.type === "model_change");
const model = {
  id: modelChange.modelId,
  provider: modelChange.provider,
  api: "anthropic-messages",
  maxTokens: 8192,
  baseUrl: "https://api.minimaxi.io/anthropic",
  input: ["text"],
  compat: {},
};

const messages = [];
for (const e of chain) {
  if (e.type !== "message") continue;
  const m = e.message;
  if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
    messages.push(m);
  }
}

console.log(`\nreconstructed ${messages.length} messages from history:`);
for (let i = 0; i < messages.length; i++) {
  const m = messages[i];
  const c = m.content;
  const shape = Array.isArray(c)
    ? `array(${c.length})[${c.map((b) => b?.type ?? "?").join(",")}]`
    : typeof c;
  const preview = Array.isArray(c) && c[0]?.text
    ? c[0].text.slice(0, 40).replace(/\n/g, "\\n")
    : "";
  console.log(`  [${i}] role=${m.role.padEnd(11)} content=${shape.padEnd(40)} ${preview ? `"${preview}..."` : ""}`);
}

// 3. Run the SAME request-build path pi-ai uses, with stack capture
console.log("\n--- invoking streamSimpleAnthropic to reproduce ---");
try {
  const s = streamSimpleAnthropic(
    model,
    { systemPrompt: "", messages, tools: [] },
    { apiKey: "fake-key-for-repro" },
  );
  // Don't actually wait for HTTP — just trigger the synchronous build.
  // The error happens inside the IIFE before any network I/O if any
  // message is malformed. We listen to first event with a short timeout.
  const timer = setTimeout(() => {
    console.log("(no immediate error — request built successfully)");
    process.exit(0);
  }, 500);
  for await (const ev of s) {
    clearTimeout(timer);
    console.log(`first event: ${ev.type}, reason=${ev.reason}`);
    if (ev.error) {
      console.log(`errorMessage: ${ev.error.errorMessage}`);
    }
    break;
  }
} catch (err) {
  console.log("\n=== CAUGHT (sync) ===");
  console.log(`message: ${err.message}`);
  console.log(`\nstack trace:`);
  console.log(err.stack);
}

// 4. Also do a pure JS scan of the messages to identify the bad one
//    (same logic as the new debug log, run against the actual history)
console.log("\n--- pure-JS scan of reconstructed messages ---");
const bad = [];
for (let i = 0; i < messages.length; i++) {
  const m = messages[i];
  if (!m || typeof m !== "object") {
    bad.push({ i, issue: `not an object: ${typeof m}` });
    continue;
  }
  const c = m.content;
  if (c === undefined) continue;
  if (typeof c === "string") continue;
  if (Array.isArray(c)) {
    const badBlock = c.find((b) => !b || typeof b !== "object" || typeof b.type !== "string");
    if (badBlock !== undefined) {
      bad.push({ i, role: m.role, issue: `block[${c.indexOf(badBlock)}] missing string \`type\`` });
    }
    continue;
  }
  bad.push({ i, role: m.role, issue: `content is ${c === null ? "null" : typeof c}` });
}

if (bad.length === 0) {
  console.log("no structural issues found by static scan");
  console.log("(the bug may be inside pi-ai's transform/convert logic,");
  console.log(" or in a field we don't see at this level)");
} else {
  console.log(`found ${bad.length} suspicious message(s):`);
  for (const b of bad) console.log(`  [${b.i}] role=${b.role} issue=${b.issue}`);
}
