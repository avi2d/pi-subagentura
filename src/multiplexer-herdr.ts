/**
 * Herdr backend for the `Multiplexer` interface.
 *
 * Implements the interface over the `herdr` CLI. Verified against herdr 0.8.2.
 *
 * herdr differs from tmux and zellij in three ways that shape this file:
 *
 *   1. No relaxed path. Every operation needs the workspace and caller-pane
 *      context (`HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`) that herdr injects only
 *      into its own panes, so `isAvailable()` requires `HERDR_ENV=1` plus a
 *      live socket probe rather than a bare binary check, and `getMux()` never
 *      offers herdr as a plain-terminal fallback.
 *
 *   2. Background mode is a visible, unfocused tab. tmux background means an
 *      invisible detached window; the closest herdr analogue is
 *      `tab create --no-focus` — a tab in the tab bar that does not steal
 *      focus. A hidden named session (`herdr --session`) would cost the
 *      observability this package exists for.
 *
 *   3. Output shapes are mixed. `pane read` prints plain text on stdout;
 *      every other command prints JSON (`{"id":..., "result":{...}}` on
 *      success, `{"error":{"code":...}}` on stderr with exit 1 on failure;
 *      CLI syntax errors exit 2).
 *
 * Field mapping: `session` carries `$HERDR_WORKSPACE_ID`. In background mode
 * `windowName` carries the returned `tab_id` — focus and attach both need the
 * id, and the display name goes to `--label` instead. In split mode
 * `windowName` stays undefined (callers read its absence as "visible split");
 * `focusPane` recovers the split pane's tab id from `pane get`, whose JSON
 * carries `tab_id`.
 *
 * Text delivery: `pane send-text` takes the text as one positional argument
 * and treats everything after the pane id as literal — flag-like text such as
 * `--help` or a leading `-` is delivered verbatim (verified against 0.8.2), so
 * no `--` terminator exists or is needed. A `--` argument would itself be
 * delivered as text. Newlines inside the text submit, matching the tmux
 * backend's verbatim delivery contract.
 */

import { execFile, execFileSync } from "node:child_process";
import type {
  CapturePaneOptions,
  CapturePaneResult,
  Multiplexer,
  PaneLiveness,
  PaneRef,
} from "./multiplexer";
import {
  boundCaptureOutput,
  commandExists,
  execMuxOrThrow,
  MAX_CAPTURE_READ_BYTES,
  MUX_CAPABILITIES,
  safeSegment,
  shellEscape,
} from "./multiplexer";

/** Extract a nested value from a parsed herdr JSON response, or throw. */
function requireString(
  value: unknown,
  path: string,
  operation: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[herdr] ${operation} response is missing ${path}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse a JSON success payload and return its `result` object, or throw. */
function parseResult(
  output: string,
  operation: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`[herdr] ${operation} printed malformed JSON`);
  }
  const result = asRecord(asRecord(parsed)?.result);
  if (!result) {
    throw new Error(`[herdr] ${operation} response carries no result`);
  }
  return result;
}

/**
 * Read the machine error code from a herdr stderr payload.
 *
 * Server errors are JSON on stderr with exit 1, e.g.
 * `{"error":{"code":"pane_not_found"}}`. Anything else — a syntax error
 * (exit 2), a dead socket, non-JSON stderr — yields undefined, which callers
 * must treat as "cannot answer", never as a dead pane.
 */
