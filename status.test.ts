import { describe, it, expect } from "vitest";
import {
	advanceStatusState,
	capStatusLines,
	classifyStatus,
	createStatusState,
	DEFAULT_STATUS_LINE_LIMIT,
	formatElapsedDuration,
	formatStatusLine,
	formatStatusAggregate,
	formatTransitionLine,
	formatWidgetRightLabel,
	forceStatusAfterInterrupt,
	observeStatus,
	SNAPSHOT_STALLED_AFTER_MS,
	type SubagentStatusKind,
	type SubagentStatusState,
} from "./status";

describe("createStatusState", () => {
	it("returns starting for pi source", () => {
		const s = createStatusState({ source: "pi", startTimeMs: 1000 });
		expect(s.currentKind).toBe("starting");
		expect(s.firstObservationAtMs).toBeNull();
		expect(s.lastActivityAtMs).toBeNull();
	});

	it("returns running for claude source (no activity file)", () => {
		const s = createStatusState({ source: "claude", startTimeMs: 1000 });
		expect(s.currentKind).toBe("running");
	});
});

describe("observeStatus", () => {
	it("records first observation timestamp", () => {
		const s = createStatusState({ source: "pi", startTimeMs: 1000 });
		const next = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 2000, sequence: 1, phase: "active" },
			2000,
		);
		expect(next.firstObservationAtMs).toBe(2000);
		expect(next.lastActivityAtMs).toBe(2000);
		expect(next.activeNow).toBe(true);
	});

	it("blocks older observations (replay attack guard)", () => {
		let s = createStatusState({ source: "pi", startTimeMs: 1000 });
		s = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 5000, sequence: 5, phase: "active" },
			5000,
		);
		// Older observation must be ignored
		s = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 3000, sequence: 3, phase: "active" },
			6000,
		);
		expect(s.lastActivityAtMs).toBe(5000);
		expect(s.lastActivitySequence).toBe(5);
	});

	it("marks snapshot state on missing/invalid/wrong-id", () => {
		let s = createStatusState({ source: "pi", startTimeMs: 1000 });
		s = observeStatus(s, { snapshot: "missing" }, 2000);
		expect(s.snapshotState).toBe("missing");
		s = observeStatus(s, { snapshot: "invalid", snapshotError: "bad json" }, 3000);
		expect(s.snapshotState).toBe("invalid");
		expect(s.snapshotError).toBe("bad json");
	});

	it("ignores observations for claude source", () => {
		let s = createStatusState({ source: "claude", startTimeMs: 1000 });
		const next = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 2000, sequence: 1, phase: "active" },
			2000,
		);
		expect(next).toBe(s); // identity preserved
	});

	it("transitions to waiting with waitingSince timestamp", () => {
		let s = createStatusState({ source: "pi", startTimeMs: 1000 });
		s = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 2000, sequence: 1, phase: "waiting", waitingSince: 2000 },
			2000,
		);
		expect(s.phase).toBe("waiting");
		expect(s.waitingSinceMs).toBe(2000);
	});
});

describe("classifyStatus", () => {
	it("starting for fresh state under stalled threshold", () => {
		const s = createStatusState({ source: "pi", startTimeMs: 1000 });
		const snap = classifyStatus(s, 1000 + SNAPSHOT_STALLED_AFTER_MS - 1);
		expect(snap.kind).toBe("starting");
	});

	it("stalled for fresh state over stalled threshold", () => {
		const s = createStatusState({ source: "pi", startTimeMs: 1000 });
		const snap = classifyStatus(s, 1000 + SNAPSHOT_STALLED_AFTER_MS + 1000);
		expect(snap.kind).toBe("stalled");
	});

	it("active when last observation was active", () => {
		let s = createStatusState({ source: "pi", startTimeMs: 1000 });
		s = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 5000, sequence: 1, phase: "active", activeSince: 5000 },
			5000,
		);
		const snap = classifyStatus(s, 6000);
		expect(snap.kind).toBe("active");
		expect(snap.activeSinceMs).toBe(5000);
	});

	it("waiting when last observation was waiting", () => {
		let s = createStatusState({ source: "pi", startTimeMs: 1000 });
		s = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 5000, sequence: 1, phase: "waiting", waitingSince: 5000 },
			5000,
		);
		const snap = classifyStatus(s, 6000);
		expect(snap.kind).toBe("waiting");
	});

	it("clamaude source always returns running", () => {
		const s = createStatusState({ source: "claude", startTimeMs: 1000 });
		const snap = classifyStatus(s, 99999);
		expect(snap.kind).toBe("running");
	});
});

