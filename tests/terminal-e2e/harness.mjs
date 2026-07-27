import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const sleep = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const activeHarnesses = new Set();
let exitCleanupInstalled = false;

function cleanupActiveHarnessesSync() {
  for (const harness of [...activeHarnesses]) {
    try {
      harness.cleanupSync();
    } catch (error) {
      console.error(`terminal E2E emergency cleanup failed: ${error}`);
    }
  }
}

function installExitCleanup() {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", cleanupActiveHarnessesSync);
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    process.once(signal, () => {
      cleanupActiveHarnessesSync();
      process.exit(exitCode);
    });
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function tmuxVersion() {
  try {
    const output = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
    const match = output.match(/(\d+)\.(\d+)/);
    return {
      text: output,
      major: Number(match?.[1] ?? 0),
      minor: Number(match?.[2] ?? 0),
    };
  } catch (error) {
    throw new Error(`tmux is required for terminal E2E tests: ${error}`);
  }
}

function resolvePi() {
  if (process.env.SUBAGENTURA_E2E_REAL_PI) {
    return resolve(process.env.SUBAGENTURA_E2E_REAL_PI);
  }
  const localPi = join(REPO, "node_modules", ".bin", "pi");
  if (existsSync(localPi)) return localPi;
  return execFileSync("sh", ["-c", "command -v pi"], {
    encoding: "utf8",
  }).trim();
}

function resolveProcessGroupId(processId) {
  try {
    const output = execFileSync(
      "ps",
      ["-o", "pgid=", "-p", String(processId)],
      { encoding: "utf8", timeout: 2_000 },
    ).trim();
    const processGroupId = Number(output);
    return Number.isInteger(processGroupId) && processGroupId > 1
      ? processGroupId
      : undefined;
  } catch {
    /* the pane process may exit between tmux enumeration and ps */
    return undefined;
  }
}

function processGroupsForRoot(root) {
  const output = execFileSync("ps", ["-axo", "pgid=,command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const processGroupIds = new Set();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    const processGroupId = Number(match?.[1]);
    const command = match?.[2] ?? "";
    if (command.includes(root) && processGroupId > 1) {
      processGroupIds.add(processGroupId);
    }
  }
  return processGroupIds;
}

function processGroupIsAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
    throw error;
  }
}

function signalProcessGroups(processGroupIds, signal) {
  for (const processGroupId of processGroupIds) {
    if (!processGroupIsAlive(processGroupId)) continue;
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function waitForProcessGroups(processGroupIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = processGroupIds.filter(processGroupIsAlive);
    if (live.length === 0) return [];
    await sleep(50);
  }
  return processGroupIds.filter(processGroupIsAlive);
}

function findFiles(root, fileName) {
  if (!existsSync(root)) return [];
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...findFiles(path, fileName));
    else if (entry.isFile() && entry.name === fileName) matches.push(path);
  }
  return matches;
}

export class TerminalHarness {
  constructor({ scenario = "smoke", keep = false } = {}) {
    this.scenario = scenario;
    this.keep = keep;
    this.root = mkdtempSync(join(tmpdir(), "pi-subagentura-terminal-e2e-"));
    this.workspace = join(this.root, "workspace");
    this.home = join(this.root, "home");
    this.agentDir = join(this.root, "agent");
    this.sessionDir = join(this.root, "sessions");
    this.gates = join(this.root, "gates");
    this.wrapperBin = join(this.root, "bin");
    this.providerLog = join(this.root, "provider.ndjson");
    this.networkLog = join(this.root, "network.ndjson");
    this.diagnosticsDir =
      process.env.SUBAGENTURA_E2E_DIAGNOSTICS ?? join(this.root, "diagnostics");
    this.socket = `subagentura-e2e-${process.pid}-${Math.random().toString(16).slice(2)}`;
    this.session = `e2e-${process.pid}-${Math.random().toString(16).slice(2)}`;
    this.parentPane = undefined;
    this.trackedPids = new Set();
    this.started = false;
    this.serverOwned = false;
    this.version = tmuxVersion();
    activeHarnesses.add(this);
    installExitCleanup();
  }

  get env() {
    return this._env;
  }

