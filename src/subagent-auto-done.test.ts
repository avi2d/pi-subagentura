/**
 * Tests for the auto-done fallback: when the child ends a turn with
 * stopReason:"stop" but never calls `cli.mjs done`, the parent synthesizes a
 * completion event from the session log alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, artifactPath, readEvents } from "./artifact";
import type { InteractiveSubagentState } from "./interactive-tmux";
import { importFresh } from "./test-utils";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagentura-auto-done-"));
}

interface MakeOpts {
	sessionFile?: string;
	outputContent?: string | null;
}

function makeState(overrides: MakeOpts): { id: string; artifactDir: string; state: InteractiveSubagentState } {
	const id = "id-" + Math.random().toString(36).slice(2, 8);
	const root = makeTmp();
	const artifactDir = join(root, id);
	mkdirSync(artifactDir, { recursive: true });
	const sessionFile = overrides.sessionFile ?? join(artifactDir, "session.jsonl");
	if (overrides.outputContent !== undefined && overrides.outputContent !== null) {
		writeFileSync(join(artifactDir, "output.md"), overrides.outputContent);
	}
	const state: InteractiveSubagentState = {
		id,
		name: "Test",
		task: "t",
		paneId: "%99",
		sessionFile,
		cwd: "/tmp",
		startedAt: Date.now(),
		status: "running",
		attachCommand: "tmux attach -t sess",
		selectPaneCommand: "tmux select-pane -t '%99'",
		launchScriptFile: "/tmp/launch.sh",
		artifactDir,
		// Pretend the model stopped 11s ago, past the 10s debounce.
		lastStopReason: "stop",
		lastStopReasonAt: Date.now() - 11_000,
	};
	return { id, artifactDir, state };
}

/** Variant of makeState for end-to-end tests: no pre-seeded stopReason. */
function makeFreshState(overrides: MakeOpts): { id: string; artifactDir: string; state: InteractiveSubagentState } {
	const seeded = makeState(overrides);
	seeded.state.lastStopReason = undefined;
	seeded.state.lastStopReasonAt = undefined;
	seeded.state.lastStopText = undefined;
	seeded.state.autoDoneForTurnAt = undefined;
	return seeded;
}

function writeAssistantTurn(file: string, ts: number, stopReason: string, text: string): void {
	const entry = {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason,
			timestamp: ts,
		},
	};
	writeFileSync(file, JSON.stringify(entry) + "\n");
}