describe("advanceStatusState", () => {
	it("emits stalled transition when crossing into stalled", () => {
		const s = createStatusState({ source: "pi", startTimeMs: 1000 });
		const { nextState, snapshot, transition } = advanceStatusState(
			s,
			1000 + SNAPSHOT_STALLED_AFTER_MS + 1000,
		);
		expect(snapshot.kind).toBe("stalled");
		expect(transition).toBe("stalled");
		expect(nextState.currentKind).toBe("stalled");
	});

	it("emits recovered transition when leaving stalled", () => {
		let s = createStatusState({ source: "pi", startTimeMs: 1000 });
		// Get into stalled
		s = advanceStatusState(s, 1000 + SNAPSHOT_STALLED_AFTER_MS + 1000).nextState;
		// Recover via active observation
		s = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 99999, sequence: 1, phase: "active" },
			99999,
		);
		const { snapshot, transition } = advanceStatusState(s, 100000);
		expect(transition).toBe("recovered");
		expect(snapshot.kind).toBe("active");
	});
});

describe("formatWidgetRightLabel", () => {
	it("starting", () => {
		const s = createStatusState({ source: "pi", startTimeMs: 1000 });
		const snap = classifyStatus(s, 1500);
		expect(formatWidgetRightLabel(snap)).toBe(" starting… ");
	});

	it("running for claude", () => {
		const s = createStatusState({ source: "claude", startTimeMs: 1000 });
		const snap = classifyStatus(s, 5000);
		expect(formatWidgetRightLabel(snap)).toBe(" running 4s ");
	});

	it("active with label + duration", () => {
		const snap = {
			kind: "active" as SubagentStatusKind,
			elapsedMs: 7000,
			elapsedText: "7s",
			activeSinceMs: 5000,
			activeDurationText: "2s",
			activeScope: "tool",
			waitingSinceMs: null,
			waitingDurationText: null,
			latestEvent: "tool_execution_start",
			activityLabel: "read",
			snapshotState: "present" as const,
			snapshotError: null,
			snapshotProblemText: null,
			statusLabel: null,
		};
		expect(formatWidgetRightLabel(snap)).toBe(" active · read 2s ");
	});

	it("waiting", () => {
		const snap = {
			kind: "waiting" as SubagentStatusKind,
			elapsedMs: 5000,
			elapsedText: "5s",
			activeSinceMs: null,
			activeDurationText: null,
			activeScope: null,
			waitingSinceMs: 3000,
			waitingDurationText: "2s",
			latestEvent: null,
			activityLabel: null,
			snapshotState: "present" as const,
			snapshotError: null,
			snapshotProblemText: null,
			statusLabel: null,
		};
		expect(formatWidgetRightLabel(snap)).toBe(" waiting 2s ");
	});

	it("stalled with problem duration", () => {
		const snap = {
			kind: "stalled" as SubagentStatusKind,
			elapsedMs: 70000,
			elapsedText: "1m 10s",
			activeSinceMs: null,
			activeDurationText: null,
			activeScope: null,
			waitingSinceMs: null,
			waitingDurationText: null,
			latestEvent: null,
			activityLabel: null,
			snapshotState: "missing" as const,
			snapshotError: "file not found",
			snapshotProblemText: "65s",
			statusLabel: null,
		};
		expect(formatWidgetRightLabel(snap)).toBe(" stalled 65s ");
	});
});

