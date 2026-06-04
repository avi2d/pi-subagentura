// End-to-end smoke test: drive the actual extension code path against a real
// tmux session and a real `pi` child process. Run manually:
//
//   export TMUX=/private/tmp/tmux-501/default,$sid,0
//   export TMUX_PANE=%<parent-pane-id>
//   node --experimental-strip-types smoke-interactive.mjs
import {
  launchInteractiveSubagent,
  interactiveSubagentRegistry,
  cancelInteractiveSubagent,
  captureTmuxPane,
  isTmuxPaneAlive,
} from "./interactive-tmux.ts";

const cwd = process.cwd();
const state = launchInteractiveSubagent({
  name: "Smoke Subagent",
  task: "Reply with the single word PONG and nothing else, then exit. Do not call any tools.",
  persona: "You are a smoke-test responder. Follow instructions exactly.",
  cwd,
});

console.log("launched:", state.id, state.paneId);
console.log("session file:", state.sessionFile);
console.log("attach:", state.attachCommand);
console.log("script:", state.launchScriptFile);

const poll = (ms) => new Promise((r) => setTimeout(r, ms));
let detected = "";
for (let i = 0; i < 90; i++) {
  await poll(1000);
  const alive = isTmuxPaneAlive(state.paneId);
  let screen = "";
  try {
    screen = captureTmuxPane(state.paneId, 60);
  } catch (err) {
    screen = `(capture failed: ${err.message})`;
  }
  const tail = screen.split("\n").filter(Boolean).slice(-6).join("\n");
  console.log(`t=${i + 1}s alive=${alive}\n${tail}\n---`);
  if (screen.includes("PONG") || screen.includes("__SUBAGENT_DONE_")) {
    detected = screen.includes("PONG") ? "PONG" : "DONE_SENTINEL";
    break;
  }
}
console.log("detected:", detected || "TIMEOUT");

const final = cancelInteractiveSubagent(state.id);
console.log("cancelled:", final?.status);
const all = [...interactiveSubagentRegistry.values()];
console.log("registry:", all.map((s) => ({ id: s.id, status: s.status, pane: s.paneId })));