describe("auto-done fallback", () => {
	let root: string;

	beforeEach(() => {
		root = makeTmp();
		const g = globalThis as any;
		g.__piSubagenturaInteractiveRegistry?.clear?.();
		g.__piSubagenturaPiRef = undefined;
		g.__piSubagenturaUi = undefined;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// ─── Core behavior ────────────────────────────────────────────────

	it("synthesizes a done event when stopReason is 'stop' and output.md exists, after the debounce", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState({ outputContent: "the result" });
		mod.interactiveSubagentRegistry.set(state.id, state);

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		const art = artifactPath(dirname(artifactDir), state.id);
		const events = readEvents(art);
		const done = events.find((e) => e.type === "done");
		expect(done).toBeDefined();
		expect(done && done.type === "done" && done.exitCode).toBe(0);
		expect(done && done.type === "done" && done.summary).toMatch(/auto-detected/);
		expect(sendMessage).toHaveBeenCalled();
		expect(state.status).toBe("running"); // stays running so for-loop keeps tail-reading
		expect(state.injected).toBe(true);
	});

	it("synthesizes an error event (not done) when stopReason is 'stop' but output.md is missing", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState({ outputContent: null });
		state.lastStopText = "Review complete. The findings file `/tmp/review-sec.md` contains 0 critical vulns.";
		mod.interactiveSubagentRegistry.set(state.id, state);

		mod.pollArtifactChanges({} as any);

		const art = artifactPath(dirname(artifactDir), state.id);
		const events = readEvents(art);
		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		const msg = err && err.type === "error" ? err.message : "";
		expect(msg).toMatch(/without writing output\.md/);
		expect(msg).toMatch(/review-sec\.md/); // fallback content from lastStopText
		expect(state.status).toBe("running");
		expect(state.exitCode).toBe(1);
	});

	it("synthesizes an error event with a generic message when output.md is missing AND no lastStopText", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state } = makeState({ outputContent: null });
		mod.interactiveSubagentRegistry.set(state.id, state);

		mod.pollArtifactChanges({} as any);

		const art = artifactPath(dirname(state.artifactDir), state.id);
		const events = readEvents(art);
		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		expect(err && err.type === "error" && err.message).toBe("sub-agent stopped without writing output.md");
	});

	it("does NOT synthesize for stopReason 'toolUse' (model is mid-turn, not finished)", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState({ outputContent: "result" });
		// Cast: the runtime value is intentionally outside the union so we can verify only
		// the four terminal stopReasons are accepted by the typecheck.
		state.lastStopReason = "toolUse" as unknown as "stop";
		mod.interactiveSubagentRegistry.set(state.id, state);

		mod.pollArtifactChanges({} as any);

		const art = artifactPath(dirname(artifactDir), state.id);
		const events = readEvents(art);
		const synthesized = events.find((e) => e.type === "done" || e.type === "error");
		expect(synthesized).toBeUndefined();
		expect(state.status).toBe("running");
	});

	it.each(["length", "error", "aborted"] as const)(
		"does NOT auto-synthesize for stopReason '%s'",
		async (reason) => {
			const mod = await importFresh<typeof import("./subagent")>("./subagent");
			const { state, artifactDir } = makeState({ outputContent: "result" });
			state.lastStopReason = reason;
			mod.interactiveSubagentRegistry.set(state.id, state);

			mod.pollArtifactChanges({} as any);

			const art = artifactPath(dirname(artifactDir), state.id);
			const events = readEvents(art);
			const synthesized = events.find((e) => e.type === "done" || e.type === "error");
			expect(synthesized).toBeUndefined();
		},
	);

	it("does NOT synthesize before the debounce window elapses", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState({ outputContent: "result" });
		state.lastStopReasonAt = Date.now() - 1_000; // 1s ago, well inside the 10s debounce
		mod.interactiveSubagentRegistry.set(state.id, state);

		mod.pollArtifactChanges({} as any);

		const art = artifactPath(dirname(artifactDir), state.id);
		const events = readEvents(art);
		expect(events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(0);
	});

	it("does NOT synthesize when an explicit done event already exists in the artifact", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState({ outputContent: "result" });
		mod.interactiveSubagentRegistry.set(state.id, state);

		const art = artifactPath(dirname(artifactDir), state.id);
		appendEvent(art, { ts: Date.now() - 100, type: "done", status: "done", exitCode: 0 });

		mod.pollArtifactChanges({} as any);

		const events = readEvents(art);
		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(1);
		expect(state.autoDoneForTurnAt).toBeUndefined();
	});

	it("does NOT synthesize twice (idempotent across repeated polls)", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState({ outputContent: "result" });
		mod.interactiveSubagentRegistry.set(state.id, state);

		mod.pollArtifactChanges({} as any);
		mod.pollArtifactChanges({} as any);
		mod.pollArtifactChanges({} as any);

		const art = artifactPath(dirname(artifactDir), state.id);
		const events = readEvents(art);
		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents).toHaveLength(1);
	});

	it("suppresses duplicate notification if an explicit done arrives after the auto-synthesis", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState({ outputContent: "result" });
		mod.interactiveSubagentRegistry.set(state.id, state);

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);
		const callsAfterAuto = sendMessage.mock.calls.length;
		expect(callsAfterAuto).toBeGreaterThan(0);

		const art = artifactPath(dirname(artifactDir), state.id);
		appendEvent(art, { ts: Date.now(), type: "done", status: "done", exitCode: 0 });

		sendMessage.mockClear();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("a new user message in the session log resets the auto-done guard for the next turn", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState({ outputContent: "result" });
		mod.interactiveSubagentRegistry.set(state.id, state);

		mod.pollArtifactChanges({} as any);
		expect(state.autoDoneForTurnAt).toBeDefined();

		const userMsg = {
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "thanks, also do X" }],
				timestamp: Date.now(),
			},
		};
		writeFileSync(state.sessionFile, JSON.stringify(userMsg) + "\n");

		mod.pollArtifactChanges({} as any);
		expect(state.autoDoneForTurnAt).toBeUndefined();
	});

	it("captures stopReason and lastStopText from real session JSONL tail-read", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state } = makeState({});
		mod.interactiveSubagentRegistry.set(state.id, state);

		state.lastStopReason = undefined;
		state.lastStopReasonAt = undefined;
		state.lastStopText = undefined;

		const ts = Date.now() - 11_000;
		writeAssistantTurn(state.sessionFile, ts, "stop", "Done. Wrote the result.");

		mod.pollArtifactChanges({} as any);

		expect(state.lastStopReason).toBe("stop");
		expect(state.lastStopReasonAt).toBe(ts);
		expect(state.lastStopText).toBe("Done. Wrote the result.");
	});

	it("does NOT capture lastStopText for non-'stop' stopReasons", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state } = makeState({});
		mod.interactiveSubagentRegistry.set(state.id, state);

		state.lastStopReason = undefined;
		state.lastStopText = undefined;

		const ts = Date.now() - 11_000;
		writeAssistantTurn(state.sessionFile, ts, "length", "I hit the token limit.");

		mod.pollArtifactChanges({} as any);

		expect(state.lastStopReason).toBe("length");
		expect(state.lastStopText).toBeUndefined();
	});

	it("a user message in the session log clears the per-turn stop-capture (lastStopReason, lastStopReasonAt, lastStopText)", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state } = makeState({});
		mod.interactiveSubagentRegistry.set(state.id, state);

		// Simulate a prior turn that captured stop-capture state.
		state.lastStopReason = "stop";
		state.lastStopReasonAt = Date.now() - 60_000;
		state.lastStopText = "STALE_TEXT_FROM_PRIOR_TURN";

		// A user follow-up arrives.
		const userTs = Date.now() - 30_000;
		writeFileSync(
			state.sessionFile,
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "do more" }], timestamp: userTs } }) + "\n",
			{ flag: "a" },
		);

		mod.pollArtifactChanges({} as any);

		// All three per-turn fields must be cleared, matching the reset of
		// autoDoneForTurnAt on the same code path.
		const after = mod.interactiveSubagentRegistry.get(state.id) as typeof state;
		expect(after.lastStopReason).toBeUndefined();
		expect(after.lastStopReasonAt).toBeUndefined();
		expect(after.lastStopText).toBeUndefined();
	});

	it("appends a '… (truncated)' marker to the synthesized error when lastStopText exceeds the slice length", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state } = makeState({});
		mod.interactiveSubagentRegistry.set(state.id, state);

		const longText = "X".repeat(1000); // >500 char slice threshold
		const ts = Date.now() - 11_000;
		writeAssistantTurn(state.sessionFile, ts, "stop", longText);

		mod.pollArtifactChanges({} as any);

		const events = readEvents(artifactPath(dirname(state.artifactDir), state.id));
		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		const msg = err && err.type === "error" ? err.message : "";
		expect(msg).toMatch(/… \(truncated\)/);
		expect(msg).toContain("X".repeat(500));
		expect(msg).not.toContain("X".repeat(501)); // slice is exact
	});

	it("does NOT append a '… (truncated)' marker when lastStopText fits within the slice length", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state } = makeState({});
		mod.interactiveSubagentRegistry.set(state.id, state);

		const shortText = "short text that fits in the slice"; // well under 500
		const ts = Date.now() - 11_000;
		writeAssistantTurn(state.sessionFile, ts, "stop", shortText);

		mod.pollArtifactChanges({} as any);

		const events = readEvents(artifactPath(dirname(state.artifactDir), state.id));
		const err = events.find((e) => e.type === "error");
		const msg = err && err.type === "error" ? err.message : "";
		expect(msg).not.toMatch(/… \(truncated\)/);
		expect(msg).toContain(shortText);
	});

	// ─── End-to-end: real session JSONL is the only input ────────────
	// Mirrors the production failure mode seen in 4 silent sub-agents in
	// ~/.pi/agent/sessions/subagentura. The only input to the poller is a
	// session JSONL containing a final assistant turn with stopReason:"stop"
	// — no pre-seeded state, no events.ndjson activity, no `cli.mjs done`.
	// After AUTO_DONE_DEBOUNCE_MS the parent must synthesize a recovery event.

	it("end-to-end (with output): silent sub-agent whose model wrote output.md but never called `cli.mjs done` → auto-done", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeFreshState({ outputContent: "the review findings" });
		mod.interactiveSubagentRegistry.set(state.id, state);

		const stopTs = Date.now() - 11_000;
		writeFileSync(
			state.sessionFile,
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Review complete." }],
					api: "openai",
					provider: "openai",
					model: "gpt-4",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: stopTs,
				},
			}) + "\n",
		);

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		expect(state.lastStopReason).toBe("stop");
		expect(state.lastStopReasonAt).toBe(stopTs);
		const art = artifactPath(dirname(artifactDir), state.id);
		const events = readEvents(art);
		const done = events.find((e) => e.type === "done");
		expect(done).toBeDefined();
		expect(done && done.type === "done" && done.exitCode).toBe(0);
		expect(sendMessage).toHaveBeenCalled();
	});

	it("end-to-end (no output): silent sub-agent whose model wrote to /tmp not output.md → auto-error with lastStopText fallback", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeFreshState({ outputContent: null });
		mod.interactiveSubagentRegistry.set(state.id, state);

		const stopTs = Date.now() - 11_000;
		const summary = "Review complete. The findings file `/tmp/review-sec.md` contains 0 critical vulnerabilities.";
		writeFileSync(
			state.sessionFile,
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: summary }],
					api: "openai",
					provider: "openai",
					model: "gpt-4",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: stopTs,
				},
			}) + "\n",
		);

		mod.pollArtifactChanges({} as any);

		const art = artifactPath(dirname(artifactDir), state.id);
		const events = readEvents(art);
		const err = events.find((e) => e.type === "error");
		expect(err).toBeDefined();
		const msg = err && err.type === "error" ? err.message : "";
		expect(msg).toMatch(/without writing output\.md/);
		expect(msg).toMatch(/review-sec\.md/);
	});

	// ─── Regression guard: replay the real `notdone.jsonl` session ────
	// The model produced a 10K-char audit at t=183s, then sat in the REPL for
	// 4.5 minutes until the parent prompted it with "u didnt make the done".
	// With the fix, auto-done would have fired at t=193s — 4.5 minutes BEFORE
	// the user had to notice and prompt. Skips if the production session is
	// not present (e.g. CI without the local session dir).
	//
	// SAFETY: the production session JSONL is read-only input; the replay
	// runs against a tmp artifactDir. The production dir is never written to.
	it("regression: notdone.jsonl would have auto-recovered the 10K audit at t=193s", async () => {
		const fs = await import("node:fs");
		const sourceSession = "/Users/applesucks/.pi/agent/sessions/subagentura/pi-agents-workflow-impl-ef3eab/2026-06-11T19-25-31-403Z-fb57cd05.jsonl";
		if (!fs.existsSync(sourceSession)) {
			console.warn("skip: real notdone.jsonl not present at", sourceSession);
			return;
		}

		const lines = fs.readFileSync(sourceSession, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		let firstStop: { timestamp: number } | null = null;
		let firstStopText = "";
		for (const e of lines) {
			if (e.type !== "message") continue;
			const m = e.message;
			if (!m || m.role !== "assistant" || m.stopReason !== "stop") continue;
			firstStop = m;
			for (const b of (m.content || [])) {
				if (b.type === "text" && typeof b.text === "string") {
					firstStopText = b.text;
					break;
				}
			}
			break;
		}
		expect(firstStop).not.toBeNull();
		// Non-null assertion: expect().not.toBeNull() narrows at runtime but not in tsc's strict null checks.
		const firstStopNonNull = firstStop as { timestamp: number };
		expect(firstStop).not.toBeNull();
		expect(firstStopText.length).toBeGreaterThan(5000);

		// Replay into a tmp dir, NOT the production artifact dir. The
		// poller computes the artifact via
		//   artifactPath(dirname(state.artifactDir), basename(state.artifactDir))
		// so point state.artifactDir at a fresh tmp leaf and let
		// ensureArtifactDir() create it on first appendEvent.
		const replayRoot = makeTmp();
		const replayId = "notdone-replay";
		const replayArtifactDir = join(replayRoot, replayId);
		const replaySession = join(replayRoot, "session.jsonl");
		fs.writeFileSync(
			replaySession,
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: firstStopText }],
					stopReason: "stop",
					timestamp: firstStopNonNull.timestamp,
				},
			}) + "\n",
		);

		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		mod.interactiveSubagentRegistry.set(replayId, {
			id: replayId,
			name: "notdone.jsonl Replay",
			task: "(replay)",
			paneId: "%1",
			sessionFile: replaySession,
			cwd: "/tmp",
			startedAt: firstStopNonNull.timestamp - 60_000,
			status: "running",
			attachCommand: "n/a",
			selectPaneCommand: "n/a",
			launchScriptFile: "n/a",
			artifactDir: replayArtifactDir,
		});

		mod.pollArtifactChanges({} as any);

		// The poller wrote a synthesized event into the tmp artifact dir.
		const eventsFile = join(replayArtifactDir, "events.ndjson");
		expect(fs.existsSync(eventsFile)).toBe(true);
		const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const err = events.find((e) => e.type === "error");
		expect(err, "expected synthesized error event").toBeDefined();
		const msg = err && err.type === "error" ? err.message : "";
		expect(msg).toMatch(/without writing output\.md/);
		expect(msg).toMatch(/Test Quality Audit Report/);

		// Defensive: confirm we did NOT touch the production dir. If
		// events.ndjson exists there, its mtime must predate this test run.
		const productionArtifactDir = "/Users/applesucks/.pi/agent/sessions/subagentura/pi-agents-workflow-impl-ef3eab/artifacts/fb57cd05";
		const productionEvents = join(productionArtifactDir, "events.ndjson");
		if (fs.existsSync(productionEvents)) {
			const stat = fs.statSync(productionEvents);
			expect(stat.mtimeMs).toBeLessThan(Date.now() - 1000);
		}
	});
});
