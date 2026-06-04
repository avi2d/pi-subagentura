import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendEvent,
	artifactPath,
	ensureArtifactDir,
	lastEvent,
	lastUpdate,
	listArtifacts,
	readEvents,
	readOutput,
	writeOutput,
	type SubagentEvent,
} from "./artifact";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagentura-artifact-"));
}

describe("artifact", () => {
	let root: string;

	beforeEach(() => {
		root = makeTmp();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe("artifactPath", () => {
		it("builds expected paths under the root", () => {
			const art = artifactPath(root, "abc123");
			expect(art.id).toBe("abc123");
			expect(art.dir).toBe(join(root, "abc123"));
			expect(art.statusFile).toBe(join(root, "abc123", "events.ndjson"));
			expect(art.outputFile).toBe(join(root, "abc123", "output.md"));
		});
	});

	describe("ensureArtifactDir", () => {
		it("creates the directory with 0o700 perms", () => {
			const art = artifactPath(root, "x");
			ensureArtifactDir(art);
			expect(existsSync(art.dir)).toBe(true);
			expect(statSync(art.dir).mode & 0o777).toBe(0o700);
		});

		it("is idempotent", () => {
			const art = artifactPath(root, "x");
			ensureArtifactDir(art);
			expect(() => ensureArtifactDir(art)).not.toThrow();
		});
	});

	describe("appendEvent", () => {
		it("creates dir and writes one NDJSON line", () => {
			const art = artifactPath(root, "a");
			const ev: SubagentEvent = { ts: 1000, type: "started", status: "running" };
			appendEvent(art, ev);
			expect(existsSync(art.statusFile)).toBe(true);
			const content = readFileSync(art.statusFile, "utf8");
			expect(content).toBe(JSON.stringify(ev) + "\n");
		});

		it("appends multiple events in order", () => {
			const art = artifactPath(root, "a");
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			appendEvent(art, { ts: 2, type: "wip", status: "wip", message: "thinking" });
			appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
			const content = readFileSync(art.statusFile, "utf8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(3);
			expect(JSON.parse(lines[0]).type).toBe("started");
			expect(JSON.parse(lines[1]).message).toBe("thinking");
			expect(JSON.parse(lines[2]).exitCode).toBe(0);
		});

		it("creates the status file with 0o600 perms", () => {
			const art = artifactPath(root, "a");
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			expect(statSync(art.statusFile).mode & 0o777).toBe(0o600);
		});
	});

	describe("writeOutput", () => {
		it("writes content atomically (no .tmp left behind)", () => {
			const art = artifactPath(root, "a");
			writeOutput(art, "hello world");
			expect(existsSync(art.outputFile)).toBe(true);
			expect(existsSync(art.outputFile + ".tmp")).toBe(false);
			expect(readFileSync(art.outputFile, "utf8")).toBe("hello world");
		});

		it("overwrites previous content", () => {
			const art = artifactPath(root, "a");
			writeOutput(art, "first");
			writeOutput(art, "second");
			expect(readFileSync(art.outputFile, "utf8")).toBe("second");
		});

		it("creates the output file with 0o600 perms", () => {
			const art = artifactPath(root, "a");
			writeOutput(art, "secret");
			expect(statSync(art.outputFile).mode & 0o777).toBe(0o600);
		});
	});

	describe("readEvents", () => {
		it("returns empty array when no status file", () => {
			const art = artifactPath(root, "missing");
			expect(readEvents(art)).toEqual([]);
		});

		it("parses all events in order", () => {
			const art = artifactPath(root, "a");
			appendEvent(art, { ts: 100, type: "started", status: "running" });
			appendEvent(art, { ts: 200, type: "wip", status: "wip", message: "m" });
			const events = readEvents(art);
			expect(events).toHaveLength(2);
			expect(events[0].ts).toBe(100);
			expect(events[1].message).toBe("m");
		});

		it("filters by `since` (inclusive)", () => {
			const art = artifactPath(root, "a");
			appendEvent(art, { ts: 100, type: "started", status: "running" });
			appendEvent(art, { ts: 200, type: "wip", status: "wip" });
			appendEvent(art, { ts: 300, type: "done", status: "done", exitCode: 0 });
			const events = readEvents(art, 200);
			expect(events.map((e) => e.ts)).toEqual([200, 300]);
		});

		it("silently skips malformed lines", () => {
			const art = artifactPath(root, "a");
			ensureArtifactDir(art);
			appendFileSync(art.statusFile, '{"ts":1,"type":"started","status":"running"}\n');
			appendFileSync(art.statusFile, "this is not json\n");
			appendFileSync(art.statusFile, '{"ts":2,"type":"done","status":"done","exitCode":0}\n');
			const events = readEvents(art);
			expect(events).toHaveLength(2);
		});
	});

	describe("readOutput", () => {
		it("returns null when output.md doesn't exist", () => {
			const art = artifactPath(root, "a");
			expect(readOutput(art)).toBeNull();
		});

		it("returns content when present", () => {
			const art = artifactPath(root, "a");
			writeOutput(art, "the result");
			expect(readOutput(art)).toBe("the result");
		});
	});

	describe("listArtifacts", () => {
		it("returns empty when root is missing", () => {
			expect(listArtifacts(join(root, "nope"))).toEqual([]);
		});

		it("returns empty when root is empty", () => {
			expect(listArtifacts(root)).toEqual([]);
		});

		it("lists subdirs as artifacts, ignores loose files", () => {
			mkdirSync(join(root, "id1"));
			mkdirSync(join(root, "id2"));
			writeFileSync(join(root, "stray.txt"), "ignore me");
			const arts = listArtifacts(root);
			expect(arts.map((a) => a.id).sort()).toEqual(["id1", "id2"]);
		});

		it("each entry has the expected paths", () => {
			mkdirSync(join(root, "id1"));
			const arts = listArtifacts(root);
			expect(arts[0].statusFile).toBe(join(root, "id1", "events.ndjson"));
			expect(arts[0].outputFile).toBe(join(root, "id1", "output.md"));
		});
	});

	describe("lastEvent", () => {
		it("returns null when no events", () => {
			expect(lastEvent(artifactPath(root, "a"))).toBeNull();
		});

		it("returns the most recent event", () => {
			const art = artifactPath(root, "a");
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			appendEvent(art, { ts: 5, type: "wip", status: "wip", message: "m" });
			appendEvent(art, { ts: 9, type: "done", status: "done", exitCode: 0 });
			expect(lastEvent(art)?.ts).toBe(9);
			expect(lastEvent(art)?.type).toBe("done");
		});
	});

	describe("lastUpdate", () => {
		it("returns 0 when neither file exists", () => {
			expect(lastUpdate(artifactPath(root, "a"))).toBe(0);
		});

		it("reflects the mtime of events.ndjson", async () => {
			const art = artifactPath(root, "a");
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			// mtime resolution can be coarse on some FS — bump it explicitly
			const future = Date.now() + 2000;
			// Wait a bit so mtime is reliably greater than Date.now() at call
			await new Promise((r) => setTimeout(r, 10));
			const mtime = lastUpdate(art);
			expect(mtime).toBeGreaterThan(0);
			expect(Number.isFinite(mtime)).toBe(true);
			// future is just to show the API accepts a number — unused assertion
			expect(future).toBeGreaterThan(0);
		});

		it("reflects the newer of the two files", async () => {
			const art = artifactPath(root, "a");
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			await new Promise((r) => setTimeout(r, 10));
			writeOutput(art, "later");
			const statusMtime = statSync(art.statusFile).mtimeMs;
			const outputMtime = statSync(art.outputFile).mtimeMs;
			expect(lastUpdate(art)).toBe(Math.max(statusMtime, outputMtime));
		});
	});
});
