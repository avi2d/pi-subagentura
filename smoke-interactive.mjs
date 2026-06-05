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
  isTmuxPaneAlive,
} from "./interactive-tmux.ts";
import { readEvents, artifactPath } from "./artifact.ts";

const cwd = process.cwd();
const state = launchInteractiveSubagent({
  name: "Smoke Subagent",
  task: [
    "Reply with the single word PONG.",
    `Write that word to $ARTIFACT_DIR/output.md.`,
    `Then run $ARTIFACT_DIR/cli.mjs done 0 to signal completion.`,
    "Do not exit the REPL — it stays open after done.",
  ].join(" "),
  persona: "You are a smoke-test responder. Follow the protocol exactly.",
  cwd,
});

console.log("launched:", state.id, state.paneId);
console.log("session file:", state.sessionFile);
console.log("attach:", state.attachCommand);
console.log("script:", state.launchScriptFile);

const poll = (ms) => new Promise((r) => setTimeout(r, ms));
let detected = "";
const art = artifactPath(state.artifactDir, state.id);

// Poll the artifact for a 'done' event (the new completion protocol). A
// correctly-completed child writes {type:"done"} to events.ndjson via
// `cli.mjs done 0`; that is the wakeup signal. We don't scrape the pane
// anymore because the REPL stays open after done.
for (let i = 0; i < 90; i++) {
  await poll(1000);
  const alive = isTmuxPaneAlive(state.paneId);
  const events = readEvents(art);
  const types = events.map((e) => e.type).join(",");
  console.log(`t=${i + 1}s alive=${alive} events=[${types}] ---`);
  if (events.some((e) => e.type === "done")) {
    detected = "DONE_EVENT";
    break;
  }
}
console.log("detected:", detected || "TIMEOUT");

const final = cancelInteractiveSubagent(state.id);
console.log("cancelled:", final?.status);
const all = [...interactiveSubagentRegistry.values()];
console.log("registry:", all.map((s) => ({ id: s.id, status: s.status, pane: s.paneId })));
