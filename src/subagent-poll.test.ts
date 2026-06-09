/**
 * The artifact-driven poller fires pointer notifications for new events on
 * interactive sub-agents. Tests reset the global pi ref + registry, then write
 * events directly to the artifact dir to drive the poller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, artifactPath, writeOutput } from "./artifact";
import { importFresh } from "./test-utils";
function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagentura-poll-"));
}

function makeState(): {
	id: string;
	artifactDir: string;
	state: import("./interactive-tmux").InteractiveSubagentState;
} {
	const id = "id-" + Math.random().toString(36).slice(2, 8);
	const artifactDir = join(makeTmp(), id);
	const state: import("./interactive-tmux").InteractiveSubagentState = {
		id,
		name: "Test",
		task: "t",
		paneId: "%99",
		sessionFile: "/tmp/sess.jsonl",
		cwd: "/tmp",
		startedAt: Date.now(),
		status: "running",
		attachCommand: "tmux attach -t sess",
		selectPaneCommand: "tmux select-pane -t '%99'",
		launchScriptFile: "/tmp/launch.sh",
		artifactDir,
	};
	return { id, artifactDir, state };
}

describe("pollArtifactChanges", () => {
	beforeEach(() => {
		const g = globalThis as any;
		g.__piSubagenturaInteractiveRegistry?.clear?.();
		g.__piSubagenturaPiRef = undefined;
	});

	afterEach(() => {
		vi.doUnmock("node:child_process");
	});

	it("does nothing when registry is empty", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("fires a pointer notification on done. Started is silent.", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState();
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		// Only done fires. started is silent (widget shows it).
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const call = sendMessage.mock.calls[0][0];
		expect(call.customType).toBe("subagent-notify");
		expect(call.content).toContain("done");
		// Pointer format: paths, not a tool-call hint.
		expect(call.content).toContain("Output:");
		expect(call.content).toContain("Activity log:");
		expect(call.content).not.toContain("read_subagent_artifact");
		// cursor still advances to 2 even though only 1 was delivered
		expect(state.lastDeliveredEventTs).toBe(2);
	});

	it("does NOT fire on tool_activity/started", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState();
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "tool_activity", status: "running", tool: "bash", summary: "rg TODO src/" });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		// Both are silent (started → TUI widget row; tool_activity → TUI widget only).
		expect(sendMessage).not.toHaveBeenCalled();
		// But the cursor still advances past them so they aren't re-delivered.
		expect(state.lastDeliveredEventTs).toBe(2);
	});

	it("fires on error and cancelled too", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState();
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "error", status: "error", message: "boom" });
		appendEvent(art, { ts: 3, type: "cancelled", status: "cancelled" });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(sendMessage.mock.calls[0][0].content).toContain("error");
		expect(sendMessage.mock.calls[1][0].content).toContain("cancelled");
	});

	it("is at-most-once per event (cursor advances)", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState();
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);
		// Only done fires (started is silent).
		expect(sendMessage).toHaveBeenCalledTimes(1);

		// Second poll: no new events, no new notifications.
		sendMessage.mockClear();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("delivers only events newer than lastDeliveredEventTs (backlog catch-up)", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState();
		// Simulate a sub-agent that finished while the parent was down — events
		// were already on disk before this poller started.
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
		appendEvent(art, { ts: 3, type: "cancelled", status: "cancelled" });
		mod.interactiveSubagentRegistry.set(state.id, state);

		// Pretend the parent already saw events up to ts=1 (e.g. last session
		// before a restart).
		state.lastDeliveredEventTs = 1;

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		// Should deliver done + cancelled, not started.
		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(sendMessage.mock.calls[0][0].content).toContain("done");
		expect(sendMessage.mock.calls[1][0].content).toContain("cancelled");
		// cursor advanced to the latest
		expect(state.lastDeliveredEventTs).toBe(3);
	});

	it("marks the sub-agent as exited when a done event is seen", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState();
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

		mod.pollArtifactChanges({} as any);
		expect(state.status).toBe("exited");
		expect(state.exitCode).toBe(0);
	});

	it("marks the sub-agent as cancelled when a cancelled event is seen", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState();
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });

		mod.pollArtifactChanges({} as any);
		expect(state.status).toBe("cancelled");
	});

	it("skips sub-agents that are not in 'running' status", async () => {
		const mod = await importFresh<typeof import("./subagent")>("./subagent");
		const { state, artifactDir } = makeState();
		state.status = "cancelled";
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	// Inject-mode tests: when a sub-agent is spawned with notifyOnComplete:
	// "inject" and finishes with a `done` event, the poller also calls
	// pi.sendUserMessage with output.md so the parent LLM processes it in its
	// next turn. Mirrors the async subagent's inject delivery.
	describe("inject mode for interactive sub-agents", () => {
		beforeEach(() => {
			(globalThis as any).__piSubagenturaInjectCount = 0;
		});

		it("calls sendUserMessage with output.md on done when state.notifyOnComplete === 'inject'", async () => {
			const mod = await importFresh<typeof import("./subagent")>("./subagent");
			const { state, artifactDir } = makeState();
			state.notifyOnComplete = "inject";
			mod.interactiveSubagentRegistry.set(state.id, state);
			const art = artifactPath(join(artifactDir, ".."), state.id);
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
			writeOutput(art, "the sub-agent's final answer");

			const sendMessage = vi.fn();
			const sendUserMessage = vi.fn();
			mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

			// Both the pointer notification and the inject fire.
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendUserMessage).toHaveBeenCalledTimes(1);
			const [userContent, userOpts] = sendUserMessage.mock.calls[0];
			expect(userContent).toBe("the sub-agent's final answer");
			expect(userOpts).toMatchObject({ deliverAs: "followUp" });
			// At-most-once guard flipped.
			expect(state.injected).toBe(true);
		});

		it("does NOT call sendUserMessage when state.notifyOnComplete is unset (default: notify)", async () => {
			const mod = await importFresh<typeof import("./subagent")>("./subagent");
			const { state, artifactDir } = makeState();
			mod.interactiveSubagentRegistry.set(state.id, state);
			const art = artifactPath(join(artifactDir, ".."), state.id);
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
			writeOutput(art, "should not be injected");

			const sendMessage = vi.fn();
			const sendUserMessage = vi.fn();
			mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

			// Pointer fires; inject does not.
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(state.injected).toBeUndefined();
		});

		it("does NOT call sendUserMessage when state.notifyOnComplete === 'notify' (explicit)", async () => {
			const mod = await importFresh<typeof import("./subagent")>("./subagent");
			const { state, artifactDir } = makeState();
			state.notifyOnComplete = "notify";
			mod.interactiveSubagentRegistry.set(state.id, state);
			const art = artifactPath(join(artifactDir, ".."), state.id);
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
			writeOutput(art, "should not be injected");

			const sendMessage = vi.fn();
			const sendUserMessage = vi.fn();
			mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendUserMessage).not.toHaveBeenCalled();
		});

		it("is at-most-once: a second poll does NOT re-inject (state.injected guard)", async () => {
			const mod = await importFresh<typeof import("./subagent")>("./subagent");
			const { state, artifactDir } = makeState();
			state.notifyOnComplete = "inject";
			mod.interactiveSubagentRegistry.set(state.id, state);
			const art = artifactPath(join(artifactDir, ".."), state.id);
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
			writeOutput(art, "the answer");

			const sendMessage = vi.fn();
			const sendUserMessage = vi.fn();
			mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
			expect(sendUserMessage).toHaveBeenCalledTimes(1);

			// Second poll: no new events (cursor advanced), inject is gated by state.injected.
			sendMessage.mockClear();
			sendUserMessage.mockClear();
			mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
			expect(sendMessage).not.toHaveBeenCalled();
			expect(sendUserMessage).not.toHaveBeenCalled();
		});

		it("does not call sendUserMessage when output.md is missing", async () => {
			const mod = await importFresh<typeof import("./subagent")>("./subagent");
			const { state, artifactDir } = makeState();
			state.notifyOnComplete = "inject";
			mod.interactiveSubagentRegistry.set(state.id, state);
			const art = artifactPath(join(artifactDir, ".."), state.id);
			appendEvent(art, { ts: 1, type: "started", status: "running" });
			appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
			// Intentionally NOT writing output.md

			const sendMessage = vi.fn();
			const sendUserMessage = vi.fn();
			mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

			// output.md missing: inject is skipped, but the state is still marked injected
			// to prevent re-attempts on later polls.
			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(state.injected).toBe(true);
		});
	});
});