describe("formatElapsedDuration", () => {
	it("seconds", () => {
		expect(formatElapsedDuration(5_000)).toBe("5s");
	});
	it("minutes", () => {
		// Reference formatter drops seconds in the minutes tier to keep labels compact.
		expect(formatElapsedDuration(65_000)).toBe("1m");
	});
	it("hours", () => {
		expect(formatElapsedDuration(3_700_000)).toBe("1h 1m");
	});
	it("clamps negatives", () => {
		expect(formatElapsedDuration(-1000)).toBe("0s");
	});
});

describe("capStatusLines", () => {
	it("returns first N and overflow count", () => {
		const lines = ["a", "b", "c", "d", "e"];
		const { visibleLines, overflow } = capStatusLines(lines, 3);
		expect(visibleLines).toEqual(["a", "b", "c"]);
		expect(overflow).toBe(2);
	});

	it("no overflow when lineLimit >= length", () => {
		const { visibleLines, overflow } = capStatusLines(["a", "b"], 5);
		expect(visibleLines).toEqual(["a", "b"]);
		expect(overflow).toBe(0);
	});
});

describe("formatStatusAggregate", () => {
	it("renders bullets and overflow indicator", () => {
		const lines = Array.from({ length: 6 }, (_, i) => `job-${i}`);
		const out = formatStatusAggregate(lines, DEFAULT_STATUS_LINE_LIMIT);
		const outLines = out.split("\n");
		expect(outLines[0]).toBe("Subagent status:");
		expect(outLines[1]).toBe("• job-0");
		expect(outLines[4]).toBe("• job-3");
		expect(outLines[5]).toBe("• +2 more running.");
	});
});

describe("formatStatusLine", () => {
	it("formats an active line with label", () => {
		const snap = {
			kind: "active" as SubagentStatusKind,
			elapsedMs: 7000,
			elapsedText: "7s",
			activeSinceMs: 5000,
			activeDurationText: "2s",
			activeScope: "tool",
			waitingSinceMs: null,
			waitingDurationText: null,
			latestEvent: null,
			activityLabel: "bash",
			snapshotState: "present" as const,
			snapshotError: null,
			snapshotProblemText: null,
			statusLabel: null,
		};
		const line = formatStatusLine("Scout", snap);
		expect(line).toContain("Scout");
		expect(line).toContain("running 7s");
		expect(line).toContain("active (bash 2s)");
	});
});

describe("formatTransitionLine", () => {
	it("formats recovered transition", () => {
		const snap = {
			kind: "active" as SubagentStatusKind,
			elapsedMs: 7000,
			elapsedText: "7s",
			activeSinceMs: 5000,
			activeDurationText: "2s",
			activeScope: "tool",
			waitingSinceMs: null,
			waitingDurationText: null,
			latestEvent: null,
			activityLabel: "read",
			snapshotState: "present" as const,
			snapshotError: null,
			snapshotProblemText: null,
			statusLabel: null,
		};
		const line = formatTransitionLine("Scout", snap, "recovered");
		expect(line).toContain("Scout");
		expect(line).toContain("recovered");
	});
});

describe("forceStatusAfterInterrupt", () => {
	it("moves to waiting with interrupt label", () => {
		let s = createStatusState({ source: "pi", startTimeMs: 1000 });
		s = observeStatus(
			s,
			{ snapshot: "present", updatedAt: 5000, sequence: 1, phase: "active" },
			5000,
		);
		const forced = forceStatusAfterInterrupt(s, 6000);
		expect(forced.phase).toBe("waiting");
		expect(forced.activeNow).toBe(false);
		expect(forced.activityLabel).toBe("interrupted");
		expect(forced.waitingSinceMs).toBe(6000);
	});
});
