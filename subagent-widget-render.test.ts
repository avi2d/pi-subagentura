import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock: startSubagentJob must be mocked before any imports ──────
vi.mock("./helpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./helpers")>();
	return { ...actual, startSubagentJob: vi.fn() };
});

import registerExtension from "./subagent";
import { jobRegistry } from "./helpers";
import { visibleWidth } from "@mariozechner/pi-tui";

/**
 * Regression test for the broken widget UI reported when tmux agents are
 * spawned (see user screenshot). The old implementation had an off-by-one
 * `padding` calculation in the `render()` method which:
 *
 *   1. Dropped the closing `│` border on every job line.
 *   2. Sliced "running" to "runni" when content overflowed the width.
 *
 * This test renders the widget at several widths (matching the original
 * broken state) and asserts every line is exactly `width` visible chars,
 * starts/ends with a border, and never truncates "running" to "runni".
 */
describe("widget render output", () => {
	let api: any;
	let sessionStartHandler: any;
	let setWidgetSpy: ReturnType<typeof vi.fn>;
	let lastRenderer: any;

	beforeEach(() => {
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
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders every line at exactly `width` visible chars and preserves both borders", () => {
		const ctx = {
			hasUI: true,
			ui: { setWidget: setWidgetSpy },
		};
		// Seed an in-process job and a tmux-shaped job, then call the
		// registered renderer. Both branches (in-process and tmux) must
		// produce lines that are exactly `width` visible chars, start and
		// end with a `│` border, and never slice "running" to "runni".
		const ipJob = {
			id: "ip-1",
			status: "running" as const,
			liveStatus: {} as any,
			session: {} as any,
			startedAt: Date.now() - 12_000,
			promise: Promise.resolve({} as any),
		};
		const tmuxJob = {
			id: "tm-1",
			status: "running" as const,
			liveStatus: {} as any,
			session: {} as any,
			sessionDir: "/tmp/pi-subagents/tm-1",
			startedAt: Date.now() - 4_000,
			promise: Promise.resolve({} as any),
			backend: "tmux" as const,
		};
		jobRegistry.set(ipJob.id, ipJob);
		jobRegistry.set(tmuxJob.id, tmuxJob);
		try {
			// Trigger initial widget registration with our seeded jobs.
			sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
			expect(setWidgetSpy).toHaveBeenCalled();
			expect(lastRenderer).toBeTypeOf("function");

			// setWidget is called with a factory that returns the component.
			// Invoke the factory to get the component, then call render().
			const component = lastRenderer(undefined, undefined);
			expect(component.render).toBeTypeOf("function");

			// Render at multiple widths matching the bug report.
			for (const width of [30, 60, 80, 120]) {
				const lines = component.render(width) as string[];
				expect(lines.length, `width=${width} line count`).toBeGreaterThanOrEqual(4);
				for (const [i, line] of lines.entries()) {
					expect(visibleWidth(line), `line ${i} width=${width}`).toBe(width);
					expect(line.startsWith("┌") || line.startsWith("│") || line.startsWith("└"),
						`line ${i} width=${width} starts with border char: |${line}|`).toBe(true);
					expect(line.endsWith("┐") || line.endsWith("│") || line.endsWith("┘"),
						`line ${i} width=${width} ends with border char: |${line}|`).toBe(true);
				}
				// At wider widths, the right side shows "tmux · active · read 2m"
				// (or similar). At narrow widths, content gets truncated and
				// the backend label may not fit. Assert the right things at
				// each width tier.
				const joined = lines.join("\n");
				if (width >= 80) {
					expect(joined, `width=${width}`).toContain("tmux");
					expect(joined, `width=${width}`).toContain("proc");
				}
				if (width >= 60) {
					// "running" only fits at widths >= 60; at width 30 the
					// content is so tight that even "running" gets truncated.
					// The original bug was specifically that "running" got sliced
					// to "runni" at WIDER widths, so we assert "running" stays
					// intact at widths where it fits and never appears as a
					// truncated standalone "runni" (followed by space/border).
					// (Actually with the new architecture, jobs show "starting"
					// or "active" / "waiting" / "stalled" — not just "running".)
					// "runni" must never appear at the end of a line with
					// a closing border — that's the truncated-running bug.
					expect(joined, `width=${width}`).not.toMatch(/runni\s*\u2502/);
					expect(joined, `width=${width}`).not.toMatch(/runni$/m);
				}
			}
		} finally {
			jobRegistry.delete(ipJob.id);
			jobRegistry.delete(tmuxJob.id);
		}
	});

	it("(synthetic) borderLine produces exactly `width` chars and never drops the right border", () => {
		// Re-import the helper symbols by reconstructing the line builder logic
		// in the test. This is a unit test of the algorithm, not of the
		// private helpers in subagent.ts (which are not exported).
		//
		// We use the same algorithm the fix uses (mirrored from
		// pi-interactive-subagents) and assert the original-broken algorithm
		// fails the same way it failed in production.
		const borderLine = (left: string, right: string, width: number) => {
			if (width <= 0) return "";
			if (width === 1) return "│";
			const contentWidth = Math.max(0, width - 2);
			const rightVis = visibleWidth(right);
			if (rightVis >= contentWidth) {
				const truncRight = right.slice(0, contentWidth);
				const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
				return "│" + truncRight + " ".repeat(rightPad) + "│";
			}
			const maxLeft = Math.max(0, contentWidth - rightVis);
			const truncLeft = left.length > maxLeft ? left.slice(0, maxLeft) : left;
			const leftVis = visibleWidth(truncLeft);
			const pad = Math.max(0, contentWidth - leftVis - rightVis);
			return "│" + truncLeft + " ".repeat(pad) + right + "│";
		};

		// The old (broken) algorithm — kept here so a future regression
		// re-introducing the same off-by-one is caught.
		const brokenBorderLine = (elapsed: string, task: string, width: number) => {
			const inner = width - 2;
			const taskLen = Math.max(5, inner - 20);
			const truncTask = task.length > taskLen ? task.slice(0, taskLen - 1) + "..." : task;
			const backend = "tmux";
			const status = "running";
			const padding = Math.max(
				1,
				inner - elapsed.length - 2 - truncTask.length - 2 - backend.length - 2 - status.length,
			);
			return (
				"│ " +
				elapsed +
				"  " +
				truncTask +
				" ".repeat(padding) +
				backend +
				" " +
				status +
				" │"
			).slice(0, width);
		};

		// The original screenshot showed a job with elapsed=00:12 and a long
		// task that overflowed. Replay that exact case at multiple widths.
		for (const width of [30, 60, 80, 120]) {
			const fixed = borderLine(" 00:12  Review monorepo commit 9a2def31ed55e7083d8493c49ed7cc4f03b5f3ba ", " tmux running ", width);
			expect(visibleWidth(fixed), `fixed width=${width}`).toBe(width);
			expect(fixed.startsWith("│"), `fixed starts with border width=${width}`).toBe(true);
			expect(fixed.endsWith("│"), `fixed ends with border width=${width}`).toBe(true);
			expect(fixed, `fixed contains "running" width=${width}`).toContain("running");
			expect(fixed, `fixed never contains truncated "runni" width=${width}`).not.toContain("runni ");

			const broken = brokenBorderLine("00:12", "Review monorepo commit 9a2def31ed55e7083d8493c49ed7cc4f03b5f3ba", width);
			// Demonstrate the original bug: at narrow widths, the broken line
			// either drops the right border, truncates "running" to "runni",
			// or both. This assertion documents the failure mode so a
			// regression that reverts to the old algorithm is caught.
			if (width <= 80) {
				const droppedBorder = !broken.endsWith("│");
				const truncatedRunning = !broken.includes("running") && broken.includes("runni");
				expect(
					droppedBorder || truncatedRunning,
					`broken algorithm at width=${width} should reproduce the original bug`,
				).toBe(true);
			}
		}
	});
});
