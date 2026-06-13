/**
 * Zellij backend for the `Multiplexer` interface.
 *
 * Implements the eight methods defined by `Multiplexer` using the zellij v0.44
 * CLI. Pane IDs are stringified integers (zellij uses `terminal_N` internally
 * but accepts bare integers).
 *
 * Two code paths:
 *   1. Parent process is inside a zellij session (`ZELLIJ` env var set to
 *      `"0"`): operations run against the current session.
 *   2. Parent process is NOT inside a zellij session: a background session
 *      is created (`zellij attach --create-background <name>`) and all
 *      subsequent commands target it via `--session <name>`.
 */

import { execFileSync } from "node:child_process";
import type { Multiplexer } from "./multiplexer";
import { commandExists, shellEscape } from "./multiplexer";

/** Sanitize a free-form name into a safe segment for zellij tab/session names. */
function safeSegment(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "subagent"
	);
}

export class ZellijMultiplexer implements Multiplexer {
	readonly name = "zellij" as const;

	/** Session name used when parent was not in zellij during createPane. */
	private _sessionName = "";

	/**
	 * True iff `zellij` is on PATH AND the parent process is inside a zellij
	 * server (`ZELLIJ` env var set to `"0"`).
	 */
	isAvailable(): boolean {
		return process.env.ZELLIJ === "0" && commandExists("zellij");
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
	 */
	createPane(opts: {
		name: string;
		cwd: string;
		background: boolean;
		parentPane?: string;
		windowName?: string;
		id?: string;
	}): { paneId: string; windowName?: string } {
		if (!commandExists("zellij")) {
			throw new Error("zellij is not available. Install zellij or set PATH to include it.");
		}

		let paneId: string;
		let windowName: string | undefined;
		const isInZellij = !!process.env.ZELLIJ;

		if (!isInZellij) {
			// Relaxed path: parent not in zellij. Create a background session.
			this._sessionName = `pi-subagent-${opts.id ?? safeSegment(opts.name)}`;
			execFileSync("zellij", ["attach", "--create-background", this._sessionName], {
				encoding: "utf8",
				timeout: 10000,
			});
		} else {
			this._sessionName = process.env.ZELLIJ_SESSION_NAME ?? "";
		}

		const sessionFlag = this._sessionName ? ["--session", this._sessionName] : [];

		if (opts.background) {
			windowName = opts.windowName ?? safeSegment(opts.name);

			// Snapshot panes before creating the tab so we can identify the new
			// pane by diffing.
			let panesBefore: any[] = [];
			try {
				const before = execFileSync(
					"zellij",
					[...sessionFlag, "action", "list-panes", "--json"],
					{ encoding: "utf8", timeout: 5000 },
				);
				panesBefore = JSON.parse(before);
			} catch {
				panesBefore = [];
			}

			execFileSync("zellij", [...sessionFlag, "action", "new-tab", "--name", windowName], {
				encoding: "utf8",
				timeout: 10000,
			});

			let panesAfter: any[] = [];
			try {
				const after = execFileSync(
					"zellij",
					[...sessionFlag, "action", "list-panes", "--json"],
					{ encoding: "utf8", timeout: 5000 },
				);
				panesAfter = JSON.parse(after);
			} catch {
				panesAfter = [];
			}

			const beforeIds = new Set(panesBefore.map((p: any) => String(p.id)));
			const newPanes = panesAfter.filter((p: any) => !beforeIds.has(String(p.id)));
			paneId = newPanes.length > 0 ? String(newPanes[0].id) : String(panesAfter[0]?.id ?? "");
			if (!paneId) {
				throw new Error("Failed to determine pane ID after creating tab");
			}
		} else {
			// Visible split — side-by-side with the parent pane.
			const args = ["action", "new-pane", "--direction", "right", "--close-on-exit"];
			if (opts.parentPane) {
				args.splice(2, 0, "--in-pane-id", opts.parentPane);
			}
			paneId = execFileSync("zellij", [...sessionFlag, ...args], {
				encoding: "utf8",
				timeout: 10000,
			})
				.trim();
			if (!paneId) {
				throw new Error("Unexpected empty zellij pane id from new-pane");
			}
		}

		return { paneId, windowName };
	}

	/**
	 * Probe whether the pane is still alive. Runs `list-panes --json` and
	 * checks whether the pane ID appears in the result. Returns false on
	 * any error (dead pane, backend down, malformed id).
	 */
	isPaneAlive(paneId: string): boolean {
		try {
			const sessionFlag = this._sessionName ? ["--session", this._sessionName] : [];
			const output = execFileSync("zellij", [...sessionFlag, "action", "list-panes", "--json"], {
				encoding: "utf8",
				timeout: 5000,
			});
			const panes = JSON.parse(output);
			return panes.some((p: any) => String(p.id) === paneId);
		} catch {
			return false;
		}
	}

	/**
	 * Send literal text to the pane's shell input buffer, character by
	 * character. Does NOT submit (no Enter).
	 */
	sendKeys(paneId: string, text: string): void {
		execFileSync("zellij", ["action", "write-chars", "--pane-id", paneId, text], {
			encoding: "utf8",
			timeout: 5000,
		});
	}

	/**
	 * Send a single Enter / Return key to the pane (decimal 13 = Enter key).
	 */
	sendEnter(paneId: string): void {
		execFileSync("zellij", ["action", "write", "--pane-id", paneId, "13"], {
			encoding: "utf8",
			timeout: 5000,
		});
	}

	/**
	 * Kill the pane. Best-effort — no throw on already-dead panes.
	 */
	killPane(paneId: string): void {
		try {
			execFileSync("zellij", ["action", "close-pane", "--pane-id", paneId], {
				stdio: "ignore",
				timeout: 5000,
			});
		} catch {
			// Best effort — pane may already be dead.
		}
	}

	/**
	 * Build the user-facing commands to attach to (or focus) the child's pane.
	 *
	 * Two forms:
	 *   - `attachCommand`: works from a plain shell — attaches to the zellij
	 *     session.
	 *   - `focusCommand`: works from inside the same zellij session — goes to
	 *     the tab / focuses the pane.
	 *
	 * Session name is taken from `ZELLIJ_SESSION_NAME` (when parent is in
	 * zellij) or from the session created by `createPane` (relaxed path).
	 */
	buildAttachCommands(opts: { paneId: string; windowName?: string }): {
		attachCommand: string;
		focusCommand: string;
	} {
		const sessionName = process.env.ZELLIJ_SESSION_NAME || this._sessionName;
		const escapedSession = shellEscape(sessionName);

		if (opts.windowName) {
			// Background mode: pane lives in a named tab.
			return {
				attachCommand: `zellij attach ${escapedSession}`,
				focusCommand: `zellij action go-to-tab-name ${shellEscape(opts.windowName)}`,
			};
		}

		// Visible split: focus by pane id.
		return {
			attachCommand: `zellij attach ${escapedSession} \\; zellij action focus-pane ${opts.paneId}`,
			focusCommand: `zellij action focus-pane ${opts.paneId}`,
		};
	}
}
