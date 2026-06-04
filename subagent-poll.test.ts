import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, artifactPath } from "./artifact";

/**
 * The artifact-driven poller fires pointer notifications for new events on
 * interactive sub-agents. Tests reset the global pi ref + registry, then write
 * events directly to the artifact dir to drive the poller.
 */

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagentura-poll-"));
}

function makeState(overrides: { notifyOnUpdate?: "off" | "milestones" | "all" }): {
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
		notifyOnUpdate: overrides.notifyOnUpdate,
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

	it("does nothing when no sub-agents have notifyOnUpdate set", async () => {
		const mod = await importFresh();
		const { state } = makeState({});
		mod.interactiveSubagentRegistry.set(state.id, state);

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("does nothing when mode is 'off' even with events present", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "off" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		// Write some events to the artifact
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).not.toHaveBeenCalled();
		// cursor not advanced either
		expect(state.lastDeliveredEventTs).toBeUndefined();
	});

	it("fires a pointer notification on a milestone event (mode: milestones)", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "milestones" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		expect(sendMessage).toHaveBeenCalledTimes(2); // started + done
		const calls = sendMessage.mock.calls;
		expect(calls[0][0][0].customType).toBe("subagent-notify");
		expect(calls[0][0][0].content).toContain("started");
		expect(calls[1][0][0].content).toContain("done");
		expect(calls[1][0][0].content).toContain("Artifact:");
		expect(calls[1][0][0].content).toContain(`read_subagent_artifact`);
		// cursor advanced
		expect(state.lastDeliveredEventTs).toBe(2);
	});

	it("does NOT fire on wip/output_updated under milestones mode", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "milestones" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "wip", status: "wip", message: "thinking" });
		appendEvent(art, { ts: 3, type: "output_updated", status: "running" });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		// Only the started event should fire (wip + output_updated are skipped in milestones)
		expect(sendMessage).toHaveBeenCalledTimes(1);
		// But the cursor still advances past wip/output_updated so they aren't re-delivered
		expect(state.lastDeliveredEventTs).toBe(3);
	});

	it("fires on wip under 'all' mode", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "all" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "wip", status: "wip", message: "step 1" });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(sendMessage.mock.calls[1][0][0].content).toContain("wip");
		expect(sendMessage.mock.calls[1][0][0].content).toContain("step 1");
	});

	it("is at-most-once per event (cursor advances)", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "milestones" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).toHaveBeenCalledTimes(2);

		// Second poll: no new events, no new notifications.
		sendMessage.mockClear();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("delivers only events newer than lastDeliveredEventTs (backlog catch-up)", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "milestones" });
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
		expect(sendMessage.mock.calls[0][0][0].content).toContain("done");
		expect(sendMessage.mock.calls[1][0][0].content).toContain("cancelled");
		// cursor advanced to the latest
		expect(state.lastDeliveredEventTs).toBe(3);
	});

	it("marks the sub-agent as exited when a done event is seen", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "milestones" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

		mod.pollArtifactChanges({} as any);
		expect(state.status).toBe("exited");
		expect(state.exitCode).toBe(0);
	});

	it("marks the sub-agent as cancelled when a cancelled event is seen", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "off" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });

		mod.pollArtifactChanges({} as any);
		expect(state.status).toBe("cancelled");
	});

	it("skips sub-agents that are not in 'running' status", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "milestones" });
		state.status = "cancelled";
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);
		expect(sendMessage).not.toHaveBeenCalled();
	});
});

async function importFresh() {
	vi.resetModules();
	return import("./subagent");
}