  setupFiles() {
    for (const directory of [
      this.workspace,
      this.home,
      this.agentDir,
      this.sessionDir,
      this.gates,
      this.wrapperBin,
      this.diagnosticsDir,
    ])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(this.agentDir, "auth.json"),
      JSON.stringify({
        "subagentura-e2e": { type: "api_key", key: "subagentura-e2e-test-key" },
      }),
      { mode: 0o600 },
    );
    const wrapper = join(this.wrapperBin, "pi");
    cpSync(join(HERE, "fixtures/pi-child-wrapper.sh"), wrapper);
    execFileSync("chmod", ["700", wrapper]);
    const versionConfig = ["set -g extended-keys on"];
    if (
      this.version.major > 3 ||
      (this.version.major === 3 && this.version.minor >= 5)
    )
      versionConfig.push("set -g extended-keys-format csi-u");
    this.tmuxConfig = join(this.root, "tmux.conf");
    writeFileSync(this.tmuxConfig, `${versionConfig.join("\n")}\n`, {
      mode: 0o600,
    });
    const originalPath = process.env.PATH ?? "/usr/bin:/bin";
    const safePath = [
      this.wrapperBin,
      ...originalPath
        .split(":")
        .filter(
          (part) =>
            part && (!part.includes(".nvm") || part === dirname(resolvePi())),
        ),
    ].join(":");
    this._env = {
      HOME: this.home,
      PATH: safePath,
      TERM: "xterm-256color",
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: this.agentDir,
      PI_CODING_AGENT_SESSION_DIR: this.sessionDir,
      PI_SUBAGENTURA_TMUX_SOCKET: this.socket,
      SUBAGENTURA_E2E_GATE_DIR: this.gates,
      SUBAGENTURA_E2E_LOG: this.providerLog,
      SUBAGENTURA_E2E_NETWORK_LOG: this.networkLog,
      SUBAGENTURA_E2E_REPO: REPO,
      SUBAGENTURA_E2E_API_KEY: "subagentura-e2e-test-key",
      SUBAGENTURA_E2E_REAL_PI: resolvePi(),
      NODE_OPTIONS: `--require=${join(HERE, "fixtures/deny-network.cjs")}`,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    appendFileSync(
      this.providerLog,
      `${JSON.stringify({ event: "harness", scenario: this.scenario, tmux: this.version.text })}\n`,
      { mode: 0o600 },
    );
  }

  tmux(args, options = {}) {
    return execFileSync(
      "tmux",
      ["-f", this.tmuxConfig, "-L", this.socket, ...args],
      {
        encoding: "utf8",
        env: this._env,
        timeout: options.timeout ?? 10_000,
        stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      },
    );
  }

  async start() {
    this.setupFiles();
    const pi = resolvePi();
    const command = [
      pi,
      "--offline",
      "--approve",
      "--api-key",
      "subagentura-e2e-test-key",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "-e",
      join(REPO, "src/subagent.ts"),
      "-e",
      join(HERE, "fixtures/mock-provider.ts"),
      "--model",
      "subagentura-e2e/mock",
      "--session-dir",
      this.sessionDir,
    ]
      .map(shellQuote)
      .join(" ");
    this.tmux([
      "new-session",
      "-d",
      "-s",
      this.session,
      "-x",
      "100",
      "-y",
      "32",
      "-c",
      this.workspace,
      command,
    ]);
    this.serverOwned = true;
    this.parentPane = this.tmux([
      "display-message",
      "-p",
      "-t",
      `${this.session}:0.0`,
      "#{pane_id}",
    ]).trim();
    this.started = true;
    await this.waitForScreen(
      (screen) => /Pi|assistant|›|>/.test(screen),
      "real Pi did not reach its editor",
    );
    this.refreshProcesses();
    return this;
  }

  sendText(text) {
    if (!this.parentPane)
      throw new Error("terminal E2E harness is not started");
    this.tmux(["send-keys", "-t", this.parentPane, "-l", "--", text]);
  }

  sendKey(key) {
    this.tmux(["send-keys", "-t", this.parentPane, key]);
  }

  pressEnter() {
    this.sendKey("Enter");
  }

  currentScreen(pane = this.parentPane) {
    return pane ? this.tmux(["capture-pane", "-p", "-t", pane]) : "";
  }

  scrollback(pane = this.parentPane) {
    return pane ? this.tmux(["capture-pane", "-p", "-S", "-", "-t", pane]) : "";
  }

