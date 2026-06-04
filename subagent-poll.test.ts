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

	it("fires a pointer notification on done (mode: milestones). Started is silent.", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "milestones" });
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
		// New pointer format: paths, not a tool-call hint.
		expect(call.content).toContain("Output:");
		expect(call.content).toContain("Activity log:");
		expect(call.content).not.toContain("read_subagent_artifact");
		// cursor still advances to 2 even though only 1 was delivered
		expect(state.lastDeliveredEventTs).toBe(2);
	});

	it("does NOT fire on wip/output_updated/tool_activity/started under milestones mode", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "milestones" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "wip", status: "wip", message: "thinking" });
		appendEvent(art, { ts: 3, type: "output_updated", status: "running" });
		appendEvent(art, { ts: 4, type: "tool_activity", status: "running", tool: "bash", summary: "rg TODO src/" });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		// All four are silent in milestones mode.
		expect(sendMessage).not.toHaveBeenCalled();
		// But the cursor still advances past them so they aren't re-delivered.
		expect(state.lastDeliveredEventTs).toBe(4);
	});

	it("fires on wip under 'all' mode, but still skips started and tool_activity", async () => {
		const mod = await importFresh();
		const { state, artifactDir } = makeState({ notifyOnUpdate: "all" });
		mod.interactiveSubagentRegistry.set(state.id, state);
		const art = artifactPath(join(artifactDir, ".."), state.id);
		appendEvent(art, { ts: 1, type: "started", status: "running" });
		appendEvent(art, { ts: 2, type: "wip", status: "wip", message: "step 1" });
		appendEvent(art, { ts: 3, type: "tool_activity", status: "running", tool: "bash", summary: "rg TODO" });

		const sendMessage = vi.fn();
		mod.pollArtifactChanges({ sendMessage } as any);

		// Only the wip fires. started + tool_activity are silent even in 'all' mode.
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0][0].content).toContain("wip");
		expect(sendMessage.mock.calls[0][0].content).toContain("step 1");
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
		// Only done fires (started is silent).
		expect(sendMessage).toHaveBeenCalledTimes(1);

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
		expect(sendMessage.mock.calls[0][0].content).toContain("done");
		expect(sendMessage.mock.calls[1][0].content).toContain("cancelled");
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
