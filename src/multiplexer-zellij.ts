/**
 * Zellij backend for the `Multiplexer` interface.
 *
 * Implements the eight methods defined by `Multiplexer` using the zellij v0.44
 * CLI. Verified against zellij 0.44.3.
 *
 * Pane IDs: `zellij action new-pane` prints `terminal_<n>` / `plugin_<n>` on
 * stdout, but `action list-panes --json` reports the bare integer `<n>` in its
 * `id` field, and every `--pane-id` flag accepts the bare integer too. To keep
 * one canonical form everywhere we normalize to the bare integer string the
 * moment a pane id enters our hands (`normalizePaneId`). This is what makes the
 * visible-split path's liveness probe work — without it `isPaneAlive` would
 * compare `"terminal_5"` against `"5"` and always report dead.
 *
 * Session targeting: zellij addresses every `action` at a specific session via
 * `--session <name>`. The session a pane lives in is NOT stored on the backend
 * instance (the resolver hands out a single cached instance, so per-spawn state
 * on it would be clobbered by the next spawn). Instead `createPane` RETURNS the
 * session name; the orchestrator persists it on `InteractiveSubagentState.muxSession`
 * and threads it back into every later op as the trailing `session` argument.
 *
 * Two code paths:
 *   1. Parent process is inside a zellij session (`ZELLIJ` env var set):
 *      operations run against `ZELLIJ_SESSION_NAME`.
 *   2. Parent process is NOT inside a zellij session: a background session is
 *      created (`zellij attach --create-background <name>`) and every command
 *      targets it via `--session <name>`.
 */

import { execFile, execFileSync } from "node:child_process";
import type {
  CapturePaneOptions,
  CapturePaneResult,
  Multiplexer,
  PaneRef,
} from "./multiplexer";
import {
  boundCaptureOutput,
  commandExists,
  execMuxOrThrow,
  MAX_CAPTURE_READ_BYTES,
  MUX_CAPABILITIES,
  safeSegment,
  sanitizeViewerTitle,
  shellEscape,
  spawnNativeViewer,
} from "./multiplexer";

/**
 * Normalize a zellij pane id to the bare-integer string form used by
 * `list-panes --json` (`id`) and accepted by every `--pane-id` flag.
 * `new-pane` emits `terminal_5` / `plugin_2`; strip that prefix so the id
 * round-trips through `isPaneAlive` / `sendKeys` / `killPane`.
 */
function normalizePaneId(raw: string): string {
  return raw.trim().replace(/^(?:terminal_|plugin_)/, "");
}

export class ZellijMultiplexer implements Multiplexer {
  readonly name = "zellij" as const;
  readonly capabilities = MUX_CAPABILITIES.zellij;

  /**
   * True iff `zellij` is on PATH. Binary-only — symmetric with
   * `TmuxMultiplexer.isAvailable()`. The "am I inside a zellij session"
   * heuristic (`ZELLIJ` / `ZELLIJ_SESSION_NAME`) lives in `getMux()`'s
   * auto-resolution, NOT here, so the relaxed-spawn fallback in `getMux()`
   * can select zellij from a plain terminal (it creates a detached session
   * in `createPane`). Previously this also required `ZELLIJ === "0"`, which
   * made zellij unreachable via `preference: "auto"` outside a session.
   */
  isAvailable(): boolean {
    return commandExists("zellij");
  }

  /**
   * Build the `--session <name>` argv prefix, or `[]` when no session is
   * known (operate on the current/attached session).
   */
  private sessionFlag(session?: string): string[] {
    return session ? ["--session", session] : [];
  }

