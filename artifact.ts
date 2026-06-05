/**
 * Sub-agent artifact storage.
 *
 * Each interactive sub-agent owns a directory under the parent's artifacts root.
 * The directory holds two files:
 *
 *   events.ndjson  — append-only log of lifecycle and tool_activity events

 *   output.md      — clean prose the sub-agent produced; atomically rewritten
 *
 * The parent agent's extension reads these files (via list_subagent_artifacts /
 * read_subagent_artifact) to learn what the sub-agent did. The pane is for live
 * monitoring only; the artifact is the source of truth.
 *
 * Files survive parent-agent restarts, so a sub-agent can complete while the
 * parent is down and the parent can catch up by reading the artifact later.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ndjson from "ndjson";

// ── Types ───────────────────────────────────────────────────────────

export type SubagentStatus = "running" | "done" | "error" | "cancelled";

export interface SubagentEvent {
	/** Unix epoch milliseconds */
	ts: number;
	type: "started" | "tool_activity" | "done" | "error" | "cancelled";
	status: SubagentStatus;
	message?: string;
	/** For tool_activity: which tool was called and a short arg summary. */
	tool?: string;
	summary?: string;
	exitCode?: number;
}


export interface SubagentArtifact {
	id: string;
	dir: string;
	statusFile: string;
	outputFile: string;
}

// ── Paths ───────────────────────────────────────────────────────────

export function artifactPath(rootDir: string, id: string): SubagentArtifact {
	const dir = join(rootDir, id);
	return {
		id,
		dir,
		statusFile: join(dir, "events.ndjson"),
		outputFile: join(dir, "output.md"),
	};
}

/** Create the artifact directory with owner-only perms. Idempotent. */
export function ensureArtifactDir(art: SubagentArtifact): void {
	mkdirSync(art.dir, { recursive: true, mode: 0o700 });
}

// ── Writes ──────────────────────────────────────────────────────────

/** Append one event to the NDJSON log. Creates the dir if needed. */
export function appendEvent(art: SubagentArtifact, event: SubagentEvent): void {
	ensureArtifactDir(art);
	appendFileSync(art.statusFile, JSON.stringify(event) + "\n", { mode: 0o600 });
}

/**
 * Atomically replace output.md with `content`. The actual write goes to a
 * sibling .tmp file first; renameSync is atomic within a filesystem, so a
 * concurrent reader sees either the old content or the new — never partial.
 */
export function writeOutput(art: SubagentArtifact, content: string): void {
	ensureArtifactDir(art);
	const tmp = art.outputFile + ".tmp";
	writeFileSync(tmp, content, { mode: 0o600 });
	renameSync(tmp, art.outputFile);
}

// ── Reads ───────────────────────────────────────────────────────────

/**
 * Read all events for a sub-agent. If `since` is provided, only events with
 * ts >= since are returned. Malformed lines are silently skipped (the
 * sub-agent CLI is the only writer, but a partial write could in theory
 * leave a truncated line).
 *
 * Uses the `ndjson` library with `strict: false` so a single bad line does not abort the whole
 * file — ndjson drops the bad row and continues with the rest. Any trailing partial line (file
 * did not end with a newline) is buffered by the parser and dropped on `end()`; it is treated as a
 * in-progress write that the next reader will pick up once completed.
 */
export function readEvents(art: SubagentArtifact, since?: number): SubagentEvent[] {
	if (!existsSync(art.statusFile)) return [];
	let content: string;
	try {
		content = readFileSync(art.statusFile, "utf8");
	} catch {
		return [];
	}
	const parser = ndjson.parse({ strict: false });
	const events: SubagentEvent[] = [];
	parser.on("data", (obj: unknown) => {
		const ev = obj as SubagentEvent;
		if (since === undefined || ev.ts >= since) events.push(ev);
	});
	// Non-strict mode never emits 'error' for bad JSON; attach a no-op so an unhandled error event
	// can never crash the parent process.
	parser.on("error", () => {});
	parser.end(Buffer.from(content, "utf8"));
	return events;
}

/** Returns output.md content, or null if it doesn't exist yet. */
export function readOutput(art: SubagentArtifact): string | null {
	if (!existsSync(art.outputFile)) return null;
	try {
		return readFileSync(art.outputFile, "utf8");
	} catch {
		return null;
	}
}

/** List all sub-agent artifacts under `rootDir`. Ignores loose files. */
export function listArtifacts(rootDir: string): SubagentArtifact[] {
	if (!existsSync(rootDir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(rootDir);
	} catch {
		return [];
	}
	const out: SubagentArtifact[] = [];
	for (const name of entries) {
		const full = join(rootDir, name);
		try {
			if (statSync(full).isDirectory()) {
				out.push(artifactPath(rootDir, name));
			}
		} catch {
			// skip unreadable
		}
	}
	return out;
}

/** Most recent event, or null if no events yet. */
export function lastEvent(art: SubagentArtifact): SubagentEvent | null {
	const events = readEvents(art);
	return events.length > 0 ? events[events.length - 1] : null;
}

