/**
 * Real-binary integration tests for the herdr backend.
 *
 * Same rationale as `tests/zellij.integration.test.ts`: the mocked unit suite
 * verifies the argv we BELIEVE herdr accepts, never the argv herdr ACTUALLY
 * accepts — and a capability flag set true without a real-binary assertion is
 * how the broken zellij `dump-screen` argv shipped green. These tests pin
 * herdr's CLI contract for every operation the backend performs: tab create,
 * text delivery, visible-source read, `pane get` liveness, close, and focus.
 *
 * Unlike tmux and zellij, herdr has no detached-session path: the suite runs
 * in the CALLING workspace (`HERDR_WORKSPACE_ID`), creating `--no-focus` tabs
 * that briefly appear in the tab bar and are closed in `afterEach`. The focus
 * assertions deliberately steal focus for under a second and then restore the
 * calling tab (`HERDR_TAB_ID`).
 *
 * Excluded from the default `test` script (see `package.json`); run via
 * `npm run test:herdr`. Skipped entirely when the process is not inside a
 * herdr-managed pane with a live server.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrMultiplexer } from "../src/multiplexer-herdr";
import { MUX_CAPABILITIES } from "../src/multiplexer";
import { restoreHostHerdrEnvironment } from "./herdr-env";

// The global setup quarantines the herdr context away from every worker;
// driving the real binary from the calling workspace is this suite's point,
// so it alone opts back in — before the availability guard below reads env.
restoreHostHerdrEnvironment();

function herdrUsable(): boolean {
  if (process.env.HERDR_ENV !== "1") return false;
  try {
    execFileSync("herdr", ["pane", "current", "--current"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const hasHerdr = herdrUsable();

/** Tabs created by the current test, torn down in afterEach. */
let tabs: string[] = [];
let tempRoot: string;
let focusStolen = false;

function closeTab(tabId: string): void {
  try {
    execFileSync("herdr", ["tab", "close", tabId], {
      stdio: "ignore",
      timeout: 10000,
    });
  } catch {
    // Already gone (closing a pane can take its tab with it).
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 20000,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `${message}${lastError ? ` (last error: ${String(lastError)})` : ""}`,
  );
}

/**
 * Create a background tab + pane through the production code path and wait
 * until the pane is reported alive.
 */
async function spawnPane(mux: HerdrMultiplexer, name: string) {
  const cwd = mkdtempSync(join(tempRoot, "ws-"));
  const pane = mux.createPane({ name, cwd, background: true });
  if (pane.windowName) tabs.push(pane.windowName);
  await waitFor(
    () => mux.getPaneLiveness(pane.paneId) === "alive",
    `pane ${pane.paneId} never reported alive`,
  );
  return pane;
}

