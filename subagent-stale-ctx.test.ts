import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock: startSubagentJob must be mocked before any imports ──────
vi.mock("./helpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./helpers")>();
	return { ...actual, startSubagentJob: vi.fn() };
});

import registerExtension from "./subagent";

/**
 * Regression test: when a session is replaced (e.g. /new), the recurring
 * widget refresh timer must NOT crash pi by accessing the now-stale ctx.
 *
 * Original error:
 *   pi exiting due to uncaughtException:
 *   Error: This extension ctx is stale after session replacement or reload.
 *     at Timeout.scheduleWidgetUpdate (subagent.ts:678)
 */
describe("widget refresh survives session replacement", () => {
	let api: any;
	let sessionStartHandler: any;
	let sessionShutdownHandler: any;
	let setWidgetSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		setWidgetSpy = vi.fn();
		api = {
			registerTool: vi.fn(),
			registerMessageRenderer: vi.fn(),
			sendMessage: vi.fn(),
			sendUserMessage: vi.fn(),
			on: vi.fn(),
			registerCommand: vi.fn(),
		};
		registerExtension(api as any);

		// The extension registers one on() call per event it subscribes to.
		// Find the session_start and session_shutdown handlers.
		const onCalls = api.on.mock.calls as Array<[string, any]>;
		for (const [event, handler] of onCalls) {
			if (event === "session_start") sessionStartHandler = handler;
			if (event === "session_shutdown") sessionShutdownHandler = handler;
		}
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers session_start and session_shutdown handlers", () => {
		expect(sessionStartHandler).toBeTypeOf("function");
		expect(sessionShutdownHandler).toBeTypeOf("function");
	});

	it("schedules the widget refresh on session_start and renders once per second", () => {
		const ctx = {
			hasUI: true,
			ui: { setWidget: setWidgetSpy },
		};

		sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);

		// First tick fires immediately inside session_start via scheduleWidgetUpdate()
		expect(setWidgetSpy).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1000);
		expect(setWidgetSpy).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(1000);
		expect(setWidgetSpy).toHaveBeenCalledTimes(3);
	});

	it("stops the widget refresh and does not throw when the captured ctx becomes stale after session_shutdown", () => {
		const ctx = {
			hasUI: true,
			ui: { setWidget: setWidgetSpy },
		};

		sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
		expect(setWidgetSpy).toHaveBeenCalledTimes(1);

		// Simulate /new: emit session_shutdown, then invalidate the ctx
		sessionShutdownHandler({
			type: "session_shutdown",
			reason: "new",
		});

		// From this point on, accessing ctx.hasUI / ctx.ui must throw (pi's contract)
		Object.defineProperty(ctx, "hasUI", {
			get() {
				throw new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			},
		});
		Object.defineProperty(ctx, "ui", {
			get() {
				throw new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			},
		});

		// Advance well past the previously scheduled tick. Before the fix this
		// would throw "ctx is stale" from inside the timer callback, propagating
		// as an uncaughtException and crashing pi.
		expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();

		// No further widget renders should have happened after shutdown.
		expect(setWidgetSpy).toHaveBeenCalledTimes(1);
	});

	it("cleans up on session_shutdown even when no widget is rendered (no UI)", () => {
		const ctx = {
			hasUI: false,
			ui: { setWidget: setWidgetSpy },
		};

		sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
		sessionShutdownHandler({
			type: "session_shutdown",
			reason: "reload",
		});

		expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
	});
});
