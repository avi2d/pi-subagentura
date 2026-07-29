import { spawn } from "node:child_process";
import { getScenario } from "../scenarios.mjs";
import { createHarness } from "../harness.mjs";

const name = process.argv[2] ?? "sync-context";
const scenario = getScenario(name);
const harness = createHarness({ scenario: name, keep: false });
let failed = false;
let releaseTimer;

async function attachTmux() {
  const child = spawn(
    "tmux",
    ["-L", harness.socket, "attach-session", "-t", harness.session],
    { stdio: "inherit", env: harness.env },
  );
  await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(`tmux attach exited with code=${code} signal=${signal}`),
        );
    });
  });
}
try {
  await harness.start();
  harness.sendText(scenario.prompt);
  harness.pressEnter();
  if (scenario.gate) {
    await harness.waitForProvider(
      (events) =>
        events.some(
          (event) =>
            event.marker === scenario.child && event.afterStage === "gated",
        ),
      `${name} gate`,
    );
    console.error(
      `\n${name}: child is gated; attaching tmux for a deterministic visual pause.`,
    );
    releaseTimer = setTimeout(() => harness.release(scenario.gate), 2500);
  }
  await attachTmux();
  if (scenario.child)
    await harness.waitForProvider(
      (events) =>
        events.some(
          (event) =>
            event.marker === scenario.child && event.afterStage === "complete",
        ),
      `${name} completion`,
    );
} catch (error) {
  failed = true;
  console.error(error);
  process.exitCode = 1;
} finally {
  if (releaseTimer) clearTimeout(releaseTimer);
  await harness.cleanup(failed);
}