function errorCodeFromStderr(
  stderr: Buffer | string | undefined,
): string | undefined {
  if (stderr == null) return undefined;
  const parsed = (() => {
    try {
      return JSON.parse(String(stderr)) as unknown;
    } catch {
      return undefined;
    }
  })();
  const code = asRecord(asRecord(parsed)?.error)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Same, from a thrown `execFileSync` error, which carries stderr on the error
 * object. The async `execFile` path must NOT use this: there stderr arrives as
 * a callback argument and is never attached to the error.
 */
function herdrErrorCode(err: unknown): string | undefined {
  return errorCodeFromStderr(
    (err as { stderr?: Buffer | string } | null)?.stderr,
  );
}

export class HerdrMultiplexer implements Multiplexer {
  readonly name = "herdr" as const;
  readonly capabilities = MUX_CAPABILITIES.herdr;

  /**
   * True iff this process runs inside a herdr-managed pane AND the herdr
   * server answers. `HERDR_ENV=1` alone is not enough — the env var survives
   * into descendants after the server is gone, and a backend that cannot
   * reach its server must not win auto-resolution.
   */
  isAvailable(): boolean {
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

  /**
   * Create a pane for the child process.
   *
   *   - background: true  → `tab create --no-focus` in the caller's workspace:
   *                         a visible tab that does not steal focus.
   *   - background: false → `pane split --direction right` from the caller's
   *                         own pane (`HERDR_PANE_ID`, herdr knowledge this
   *                         backend resolves itself). Forced to background
   *                         when no caller pane exists, mirroring the other
   *                         backends' no-attached-client fallback.
   */
  createPane(opts: {
    name: string;
    cwd: string;
    background: boolean;
    windowName?: string;
    id?: string;
  }): { paneId: string; windowName?: string; session?: string } {
    if (!commandExists("herdr")) {
      throw new Error(
        "herdr is not available. Install herdr or set PATH to include it.",
      );
    }
    const workspace = process.env.HERDR_WORKSPACE_ID;
    if (!workspace) {
      throw new Error(
        "HERDR_WORKSPACE_ID is not set. Interactive sub-agents on herdr " +
          "require pi to run inside a herdr-managed pane.",
      );
    }

    const callerPane = process.env.HERDR_PANE_ID;
    const useBackground = opts.background || !callerPane;

    if (useBackground) {
      const label = opts.windowName ?? safeSegment(opts.name);
      const result = parseResult(
        execMuxOrThrow(
          "herdr",
          "tab create",
          "herdr",
          [
            "tab",
            "create",
            "--workspace",
            workspace,
            "--cwd",
            opts.cwd,
            "--label",
            label,
            "--no-focus",
          ],
          { encoding: "utf8", timeout: 10000 },
        ),
        "tab create",
      );
      const paneId = requireString(
        asRecord(result.root_pane)?.pane_id,
        "result.root_pane.pane_id",
        "tab create",
      );
      const tabId = requireString(
        asRecord(result.tab)?.tab_id,
        "result.tab.tab_id",
        "tab create",
      );
      return { paneId, windowName: tabId, session: workspace };
    }

    const result = parseResult(
      execMuxOrThrow(
        "herdr",
        "pane split",
        "herdr",
        [
          "pane",
          "split",
          "--pane",
          callerPane!,
          "--direction",
          "right",
          "--cwd",
          opts.cwd,
          "--no-focus",
        ],
        { encoding: "utf8", timeout: 10000 },
      ),
      "pane split",
    );
    const paneId = requireString(
      asRecord(result.pane)?.pane_id,
      "result.pane.pane_id",
      "pane split",
    );
    return { paneId, windowName: undefined, session: workspace };
  }

  /**
   * Probe pane liveness via `pane get`. Exit 0 is alive; exit 1 with the
   * `pane_not_found` error code is the one definitive dead signal. Everything
   * else — timeout, dead socket, another error code — is `unknown`, because a
   * backend that cannot answer must not be read as a dead pane.
   */
  getPaneLiveness(paneId: string): PaneLiveness {
    if (!paneId || paneId.startsWith("-")) return "unknown";
    try {
      execFileSync("herdr", ["pane", "get", paneId], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 5000,
      });
      return "alive";
    } catch (err) {
      return herdrErrorCode(err) === "pane_not_found" ? "dead" : "unknown";
    }
  }

  getPaneLivenessAsync(paneId: string): Promise<PaneLiveness> {
    if (!paneId || paneId.startsWith("-")) return Promise.resolve("unknown");
    return new Promise((resolve) => {
      try {
        execFile(
          "herdr",
          ["pane", "get", paneId],
          { encoding: "utf8", timeout: 5000 },
          (error, _stdout, stderr) => {
            if (!error) {
              resolve("alive");
              return;
            }
            resolve(
              errorCodeFromStderr(stderr) === "pane_not_found"
                ? "dead"
                : "unknown",
            );
          },
        );
      } catch {
        resolve("unknown");
      }
    });
  }

  /**
   * Send literal text to the pane. The text is one positional argument;
   * herdr delivers everything after the pane id verbatim, flag-like text
   * included (see the file header). Does NOT submit — `sendEnter` does.
   */
  sendKeys(paneId: string, text: string): void {
    execMuxOrThrow(
      "herdr",
      "pane send-text",
      "herdr",
      ["pane", "send-text", paneId, text],
      { encoding: "utf8", timeout: 5000 },
    );
  }

  sendEnter(paneId: string): void {
    execMuxOrThrow(
      "herdr",
      "pane send-keys enter",
      "herdr",
      ["pane", "send-keys", paneId, "enter"],
      { encoding: "utf8", timeout: 5000 },
    );
  }

  killPane(paneId: string): void {
    try {
      execFileSync("herdr", ["pane", "close", paneId], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // Best effort — pane may already be dead (`pane_not_found`, exit 1).
    }
  }

  /**
   * Focus the tab hosting the referenced pane. herdr has no focus-pane-by-id
   * command, so the tab is the focus target: `windowName` already carries the
   * tab id for background tabs, and a split pane's tab id is recovered from
   * `pane get` — which is what keeps `structuredFocus` true for a bare
   * `PaneRef`.
   */
  focusPane(ref: PaneRef): Promise<void> {
    return new Promise((resolve, reject) => {
      let tabId: string;
      try {
        tabId = ref.windowName ?? this.tabIdForPane(ref.paneId);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      execFile("herdr", ["tab", "focus", tabId], { timeout: 5000 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private tabIdForPane(paneId: string): string {
    const result = parseResult(
      execMuxOrThrow("herdr", "pane get", "herdr", ["pane", "get", paneId], {
        encoding: "utf8",
        timeout: 5000,
      }),
      "pane get",
    );
    return requireString(
      asRecord(result.pane)?.tab_id,
      "result.pane.tab_id",
      "pane get",
    );
  }

  /**
   * Capture bounded pane output via `pane read --source visible`.
   *
   * Plain text on stdout — the one herdr command that does not answer JSON.
   * `--lines` can reach host scrollback for ordinary shells, but a pi child
   * runs on the alternate screen and rows leaving it never enter host
   * scrollback, so in practice capture is bounded by the pane's viewport.
   */
  capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    const lines = Math.max(1, Math.floor(opts.maxLines));
    return new Promise((resolve, reject) => {
      execFile(
        "herdr",
        [
          "pane",
          "read",
          ref.paneId,
          "--source",
          "visible",
          "--lines",
          String(lines),
        ],
        {
          encoding: "utf8",
          maxBuffer: MAX_CAPTURE_READ_BYTES,
          timeout: 5000,
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(boundCaptureOutput(stdout, opts));
        },
      );
    });
  }

  /**
   * herdr has no popup or floating surface to render into, so the honest
   * answer is always false. The supervisor's native-view action notifies and
   * falls back to the portable Pi overlay — the degradation path
   * `capabilities.nativeOverlay: false` promises.
   */
  showNativeViewer(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Build the user-facing attach/focus commands.
   *
   * `herdr` with no arguments launches or attaches the persistent session, so
   * it is the attach command from any plain shell. Focus goes to the tab: the
   * id is `windowName` for background tabs and recovered via `pane get` for
   * splits (the pane was just created, so the lookup answers).
   */
  buildAttachCommands(opts: { paneId: string; windowName?: string }): {
    attachCommand: string;
    focusCommand: string;
  } {
    const tabId = opts.windowName ?? this.tabIdForPane(opts.paneId);
    return {
      attachCommand: "herdr",
      focusCommand: `herdr tab focus ${shellEscape(tabId)}`,
    };
  }
}
