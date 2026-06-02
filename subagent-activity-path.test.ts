import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist: startSubagentJob must be mocked before subagent.ts loads
vi.mock("./helpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./helpers")>();
	return { ...actual, startSubagentJob: vi.fn() };
});

// Capture what paths the widget tries to read
const readCalls: string[] = [];
vi.mock("./activity", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./activity")>();
	return {
		...actual,
		readSubagentActivityFile: vi.fn((p: string, _id: string) => {
			readCalls.push(p);
			return { ok: false, reason: "missing" } as any;
		}),
	};
});

import registerExtension from "./subagent";
import { jobRegistry } from "./helpers";
import * as path from "node:path";

/**
 * Regression test for the subagent.ts:893 path-construction hardening.
 *
 * Before the fix, the line was:
 *   wj.activityFile = `${entry.job.sessionDir}/subagent-activity/${id}.json`;
 *
 * Two failure modes were possible:
 *   1. If `sessionDir` were ever undefined for a tmux job, the path would
 *      become the literal string "undefined/subagent-activity/<id>.json".
 *   2. The hardcoded "/" separator breaks on Windows.
 *
 * The fix uses `path.join` and guards against undefined sessionDir.
 */
describe("activityFile path construction (subagent.ts:893)", () => {
	let api: any;
	let sessionStartHandler: any;
	let ctx: any;
	let setWidgetSpy: ReturnType<typeof vi.fn>;
	let lastRenderer: any;

	beforeEach(() => {
		readCalls.length = 0;
		vi.useFakeTimers();
		setWidgetSpy = vi.fn((_name: string, renderer: any) => {
			lastRenderer = renderer;
		});
		api = {
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			sendMessage: vi.fn(),
			sendUserMessage: vi.fn(),
			on: vi.fn((event: string, handler: any) => {
				if (event === "session_start") sessionStartHandler = handler;
			}),
			registerCommand: vi.fn(),
		};
		registerExtension(api as any);
		ctx = { hasUI: true, ui: { setWidget: setWidgetSpy } };
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const render = () => {
		sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
		const component = lastRenderer(undefined, undefined);
		// First render populates widgetJobs and starts statusInterval
		component.render(80);
		// Advance fake clock to fire the 1s statusInterval, which calls
		// tickAllJobs → observeWidgetJob → readSubagentActivityFile
		vi.advanceTimersByTime(1500);
		component.render(80);
	};

	it("uses path.join (cross-platform) when sessionDir is set", () => {
		const tmuxJob = {
			id: "tm-path-ok",
			status: "running" as const,
			liveStatus: {} as any,
			session: {} as any,
			sessionDir: "/tmp/pi-subagents/sessions",
			startedAt: Date.now(),
			promise: Promise.resolve({} as any),
			backend: "tmux" as const,
		};
		jobRegistry.set(tmuxJob.id, tmuxJob);
		try {
			render();
			const expected = path.join("/tmp/pi-subagents/sessions", "subagent-activity", "tm-path-ok.json");
			expect(readCalls).toContain(expected);
			// Must NOT contain the hardcoded "/" between sessionDir and subagent-activity
			expect(readCalls.some((p) => p.startsWith("/tmp/pi-subagents/sessions/subagent-activity/"))).toBe(true);
		} finally {
			jobRegistry.delete(tmuxJob.id);
		}
	});

	it("does NOT produce literal 'undefined/subagent-activity/...' when sessionDir is missing", () => {
		// TmuxJobState.sessionDir is optional. Even though the single
		// registration call in tmux-spawner.ts:236 always sets it, the type
		// allows undefined — and any future code path that registers a tmux
		// job without one must not produce a bad path.
		const tmuxJob = {
			id: "tm-no-dir",
			status: "running" as const,
			liveStatus: {} as any,
			session: {} as any,
			// sessionDir intentionally absent
			startedAt: Date.now(),
			promise: Promise.resolve({} as any),
			backend: "tmux" as const,
		};
		jobRegistry.set(tmuxJob.id, tmuxJob);
		try {
			render();
			expect(readCalls).not.toContain("undefined/subagent-activity/tm-no-dir.json");
			// The widget should not have tried to read *any* path for this
			// job (activityFile is undefined → reader not invoked).
			expect(readCalls).toEqual([]);
		} finally {
			jobRegistry.delete(tmuxJob.id);
		}
	});

	it("in-process jobs use virtualActivity and never set activityFile", () => {
		const ipJob = {
			id: "ip-no-activity-file",
			status: "running" as const,
			liveStatus: { usage: { turns: 1 } } as any,
			session: {} as any,
			startedAt: Date.now(),
			promise: Promise.resolve({} as any),
		};
		jobRegistry.set(ipJob.id, ipJob);
		try {
			render();
			// In-process path: no activity file read should occur
			expect(readCalls).toEqual([]);
		} finally {
			jobRegistry.delete(ipJob.id);
		}
	});
});
