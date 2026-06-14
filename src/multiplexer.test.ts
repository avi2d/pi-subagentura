import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

/**
 * Test that `getMux({ preference: "auto" })` can find a backend when the
 * user is NOT inside any mux session but the binary is on PATH.
 *
 * Current bug: `TmuxMultiplexer.isAvailable()` and
 * `ZellijMultiplexer.isAvailable()` both check their respective env vars
 * (`TMUX` / `ZELLIJ`) in ADDITION to binary availability. This means the
 * fallback path in `getMux()` — which is supposed to try "whichever
 * backend is available" when no env var matches — skips BOTH backends
 * because `isAvailable()` returns false even though the binary exists.
 *
 * As a result, `getMux()` throws `NoMultiplexerAvailableError` for users
 * in a plain terminal, even if tmux or zellij is installed. The
 * relaxed-spawn path in `createPane()` (which creates a detached session)
 * is never reached.
 *
 * Fix: `isAvailable()` should check binary availability only. The env-var
 * heuristic lives in `getMux()`'s auto-resolution, not in `isAvailable()`.
 */
describe("getMux relaxed-spawn resolution", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.TMUX;
		delete process.env.ZELLIJ;
		delete process.env.ZELLIJ_SESSION_NAME;
	});

	afterEach(() => {
		process.env = originalEnv;
		vi.doUnmock("node:child_process");
	});

	it("getMux auto returns TmuxMultiplexer when TMUX/ZELLIJ env vars unset but tmux binary exists", async () => {
		// Arrange: mock execFileSync so commandExists("tmux") returns true.
		vi.doMock("node:child_process", () => ({
			execFileSync: (_file: string, args: string[]) => {
				const joined = args.join(" ");
				if (joined.includes("command -v 'tmux'")) return "";
				throw new Error("unexpected exec: " + joined);
			},
		} as unknown as typeof import("node:child_process")));

		const { getMux, __resetMuxInstances } =
			await importFresh<typeof import("./multiplexer")>("./multiplexer");
		__resetMuxInstances();

		// Act
		const mux = getMux({ preference: "auto" });

		// Assert
		expect(mux).toBeDefined();
		expect(mux.name).toBe("tmux");
	});

	it("getMux auto returns ZellijMultiplexer when only the zellij binary exists (relaxed-spawn fallback)", async () => {
		// Regression for the auto-resolution asymmetry: with no env vars set and
		// only zellij on PATH, auto must fall back to zellij (its isAvailable is
		// now binary-only). Previously it threw because zellij.isAvailable()
		// required ZELLIJ === "0".
		vi.doMock("node:child_process", () => ({
			execFileSync: (_file: string, args: string[]) => {
				const joined = args.join(" ");
				if (joined.includes("command -v 'zellij'")) return "";
				if (joined.includes("command -v 'tmux'")) throw new Error("no tmux");
				throw new Error("unexpected exec: " + joined);
			},
		} as unknown as typeof import("node:child_process")));

		const { getMux, __resetMuxInstances } =
			await importFresh<typeof import("./multiplexer")>("./multiplexer");
		__resetMuxInstances();

		const mux = getMux({ preference: "auto" });
		expect(mux.name).toBe("zellij");
	});

	it("getMux throws NoMultiplexerAvailableError when neither binary exists", async () => {
		// Arrange: mock execFileSync so commandExists always throws.
		vi.doMock("node:child_process", () => ({
			execFileSync: () => {
				throw new Error("ENOENT");
			},
		} as unknown as typeof import("node:child_process")));

		const { getMux, __resetMuxInstances } =
			await importFresh<typeof import("./multiplexer")>("./multiplexer");
		__resetMuxInstances();

		// Act & Assert
		expect(() => getMux({ preference: "auto" })).toThrow("No multiplexer available");
	});

	it("getMux explicit preference bypasses all env checks", async () => {
		// Even with no env vars and binary unavailable, explicit preference
		// should return the requested backend (the error comes later at
		// createPane time, not at resolution time).
		vi.doMock("node:child_process", () => ({
			execFileSync: () => {
				throw new Error("ENOENT");
			},
		} as unknown as typeof import("node:child_process")));

		const { getMux, __resetMuxInstances } =
			await importFresh<typeof import("./multiplexer")>("./multiplexer");
		__resetMuxInstances();

		const mux = getMux({ preference: "tmux" });
		expect(mux.name).toBe("tmux");
	});
});