  /**
   * Create a pane for the child process.
   *
   * When the parent is in zellij (the common case):
   *   - background: true  → `new-tab -n <name>` in the current session
   *   - background: false → `new-pane --direction right --close-on-exit`
   *
   * When the parent is NOT in zellij (the relaxed spawn path), creates a
   * brand-new detached session named `pi-subagent-<id>` first, then creates
   * the pane/tab inside it.
   *
   * Returns the session the pane lives in so the caller can address it later.
   */
  createPane(opts: {
    name: string;
    cwd: string;
    background: boolean;
    parentPane?: string;
    windowName?: string;
    id?: string;
  }): { paneId: string; windowName?: string; session?: string } {
    if (!commandExists("zellij")) {
      throw new Error(
        "zellij is not available. Install zellij or set PATH to include it.",
      );
    }

    let windowName: string | undefined;
    const isInZellij = !!process.env.ZELLIJ;

    let session: string;
    if (!isInZellij) {
      // Relaxed path: parent not in zellij. Create a background session.
      session = `pi-subagent-${opts.id ?? safeSegment(opts.name)}`;
      execMuxOrThrow(
        "zellij",
        "attach --create-background",
        "zellij",
        ["attach", "--create-background", session],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
    } else {
      session = process.env.ZELLIJ_SESSION_NAME ?? "";
    }

    const sessionFlag = this.sessionFlag(session);

    // A visible side-by-side split only works when a client is attached to
    // the session: in a detached session zellij doesn't materialize the new
    // pane (it never shows up in `list-panes`). When the parent isn't in
    // zellij we have no attached client, so force background (new-tab) mode
    // — matching how the tmux backend treats its relaxed path. `new-tab`
    // panes are tracked in detached sessions; `new-pane` panes are not.
    const useBackground = opts.background || !isInZellij;

    // Snapshot panes before creating, so we can identify the new pane by
    // diffing afterwards. Neither `new-tab` nor `new-pane` gives us an id
    // that round-trips against `list-panes` (new-pane prints a `terminal_N`
    // counter that is distinct from the `id` field every other op compares
    // against), so the diff is the canonical way to recover the pane id.
    const panesBefore = this.listPanes(session);

    if (useBackground) {
      windowName = opts.windowName ?? safeSegment(opts.name);
      // Save the current active tab position before creating the new tab,
      // so we can switch back afterwards. zellij's new-tab always focuses
      // the new tab; we want to leave focus on the parent's tab (matching
      // tmux's -d flag behavior for detached windows).
      let previousTabPosition: number | undefined;
      if (isInZellij) {
        try {
          previousTabPosition = this.currentTabPosition(sessionFlag);
        } catch {
          // Best effort — if we can't get the current tab, we'll still
          // create the new tab, just won't restore focus.
        }
      }
      execMuxOrThrow(
        "zellij",
        "new-tab",
        "zellij",
        [...sessionFlag, "action", "new-tab", "--name", windowName],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
      // Restore focus to the previous tab if we saved its position.
      if (previousTabPosition !== undefined) {
        try {
          execFileSync(
            "zellij",
            [
              ...sessionFlag,
              "action",
              "go-to-tab",
              String(previousTabPosition),
            ],
            { encoding: "utf8", timeout: 3000 },
          );
        } catch {
          // Best effort — cosmetic only.
        }
      }
    } else {
      // Visible split — side-by-side with the focused pane. zellij splits
      // relative to the currently-focused pane; there is no flag to split
      // from a specific pane id (`new-pane` has no `--in-pane-id`), so
      // `opts.parentPane` is intentionally ignored. No `--close-on-exit`:
      // that flag makes a trailing `<COMMAND>` mandatory, and we want a
      // plain shell pane that outlives the launch script (like tmux's split).
      execMuxOrThrow(
        "zellij",
        "new-pane",
        "zellij",
        [...sessionFlag, "action", "new-pane", "--direction", "right"],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
    }

    // Ignore plugin panes (the tab-bar / status-bar / link plugins zellij
    // spawns) on BOTH sides of the diff — only a real terminal pane can host
    // the child shell, and plugin ids live in a separate namespace that shares
    // integers with terminal ids (see `paneRowMatches`). Keeping plugin ids in
    // `beforeIds` would mask a genuinely new terminal pane whose integer
    // happens to match an existing plugin pane.
    const terminalsAfter = this.listPanes(session).filter((p) => !p.is_plugin);
    const beforeIds = new Set(
      panesBefore.filter((p) => !p.is_plugin).map((p) => String(p.id)),
    );
    const newPanes = terminalsAfter.filter((p) => !beforeIds.has(String(p.id)));
    const chosen = newPanes[0] ?? terminalsAfter[0];
    const paneId = chosen ? normalizePaneId(String(chosen.id)) : "";
    if (!paneId) {
      throw new Error("Failed to determine pane ID after creating pane");
    }

    return { paneId, windowName, session: session || undefined };
  }

  /**
   * Read the focused tab's position so `createPane` can restore focus after
   * `new-tab` steals it.
   *
   * `action current-tab-info --json` (verified present in zellij 0.44.3) emits a
   * full `TabInfo` object with a numeric `position`; the default text form emits
   * `name: … / id: … / position: N`. We prefer JSON and keep the text regex as a
   * fallback for zellij builds without `--json`.
   *
   * Returns `undefined` when there is no focused tab to restore — notably when a
   * floating/plugin pane holds focus, where zellij answers
   * `No active tab found for current client` on stdout with exit 0 rather than
   * failing, so a parse miss (not an exception) is the signal.
   */
  private currentTabPosition(sessionFlag: string[]): number | undefined {
    const output = execFileSync(
      "zellij",
      [...sessionFlag, "action", "current-tab-info", "--json"],
      { encoding: "utf8", timeout: 3000 },
    );
    try {
      const parsed = JSON.parse(output) as { position?: unknown };
      if (typeof parsed.position === "number") return parsed.position;
    } catch {
      // Not JSON (older zellij, or the "no active tab" text response).
    }
    const positionMatch = output.match(/^position:\s*(\d+)/m);
    return positionMatch ? parseInt(positionMatch[1], 10) : undefined;
  }

  /** Run `list-panes --json` against a session, returning [] on any failure. */
  private listPanes(
    session?: string,
  ): Array<{ id: unknown; is_plugin?: boolean; exited?: boolean }> {
    try {
      const output = execFileSync(
        "zellij",
        [...this.sessionFlag(session), "action", "list-panes", "--json"],
        { encoding: "utf8", timeout: 5000 },
      );
      const parsed = JSON.parse(output);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Match a `list-panes --json` row against a pane id we hold.
   *
   * Plugin panes MUST be excluded, not merely deprioritized: zellij numbers
   * `terminal_N` and `plugin_N` in SEPARATE namespaces, and `normalizePaneId`
   * strips the prefix, so the two collapse onto the same integer. Verified
   * against zellij 0.44.3 — a fresh session lists a `zellij:link` plugin pane
   * with `id: 0` alongside the shell's terminal pane, also `id: 0`. Matching on
   * the bare integer therefore reported a closed sub-agent pane as still alive
   * (the plugin pane kept answering for it), which would make the artifact
   * poller believe a finished child was running forever. Our pane is always a
   * terminal pane: `createPane` only ever selects `!is_plugin`.
   */
  private paneRowMatches(
    pane: { id?: unknown; is_plugin?: boolean; exited?: boolean },
    target: string,
  ): boolean {
    return (
      !pane.is_plugin && String(pane.id) === target && pane.exited !== true
    );
  }

  /**
   * Probe whether the pane is still alive. Runs `list-panes --json` and
   * checks whether the pane ID appears AND has not exited. Returns false on
   * any error (dead pane, backend down, malformed id).
   */
  isPaneAlive(paneId: string, session?: string): boolean {
    const target = normalizePaneId(paneId);
    return this.listPanes(session).some((p) => this.paneRowMatches(p, target));
  }

  isPaneAliveAsync(paneId: string, session?: string): Promise<boolean> {
    const target = normalizePaneId(paneId);
    return new Promise((resolve) => {
      try {
        execFile(
          "zellij",
          [...this.sessionFlag(session), "action", "list-panes", "--json"],
          { encoding: "utf8", timeout: 5000 },
          (error, stdout) => {
            if (error) {
              resolve(false);
              return;
            }
            try {
              const parsed = JSON.parse(stdout);
              const panes = Array.isArray(parsed) ? parsed : [];
              resolve(
                panes.some(
                  (pane: {
                    id?: unknown;
                    is_plugin?: boolean;
                    exited?: boolean;
                  }) => this.paneRowMatches(pane, target),
                ),
              );
            } catch {
              // Malformed backend output is a failed liveness probe.
              resolve(false);
            }
          },
        );
      } catch {
        // A synchronous child-process setup failure is also a failed probe.
        resolve(false);
      }
    });
  }

  /**
   * Send literal text to the pane's shell input buffer, character by
   * character. Does NOT submit (no Enter).
   */
  sendKeys(paneId: string, text: string, session?: string): void {
    execMuxOrThrow(
      "zellij",
      "write-chars",
      "zellij",
      [
        ...this.sessionFlag(session),
        "action",
        "write-chars",
        "--pane-id",
        normalizePaneId(paneId),
        // `--` terminates flag parsing. Follow-up text is user/model controlled;
        // starting it with `-` otherwise fails the whole command (zellij's own
        // error even suggests the fix: "use `-- -n`").
        "--",
        text,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  }

  /**
   * Send a single Enter / Return key to the pane (decimal 13 = Enter key).
   */
  sendEnter(paneId: string, session?: string): void {
    execMuxOrThrow(
      "zellij",
      "write 13",
      "zellij",
      [
        ...this.sessionFlag(session),
        "action",
        "write",
        "--pane-id",
        normalizePaneId(paneId),
        // Symmetric with sendKeys; `13` needs no protection itself, but the
        // terminator keeps the two write paths shaped identically.
        "--",
        "13",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  }

  /**
   * Kill the pane. Best-effort — no throw on already-dead panes.
   */
  killPane(paneId: string, session?: string): void {
    try {
      execFileSync(
        "zellij",
        [
          ...this.sessionFlag(session),
          "action",
          "close-pane",
          "--pane-id",
          normalizePaneId(paneId),
        ],
        { stdio: "ignore", timeout: 5000 },
      );
    } catch {
      // Best effort — pane may already be dead.
    }
  }

  focusPane(ref: PaneRef): Promise<void> {
    return new Promise((resolve, reject) => {
      const focusArgs = ref.windowName
        ? [
            ...this.sessionFlag(ref.session),
            "action",
            "go-to-tab-name",
            ref.windowName,
          ]
        : [
            ...this.sessionFlag(ref.session),
            "action",
            "focus-pane-id",
            normalizePaneId(ref.paneId),
          ];
      execFile("zellij", focusArgs, { timeout: 5000 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /**
   * Capture bounded pane output via `action dump-screen`.
   *
   * argv contract (verified against zellij 0.44.3 — `zellij action dump-screen
   * --help` is `dump-screen [OPTIONS]`, no positional):
   *   - STDOUT is the DEFAULT sink. There used to be a `/dev/stdout` positional
   *     here, which clap rejected client-side with
   *     `error: Found argument '/dev/stdout' which wasn't expected` (exit 2) —
   *     the command never reached a session, so BOTH overlay actions that read
   *     pane output (`v` snapshot, `n` native viewer) failed for every zellij
   *     sub-agent. Write-to-file is `--path <PATH>`, which we do not want.
   *   - `--full` includes scrollback. Without it zellij dumps only the current
   *     viewport, whereas tmux's `capture-pane -S -<lines>` reaches scrollback.
   *
   * Remaining backend difference: tmux applies the line bound server-side
   * (`-S -<lines>`), zellij has no equivalent flag, so we ask for everything and
   * let `boundCaptureOutput` apply `maxLines`/`maxBytes` client-side. Same
   * result for the caller; zellij just transfers more bytes over the socket,
   * capped by `MAX_CAPTURE_READ_BYTES`.
   */
  capturePane(
    ref: PaneRef,
    opts: CapturePaneOptions,
  ): Promise<CapturePaneResult> {
    return new Promise((resolve, reject) => {
      execFile(
        "zellij",
        [
          ...this.sessionFlag(ref.session),
          "action",
          "dump-screen",
          "--full",
          "--pane-id",
          normalizePaneId(ref.paneId),
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
   * Open the bounded supervisor content in a floating zellij pane.
   *
   * Kept behaviourally identical to the tmux twin: spawn asynchronously, resolve
   * `true` once the overlay survives the spawn grace window, resolve `false`
   * when zellij rejects the request. Previously this was a synchronous
   * fire-and-forget that returned `true` unconditionally while the tmux twin
   * blocked the event loop — same interface, opposite behaviour.
   *
   * `--name` is not a format context in zellij (verified: a `#(...)` pane name
   * executes nothing), but it is still untrusted text in an argv slot: a name
   * beginning with `-` makes zellij's clap parser reject the whole command
   * (`Found argument '-r' which wasn't expected`). `sanitizeViewerTitle` handles
   * that along with the tmux format hazard, so both backends sanitize alike.
   */
  showNativeViewer(title: string, content: string): Promise<boolean> {
    if (!process.env.ZELLIJ) return Promise.resolve(false);
    const command = `printf '%s\\n' ${shellEscape(content)}; printf '\\nPress Enter to close'; read _`;
    return spawnNativeViewer("zellij", [
      ...this.sessionFlag(process.env.ZELLIJ_SESSION_NAME),
      "action",
      "new-pane",
      "--floating",
      "--name",
      sanitizeViewerTitle(title),
      "--",
      "sh",
      "-lc",
      command,
    ]);
  }

  /**
   * Build the user-facing commands to attach to (or focus) the child's pane.
   *
   * Two forms:
   *   - `attachCommand`: works from a plain shell — attaches to the zellij
   *     session.
   *   - `focusCommand`: works from inside the same zellij session — goes to
   *     the tab (background mode) or focuses the pane by id (split mode).
   *
   * Session name comes from the `session` returned by `createPane` (threaded
   * through by the caller), falling back to `ZELLIJ_SESSION_NAME` for an
   * in-session spawn.
   */
  buildAttachCommands(opts: {
    paneId: string;
    windowName?: string;
    session?: string;
  }): {
    attachCommand: string;
    focusCommand: string;
  } {
    const sessionName = opts.session || process.env.ZELLIJ_SESSION_NAME || "";
    const escapedSession = shellEscape(sessionName);

    if (opts.windowName) {
      // Background mode: pane lives in a named tab.
      return {
        attachCommand: `zellij attach ${escapedSession}`,
        focusCommand: `zellij action go-to-tab-name ${shellEscape(opts.windowName)}`,
      };
    }

    // Visible split: focus by pane id. The zellij action is `focus-pane-id`
    // (there is no `focus-pane`), and it takes the bare pane id as a
    // positional argument. No `\;` chaining — that's tmux-only syntax.
    return {
      attachCommand: `zellij attach ${escapedSession}`,
      focusCommand: `zellij action focus-pane-id ${shellEscape(normalizePaneId(opts.paneId))}`,
    };
  }
}