  panes() {
    try {
      const output = this.tmux([
        "list-panes",
        "-a",
        "-F",
        "#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}",
      ]);
      return output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, pid, session, window, pane, active, command] =
            line.split("\t");
          return {
            id,
            pid: Number(pid),
            session,
            window,
            pane,
            active: active === "1",
            command,
          };
        });
    } catch {
      return [];
    }
  }

  refreshProcesses() {
    const ownProcessGroupId = resolveProcessGroupId(process.pid);
    const processGroupIds = processGroupsForRoot(this.root);
    for (const pane of this.panes()) {
      const processGroupId = resolveProcessGroupId(pane.pid);
      if (processGroupId) processGroupIds.add(processGroupId);
    }
    for (const processGroupId of processGroupIds) {
      if (processGroupId !== ownProcessGroupId) {
        this.trackedPids.add(processGroupId);
      }
    }
  }

  readJsonl(path) {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }

  providerEvents() {
    return this.readJsonl(this.providerLog);
  }
  networkEvents() {
    return this.readJsonl(this.networkLog);
  }

  artifactEvents() {
    return findFiles(this.sessionDir, "events.ndjson").flatMap((path) =>
      this.readJsonl(path).map((event) => ({ path, ...event })),
    );
  }

  release(name) {
    writeFileSync(join(this.gates, name), "release\n", { mode: 0o600 });
  }

  async waitFor(predicate, description, timeoutMs = 15_000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(75);
    }
    const details = [
      `Timed out waiting for ${description}`,
      lastError ? String(lastError) : "",
      "--- current screen ---",
      this.currentScreen(),
      "--- provider log ---",
      readFileSync(this.providerLog, "utf8"),
      "--- network log ---",
      existsSync(this.networkLog)
        ? readFileSync(this.networkLog, "utf8")
        : "(empty)",
      "--- panes ---",
      JSON.stringify(this.panes(), null, 2),
      "--- scrollback ---",
      this.scrollback(),
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(details);
  }

  async waitForScreen(predicate, description, timeoutMs = 15_000) {
    return this.waitFor(
      () => predicate(this.currentScreen()),
      description,
      timeoutMs,
    );
  }

  async waitForProvider(predicate, description, timeoutMs = 30_000) {
    return this.waitFor(
      () => predicate(this.providerEvents()),
      description,
      timeoutMs,
    );
  }

  async assertNoNetwork() {
    if (this.networkEvents().length)
      throw new Error(
        `network denial was invoked: ${JSON.stringify(this.networkEvents())}`,
      );
  }

  diagnostics() {
    mkdirSync(this.diagnosticsDir, { recursive: true });
    const writeDiagnostic = (suffix, content) => {
      writeFileSync(
        join(this.diagnosticsDir, `${this.scenario}-${suffix}`),
        content,
      );
    };
    writeDiagnostic("screen.txt", this.currentScreen());
    writeDiagnostic("scrollback.txt", this.scrollback());
    writeDiagnostic(
      "provider.ndjson",
      existsSync(this.providerLog) ? readFileSync(this.providerLog) : "",
    );
    writeDiagnostic(
      "network.ndjson",
      existsSync(this.networkLog) ? readFileSync(this.networkLog) : "",
    );
    writeDiagnostic("panes.json", JSON.stringify(this.panes(), null, 2));
    writeDiagnostic(
      "artifact-events.json",
      JSON.stringify(this.artifactEvents(), null, 2),
    );
  }

  cleanupSync() {
    this.refreshProcesses();
    const processGroupIds = [...this.trackedPids];
    signalProcessGroups(processGroupIds, "SIGKILL");
    if (this.serverOwned || this.started) {
      try {
        execFileSync("tmux", ["-L", this.socket, "kill-server"], {
          stdio: "ignore",
          env: this._env,
          timeout: 2_000,
        });
      } catch {
        /* server may already be gone during emergency cleanup */
      }
    }
    if (!this.keep) rmSync(this.root, { recursive: true, force: true });
    this.started = false;
    this.serverOwned = false;
    activeHarnesses.delete(this);
  }

  async cleanup(failed = false) {
    if (failed || this.keep || process.env.SUBAGENTURA_E2E_DIAGNOSTICS) {
      try {
        this.diagnostics();
      } catch {
        /* diagnostics are best effort during teardown */
      }
    }
    this.refreshProcesses();
    const processGroupIds = [...this.trackedPids];
    signalProcessGroups(processGroupIds, "SIGTERM");
    try {
      execFileSync("tmux", ["-L", this.socket, "kill-server"], {
        stdio: "ignore",
        env: this._env,
        timeout: 5_000,
      });
    } catch {
      /* server may already be gone */
    }
    let remaining = await waitForProcessGroups(processGroupIds, 2_000);
    if (remaining.length > 0) {
      signalProcessGroups(remaining, "SIGKILL");
      remaining = await waitForProcessGroups(remaining, 2_000);
    }
    let serverAlive = false;
    try {
      execFileSync("tmux", ["-L", this.socket, "has-session"], {
        stdio: "ignore",
        env: this._env,
        timeout: 2_000,
      });
      serverAlive = true;
    } catch {
      /* no server/session is the expected teardown state */
    }
    if (!this.keep) rmSync(this.root, { recursive: true, force: true });
    this.started = false;
    this.serverOwned = false;
    activeHarnesses.delete(this);
    if (remaining.length > 0 || serverAlive) {
      throw new Error(
        `terminal E2E teardown incomplete: process groups=${remaining.join(",") || "none"}, serverAlive=${serverAlive}`,
      );
    }
  }
}

export function createHarness(options) {
  return new TerminalHarness(options);
}
export { REPO };