describe.skipIf(!hasHerdr)("herdr backend against the real binary", () => {
  let mux: HerdrMultiplexer;

  beforeAll(() => {
    // Fail loudly rather than silently testing nothing if the guard regresses.
    expect(hasHerdr).toBe(true);
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pi-subagentura-herdr-"));
    tabs = [];
    focusStolen = false;
    mux = new HerdrMultiplexer();
  });

  afterEach(() => {
    for (const tab of tabs) closeTab(tab);
    tabs = [];
    if (focusStolen && process.env.HERDR_TAB_ID) {
      // Give the developer their tab back after a focus assertion.
      try {
        execFileSync("herdr", ["tab", "focus", process.env.HERDR_TAB_ID], {
          stdio: "ignore",
          timeout: 5000,
        });
      } catch {
        // Focus restore is best effort.
      }
    }
    rmSync(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it("isAvailable finds the live server", () => {
    expect(mux.isAvailable()).toBe(true);
  });

  it("createPane makes a live, addressable pane in a --no-focus tab", async () => {
    const pane = await spawnPane(mux, "Create child");

    // The session is the calling workspace; windowName carries the tab id
    // (opaque handles shaped like `w1:p1` / `w1:t1`).
    expect(pane.session).toBe(process.env.HERDR_WORKSPACE_ID);
    expect(pane.windowName).toMatch(/^[^:\s]+:t[^:\s]+$/);
    expect(pane.paneId).toMatch(/^[^:\s]+:p[^:\s]+$/);
    expect(mux.getPaneLiveness(pane.paneId)).toBe("alive");
    await expect(mux.getPaneLivenessAsync(pane.paneId)).resolves.toBe("alive");
  });

  it("reports dead for a pane id the workspace never had", async () => {
    // `pane get` answers `pane_not_found` (exit 1, JSON on stderr) for a
    // well-formed id that does not exist — the one definitive dead signal.
    const workspace = process.env.HERDR_WORKSPACE_ID!;
    expect(mux.getPaneLiveness(`${workspace}:p0zZ9NoSuchPane`)).toBe("dead");
    await expect(
      mux.getPaneLivenessAsync(`${workspace}:p0zZ9NoSuchPane`),
    ).resolves.toBe("dead");
  });

  it("capturePane reads real pane output via the visible source", async () => {
    const pane = await spawnPane(mux, "Capture child");
    const marker = `HERDR_CAPTURE_MARKER_${process.pid}`;

    mux.sendKeys(pane.paneId, `echo ${marker}`);
    mux.sendEnter(pane.paneId);

    let captured = "";
    await waitFor(async () => {
      const result = await mux.capturePane(
        { paneId: pane.paneId },
        { maxBytes: 64 * 1024, maxLines: 500 },
      );
      captured = result.output;
      return captured.includes(marker);
    }, "timed out waiting for the marker to appear in pane read output");

    expect(captured).toContain(marker);
  });

  it("capturePane honors maxLines and maxBytes bounds", async () => {
    const pane = await spawnPane(mux, "Bounded child");
    const marker = `HERDR_BOUND_MARKER_${process.pid}`;

    mux.sendKeys(pane.paneId, `echo ${marker}`);
    mux.sendEnter(pane.paneId);
    await waitFor(async () => {
      const result = await mux.capturePane(
        { paneId: pane.paneId },
        { maxBytes: 64 * 1024, maxLines: 500 },
      );
      return result.output.includes(marker);
    }, "timed out waiting for bounded-capture marker");

    const bounded = await mux.capturePane(
      { paneId: pane.paneId },
      { maxBytes: 12, maxLines: 1 },
    );
    expect(Buffer.byteLength(bounded.output, "utf8")).toBeLessThanOrEqual(12);
    expect(bounded.output.split("\n")).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
  });

  it("sendKeys delivers flag-like text literally (no clap hijack)", async () => {
    // The text is a positional argument after the pane id and herdr treats
    // everything there as literal — `--help` must land in the pane's input
    // buffer, not print the CLI's help. Follow-up text is model-controlled,
    // so a hijack here would be an injection, not a typo.
    const pane = await spawnPane(mux, "Dash child");
    const marker = `DASH_OK_${process.pid}`;

    expect(() =>
      mux.sendKeys(pane.paneId, `echo ${marker} --help`),
    ).not.toThrow();
    expect(() => mux.sendKeys(pane.paneId, ` -not-a-flag`)).not.toThrow();
    mux.sendEnter(pane.paneId);

    await waitFor(async () => {
      const result = await mux.capturePane(
        { paneId: pane.paneId },
        { maxBytes: 64 * 1024, maxLines: 500 },
      );
      return result.output.includes(`${marker} --help -not-a-flag`);
    }, "timed out waiting for the flag-like text to appear in the pane");
  });

  it("killPane removes the pane and is safe to repeat", async () => {
    const pane = await spawnPane(mux, "Kill child");
    expect(mux.getPaneLiveness(pane.paneId)).toBe("alive");

    mux.killPane(pane.paneId);
    await waitFor(
      () => mux.getPaneLiveness(pane.paneId) === "dead",
      "pane never reported dead after killPane",
    );
    await expect(mux.getPaneLivenessAsync(pane.paneId)).resolves.toBe("dead");
    expect(() => mux.killPane(pane.paneId)).not.toThrow();
  });

  it("focusPane reaches the tab from windowName and from a bare pane id", async () => {
    const pane = await spawnPane(mux, "Focus child");
    focusStolen = true;

    await expect(
      mux.focusPane({ paneId: pane.paneId, windowName: pane.windowName }),
    ).resolves.toBeUndefined();

    // A bare PaneRef must also reach the tab (via `pane get`) — this is the
    // observed behaviour behind `structuredFocus: true`.
    await expect(
      mux.focusPane({ paneId: pane.paneId }),
    ).resolves.toBeUndefined();
  });

  it("buildAttachCommands emits commands the real CLI parses", async () => {
    const pane = await spawnPane(mux, "Attach child");
    focusStolen = true;
    const cmds = mux.buildAttachCommands({
      paneId: pane.paneId,
      windowName: pane.windowName,
    });

    expect(cmds.attachCommand).toBe("herdr");
    expect(cmds.focusCommand).toBe(`herdr tab focus '${pane.windowName}'`);
    // Run the focus command's argv against the real server to prove the
    // subcommand and target still exist in this herdr version.
    expect(() =>
      execFileSync("herdr", ["tab", "focus", pane.windowName!], {
        stdio: "ignore",
        timeout: 10000,
      }),
    ).not.toThrow();
  });

  it("showNativeViewer declines — herdr has no overlay surface", async () => {
    await expect(mux.showNativeViewer()).resolves.toBe(false);
  });

  it("declared capabilities match what the binary actually does", async () => {
    // Every flag here is exercised by a test above: structuredFocus by the
    // focus test, boundedCapture by the bounds test, nativeOverlay (false)
    // by the declining viewer.
    expect(mux.capabilities).toEqual(MUX_CAPABILITIES.herdr);
    expect(mux.capabilities.structuredFocus).toBe(true);
    expect(mux.capabilities.boundedCapture).toBe(true);
    expect(mux.capabilities.nativeOverlay).toBe(false);
  });
});
