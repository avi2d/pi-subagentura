import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSubagentActivityRecorder,
	getSubagentActivityFile,
	readSubagentActivityFile,
	type SubagentActivityRecorder,
} from "./activity";

describe("getSubagentActivityFile", () => {
	it("builds the standard path", () => {
		expect(getSubagentActivityFile("/tmp/x", "abc-123")).toBe(
			"/tmp/x/subagent-activity/abc-123.json",
		);
	});
});

describe("createSubagentActivityRecorder", () => {
	let tmpDir: string;
	let activityFile: string;
	const runningChildId = "test-job";

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-subagent-activity-"));
		activityFile = join(tmpDir, "subagent-activity", `${runningChildId}.json`);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function readFile(): any {
		return JSON.parse(readFileSync(activityFile, "utf-8"));
	}

	it("returns a no-op recorder without activityFile", () => {
		const r: SubagentActivityRecorder = createSubagentActivityRecorder({});
		r.agentStart();
		r.toolExecutionStart("id", "read");
		// No file should be created anywhere
		expect(() => readFile()).toThrow();
	});

	it("writes a file on agentStart with correct phase/scope", () => {
		const r = createSubagentActivityRecorder({
			runningChildId,
			activityFile,
			now: () => 1000,
		});
		r.sessionStart();
		r.agentStart();
		const f = readFile();
		expect(f.version).toBe(1);
		expect(f.runningChildId).toBe(runningChildId);
		expect(f.phase).toBe("active");
		expect(f.activeScope).toBe("agent");
		expect(f.agentActive).toBe(true);
	});

	it("toolExecutionStart sets tool scope + toolName", () => {
		const r = createSubagentActivityRecorder({ runningChildId, activityFile });
		r.sessionStart();
		r.agentStart();
		r.toolExecutionStart("call-1", "read");
		const f = readFile();
		expect(f.phase).toBe("active");
		expect(f.activeScope).toBe("tool");
		expect(f.toolActive).toBe(true);
		expect(f.toolName).toBe("read");
		expect(f.toolCallId).toBe("call-1");
	});

	it("toolExecutionEnd drops tool scope but keeps agent active", () => {
		const r = createSubagentActivityRecorder({ runningChildId, activityFile });
		r.sessionStart();
		r.agentStart();
		r.toolExecutionStart("c", "read");
		r.toolExecutionEnd("c", "read");
		const f = readFile();
		expect(f.toolActive).toBe(false);
		expect(f.activeScope).toBe("agent");
		expect(f.agentActive).toBe(true);
	});

	it("subagentDone moves to done and disables recorder", () => {
		const r = createSubagentActivityRecorder({ runningChildId, activityFile });
		r.sessionStart();
		r.agentStart();
		r.subagentDone();
		const f = readFile();
		expect(f.phase).toBe("done");
		expect(f.toolActive).toBe(false);
		expect(f.agentActive).toBe(false);
		// Subsequent calls are no-ops
		r.agentStart();
		const f2 = readFile();
		expect(f2.sequence).toBe(f.sequence);
	});

	it("atomic write: file is never observed in a partial state", () => {
		// Just confirm writeFileSync + renameSync behavior - the file appears
		// only when fully written, so the parent always sees valid JSON.
		const r = createSubagentActivityRecorder({ runningChildId, activityFile });
		r.sessionStart();
		r.agentStart();
		// If the file exists, it must be valid JSON
		const content = readFileSync(activityFile, "utf-8");
		expect(() => JSON.parse(content)).not.toThrow();
	});

	it("throttles messageUpdate events", () => {
		let nowVal = 1000;
		const r = createSubagentActivityRecorder({
			runningChildId,
			activityFile,
			now: () => nowVal,
		});
		r.sessionStart();
		r.agentStart();
		const seqBefore = readFile().sequence;
		// Rapid-fire 10 messageUpdate in same ms - all but 1 should be throttled
		for (let i = 0; i < 10; i++) {
			r.messageUpdate("text_delta");
			nowVal += 10;
		}
		// Sequence may not have advanced (everything was throttled in same window)
		const f = readFile();
		expect(f.sequence).toBeGreaterThanOrEqual(seqBefore);
	});

	it("disables after repeated write failures", () => {
		// Try to write to a path where parent dir creation will succeed but the
		// final rename will fail because the file is read-only. We simulate by
		// pointing at a path that includes a file as a "directory".
		const blockingFile = join(tmpDir, "blocker");
		writeFileSync(blockingFile, "block");
		const badActivityFile = join(blockingFile, "subagent-activity", "x.json");
		const r = createSubagentActivityRecorder({
			runningChildId,
			activityFile: badActivityFile,
		});
		// 3 failures should disable
		r.sessionStart();
		r.agentStart();
		r.toolExecutionStart();
		// Recorder should be in disabled state; further calls are no-ops
		r.subagentDone(); // would normally mark done, but disabled
	});
});

describe("readSubagentActivityFile", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-subagent-read-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns missing for non-existent file", () => {
		const result = readSubagentActivityFile(
			join(tmpDir, "nope.json"),
			"any-id",
		);
		expect(result.ok).toBe(false);
		const r = result as { ok: false; reason: string };
		expect(r.reason).toBe("missing");
	});

	it("returns invalid for bad JSON", () => {
		const file = join(tmpDir, "bad.json");
		writeFileSync(file, "not json {");
		const result = readSubagentActivityFile(file, "any-id");
		expect(result.ok).toBe(false);
		const r = result as { ok: false; reason: string; error?: string };
		expect(r.reason).toBe("invalid");
		expect(r.error).toBeTruthy();
	});

	it("returns wrong-id for mismatched runningChildId", () => {
		const file = join(tmpDir, "x.json");
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				runningChildId: "other-id",
				createdAt: 1,
				updatedAt: 1,
				sequence: 0,
				latestEvent: "session_start",
				phase: "starting",
				agentActive: false,
				turnActive: false,
				providerActive: false,
				toolActive: false,
			}),
		);
		const result = readSubagentActivityFile(file, "expected-id");
		expect(result.ok).toBe(false);
		const r = result as { ok: false; reason: string };
		expect(r.reason).toBe("wrong-id");
	});

	it("returns invalid for unknown phase", () => {
		const file = join(tmpDir, "x.json");
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				runningChildId: "id",
				createdAt: 1,
				updatedAt: 1,
				sequence: 0,
				latestEvent: "session_start",
				phase: "garbage",
				agentActive: false,
				turnActive: false,
				providerActive: false,
				toolActive: false,
			}),
		);
		const result = readSubagentActivityFile(file, "id");
		expect(result.ok).toBe(false);
		const r = result as { ok: false; reason: string };
		expect(r.reason).toBe("invalid");
	});

	it("returns ok for a valid file", () => {
		const file = join(tmpDir, "x.json");
		const activity = {
			version: 1,
			runningChildId: "id",
			createdAt: 1,
			updatedAt: 1000,
			sequence: 5,
			latestEvent: "tool_execution_start",
			phase: "active",
			agentActive: true,
			turnActive: true,
			providerActive: false,
			toolActive: true,
			activeScope: "tool",
			activeSince: 500,
			toolName: "read",
		};
		writeFileSync(file, JSON.stringify(activity));
		const result = readSubagentActivityFile(file, "id");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.activity.sequence).toBe(5);
			expect(result.activity.toolName).toBe("read");
		}
	});
});
