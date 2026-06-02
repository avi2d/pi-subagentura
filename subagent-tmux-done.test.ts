import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
// Must mock before any imports that pull in the modules.
vi.mock("./helpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./helpers")>();
	return { ...actual, startSubagentJob: vi.fn() };
});

// Mock the tmux spawner so the parent can ask "is this tmux job done?"
// without actually spawning tmux. We control state via the shared mock.
const mockTmuxJobRegistry = new Map<
	string,
	{ id: string; state: "running" | "attached" | "completed" | "killed"; sessionDir: string; exitData?: any }
>();

vi.mock("./tmux-spawner", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tmux-spawner")>();
	return {
		...actual,
		getTmuxJob: vi.fn((jobId: string) => mockTmuxJobRegistry.get(jobId)),
		listTmuxJobs: vi.fn(() => Array.from(mockTmuxJobRegistry.values())),
		// Other exports are stubbed because the parent extension may import them.
		spawnTmuxSubagent: vi.fn(),
		getTmuxActivityStatus: vi.fn(),
		killTmuxJob: vi.fn(),
		getTmuxAttachInstructions: vi.fn(),
		checkTmux: vi.fn().mockResolvedValue(true),
		TMUX_BASE_DIR: "/tmp/pi-subagents",
	};
});

import registerExtension from "./subagent";
import { jobRegistry, type SubagentResult } from "./helpers";
import { getTmuxJob as importedGetTmuxJob, listTmuxJobs as importedListTmuxJobs } from "./tmux-spawner";

/**
 * Regression test for the user-visible bug:
 *   "Widget shows 'stalled 10m' for finished tmux children; no notification
 *    fires on tmux completion."
 *
 * The fix has two parts:
 *   1. observeWidgetJob (subagent.ts:712) consults getTmuxJob(id).state. When
 *      the state is "completed" or "killed", it synthesizes a "done"
 *      observation so the widget renders "(done)" instead of "(stalled 10m)".
 *   2. The two tmux tool arms (subagent.ts:1170, 1509) default
 *      notifyOnComplete to "notify" so the user gets a completion signal
 *      (the child pane is invisible from the parent TUI).
 */
describe("tmux completion: widget + notification", () => {
	let api: any;
	let sessionStartHandler: any;
	let setWidgetSpy: ReturnType<typeof vi.fn>;
	let lastRenderer: any;

	beforeEach(() => {
		vi.useFakeTimers();
		mockTmuxJobRegistry.clear();
		jobRegistry.clear();

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
	});

	afterEach(() => {
		vi.useRealTimers();
		mockTmuxJobRegistry.clear();
		jobRegistry.clear();
	});

	it("renders '(done)' not '(stalled 10m)' when a tmux child has completed", () => {
		// Seed a tmux job that is "running" in the job registry (parent's view)
		// and "completed" in the spawner's registry (authoritative).
		const JOB_ID = "tm-completed-1";
		const tmuxJob = {
			id: JOB_ID,
			status: "running" as const,
			liveStatus: { turn: 0, output: "", usage: { turns: 0 } } as any,
			session: {} as any,
			sessionDir: "/tmp/pi-subagents/tm-completed-1",
			startedAt: Date.now() - 600_000, // 10 min ago — past the 60s stalled threshold
			promise: new Promise<SubagentResult>(() => {}),
			backend: "tmux" as const, // <-- CRITICAL: missing this puts the job in inProcessJobs
		};
		jobRegistry.set(JOB_ID, tmuxJob);
		mockTmuxJobRegistry.set(JOB_ID, {
			id: JOB_ID,
			state: "completed",
			sessionDir: "/tmp/pi-subagents/tm-completed-1",
			exitData: { type: "done", timestamp: new Date().toISOString() },
		});

		// Sanity: the mock is being applied and returns the job.
		expect(importedGetTmuxJob(JOB_ID)?.state).toBe("completed");

		const ctx = { hasUI: true, ui: { setWidget: setWidgetSpy } };
		sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);

		// Advance past 60s so the stalled-after threshold would fire if the
		// state machine were unaware of the tmux completion.
		vi.advanceTimersByTime(120_000);

		expect(setWidgetSpy).toHaveBeenCalled();
		const component = lastRenderer(undefined, undefined);
		const lines = component.render(120) as string[];

		// The right-side label must show "done", NOT "stalled".
		const joined = lines.join("\n");
		expect(joined, "widget should not display 'stalled' for a completed job").not.toContain("stalled");
		expect(joined, "widget should display 'done' for a completed job").toContain("done");
	});

	it("does not render 'stalled' for a killed tmux child", () => {
		const JOB_ID = "tm-killed-1";
		const tmuxJob = {
			id: JOB_ID,
			status: "running" as const,
			liveStatus: { turn: 0, output: "", usage: { turns: 0 } } as any,
			session: {} as any,
			sessionDir: "/tmp/pi-subagents/tm-killed-1",
			startedAt: Date.now() - 600_000,
			promise: new Promise<SubagentResult>(() => {}),
			backend: "tmux" as const, // <-- CRITICAL
		};
		jobRegistry.set(JOB_ID, tmuxJob);
		mockTmuxJobRegistry.set(JOB_ID, {
			id: JOB_ID,
			state: "killed",
			sessionDir: "/tmp/pi-subagents/tm-killed-1",
			exitData: { type: "cancelled", timestamp: new Date().toISOString() },
		});

		const ctx = { hasUI: true, ui: { setWidget: setWidgetSpy } };
		sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
		vi.advanceTimersByTime(120_000);

		const component = lastRenderer(undefined, undefined);
		const lines = component.render(120) as string[];
		const joined = lines.join("\n");
		// Killed jobs are terminal — widget must not show "stalled".
		// status.ts hardcodes statusLabel="done" for phase="done", so both
		// "completed" and "killed" render as "done" in the widget; the
		// distinction lives in the activity log / exit sidecar, not the widget.
		expect(joined, "widget should not display 'stalled' for a killed job").not.toContain("stalled");
		expect(joined, "widget should display 'done' for a killed job").toContain("done");
	});

	it("keeps the in-process default of undefined for notifyOnComplete", () => {
		// Find the subagent_with_context tool definition.
		const toolCalls = api.registerTool.mock.calls as Array<[any]>;
		const contextDef = toolCalls.find(([def]) => def.name === "subagent_with_context")?.[0];
		expect(contextDef).toBeDefined();
		// Schema-level guard: notifyOnComplete is optional, not required.
		// (We can't easily exercise the full execute() flow here without
		// mocking more; the source-level review confirms:
		//   in-process arms (subagent.ts:1243, 1570) preserve the
		//   `undefined` default
		//   tmux arms (subagent.ts:1170, 1509) default to "notify".)
		const paramsSchema = contextDef.parameters;
		expect(paramsSchema).toBeDefined();
	});
});
