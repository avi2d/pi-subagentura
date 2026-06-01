import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

// ── Hoisted env vars - must be set BEFORE importing tmux-child ──────────
// vi.hoisted runs before module evaluation, so we must set up the temp dir
// here using require() since imports are not yet available.
const HOISTED = vi.hoisted(() => {
	const fs = require("node:fs") as typeof import("node:fs");
	const path = require("node:path") as typeof import("node:path");
	const os = require("node:os") as typeof import("node:os");
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-child-test-"));
	process.env.PI_SUBAGENT = "1";
	process.env.PI_SUBAGENT_SESSION_DIR = tmpDir;
	process.env.PI_SUBAGENT_ID = "test-job-123";
	process.env.PI_SUBAGENT_CONTEXT_MODE = "isolated";
	return {
		TEST_SESSION_DIR: tmpDir,
		TEST_JOB_ID: "test-job-123",
		EXIT_FILE: path.join(tmpDir, "exit.json"),
		ACTIVITY_FILE: path.join(tmpDir, "activity.json"),
	};
});

const TEST_SESSION_DIR = HOISTED.TEST_SESSION_DIR;
const TEST_JOB_ID = HOISTED.TEST_JOB_ID;
const EXIT_FILE = HOISTED.EXIT_FILE;
const ACTIVITY_FILE = HOISTED.ACTIVITY_FILE;

// ── Imports (resolved after env vars are set) ────────────────────────────
import * as fs from "node:fs";
import { isTmuxChildMode, getTmuxChildConfig } from "./tmux-child";
import { peekExitSidecar } from "./tmux-session";

// ── Test fixtures ────────────────────────────────────────────────────────────

function cleanSessionDir() {
	try {
		if (fs.existsSync(EXIT_FILE)) fs.unlinkSync(EXIT_FILE);
		if (fs.existsSync(ACTIVITY_FILE)) fs.unlinkSync(ACTIVITY_FILE);
	} catch {
		// Ignore
	}
}

/** Build a mock ExtensionAPI that captures event handlers */
function buildMockApi() {
	const handlers: Record<string, Function[]> = {};
	const api = {
		on: vi.fn().mockImplementation((event: string, handler: Function) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
	};
	return { api, handlers };
}

/** Get the Nth handler for a given event */
function getHandler(handlers: Record<string, Function[]>, event: string, index = 0): Function {
	const list = handlers[event];
	if (!list || !list[index]) {
		throw new Error(`No handler registered for event "${event}" at index ${index}`);
	}
	return list[index];
}

/** Build a mock ExtensionContext for agent_end */
function buildMockCtx() {
	return {
		shutdown: vi.fn(),
	};
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("tmux-child mode activation", () => {
	beforeAll(() => {
		// Sanity check that env vars are set
		expect(process.env.PI_SUBAGENT).toBe("1");
		expect(process.env.PI_SUBAGENT_SESSION_DIR).toBe(TEST_SESSION_DIR);
	});

	it("isTmuxChildMode returns true when PI_SUBAGENT=1", () => {
		expect(isTmuxChildMode()).toBe(true);
	});

	it("getTmuxChildConfig returns config from env", () => {
		const config = getTmuxChildConfig();
		expect(config).not.toBeNull();
		expect(config?.sessionDir).toBe(TEST_SESSION_DIR);
		expect(config?.jobId).toBe(TEST_JOB_ID);
		expect(config?.contextMode).toBe("isolated");
	});
});

describe("exit file writing at session_shutdown", () => {
	let handlers: Record<string, Function[]>;
	let api: any;

	beforeEach(async () => {
		cleanSessionDir();
		// Reset modules to get fresh module-level state (sessionOutput) for each test
		vi.resetModules();
		// Re-import to get a fresh module instance
		const freshModule = await import("./tmux-child");
		const built = buildMockApi();
		api = built.api;
		handlers = built.handlers;
		freshModule.activateTmuxChildMode(api);
		// Clear exit file from activation (only activity was written)
		cleanSessionDir();
	});

	afterEach(() => {
		cleanSessionDir();
	});

	it("agent_end does NOT write exit file (only tracks activity)", () => {
		const agentEndHandler = getHandler(handlers, "agent_end");
		const ctx = buildMockCtx();

		// Simulate agent_end with stopReason="stop" (natural completion)
		agentEndHandler(
			{
				messages: [
					{ role: "assistant", stopReason: "stop", content: "Hello world" },
				],
			},
			ctx,
		);

		// CRITICAL: Exit file should NOT be written at agent_end
		expect(fs.existsSync(EXIT_FILE)).toBe(false);
		// ctx.shutdown should be called
		expect(ctx.shutdown).toHaveBeenCalled();
	});

	it("agent_end with stopReason=aborted does NOT write exit file", () => {
		const agentEndHandler = getHandler(handlers, "agent_end");
		const ctx = buildMockCtx();

		// Simulate abort scenario
		agentEndHandler(
			{
				messages: [
					{ role: "assistant", stopReason: "aborted", content: "partial output" },
				],
			},
			ctx,
		);

		// No exit file on abort
		expect(fs.existsSync(EXIT_FILE)).toBe(false);
	});

	it("agent_end with stopReason=toolUse does NOT write exit file", () => {
		const agentEndHandler = getHandler(handlers, "agent_end");
		const ctx = buildMockCtx();

		// Simulate tool use turn ending
		agentEndHandler(
			{
				messages: [
					{
						role: "assistant",
						stopReason: "toolUse",
						content: [{ type: "text", text: "I'll use a tool" }],
						toolCalls: [{ id: "1", name: "bash", arguments: {} }],
					},
				],
			},
			ctx,
		);

		// No exit file on toolUse
		expect(fs.existsSync(EXIT_FILE)).toBe(false);
	});

	it("session_shutdown writes exit file with 'done' type", () => {
		const sessionShutdownHandler = getHandler(handlers, "session_shutdown");

		// Simulate some text_delta first (to populate sessionOutput)
		const messageUpdateHandler = getHandler(handlers, "message_update");
		messageUpdateHandler({
			assistantMessageEvent: { type: "text_delta", delta: "Final result text" },
		});

		// Now trigger session_shutdown
		sessionShutdownHandler();

		// Exit file should now exist
		expect(fs.existsSync(EXIT_FILE)).toBe(true);

		const exitData = peekExitSidecar(TEST_SESSION_DIR);
		expect(exitData).not.toBeNull();
		expect(exitData?.type).toBe("done");
		expect(exitData?.output).toBe("Final result text");
	});

	it("session_shutdown writes '(no output)' when no text was generated", () => {
		const sessionShutdownHandler = getHandler(handlers, "session_shutdown");

		// Trigger shutdown without any prior text_delta
		sessionShutdownHandler();

		const exitData = peekExitSidecar(TEST_SESSION_DIR);
		expect(exitData).not.toBeNull();
		expect(exitData?.type).toBe("done");
		expect(exitData?.output).toBe("(no output)");
	});

	it("abort + continue: exit file written ONCE at session_shutdown, not at agent_end", () => {
		const agentEndHandler = getHandler(handlers, "agent_end");
		const sessionShutdownHandler = getHandler(handlers, "session_shutdown");
		const messageUpdateHandler = getHandler(handlers, "message_update");

		// Step 1: Abort happens
		agentEndHandler(
			{
				messages: [
					{ role: "assistant", stopReason: "aborted", content: "partial" },
				],
			},
			buildMockCtx(),
		);

		// No exit file yet (good!)
		expect(fs.existsSync(EXIT_FILE)).toBe(false);

		// Step 2: Continue with new turn
		messageUpdateHandler({
			assistantMessageEvent: { type: "text_delta", delta: "After resume: " },
		});
		messageUpdateHandler({
			assistantMessageEvent: { type: "text_delta", delta: "completed" },
		});

		// Step 3: Natural completion
		agentEndHandler(
			{
				messages: [
					{ role: "assistant", stopReason: "stop", content: "After resume: completed" },
				],
			},
			buildMockCtx(),
		);

		// Still no exit file (we write at session_shutdown, not agent_end)
		expect(fs.existsSync(EXIT_FILE)).toBe(false);

		// Step 4: Session truly ends
		sessionShutdownHandler();

		// NOW exit file is written
		expect(fs.existsSync(EXIT_FILE)).toBe(true);

		const exitData = peekExitSidecar(TEST_SESSION_DIR);
		expect(exitData?.type).toBe("done");
		// Output should be the accumulated text, not the partial aborted one
		expect(exitData?.output).toBe("After resume: completed");
	});

	it("multiple agent_end events only write exit file ONCE at session_shutdown", () => {
		const agentEndHandler = getHandler(handlers, "agent_end");
		const sessionShutdownHandler = getHandler(handlers, "session_shutdown");

		// Multiple turns, each ending with different stopReason
		agentEndHandler(
			{ messages: [{ role: "assistant", stopReason: "toolUse" }] },
			buildMockCtx(),
		);
		expect(fs.existsSync(EXIT_FILE)).toBe(false);

		agentEndHandler(
			{ messages: [{ role: "assistant", stopReason: "toolUse" }] },
			buildMockCtx(),
		);
		expect(fs.existsSync(EXIT_FILE)).toBe(false);

		agentEndHandler(
			{ messages: [{ role: "assistant", stopReason: "stop" }] },
			buildMockCtx(),
		);
		expect(fs.existsSync(EXIT_FILE)).toBe(false);

		// Only at session_shutdown
		sessionShutdownHandler();
		expect(fs.existsSync(EXIT_FILE)).toBe(true);
	});

	it("session_shutdown fires even without agent_end (e.g., external SIGINT)", () => {
		const sessionShutdownHandler = getHandler(handlers, "session_shutdown");

		// Simulate user pressing Ctrl+C - no agent_end fires, but session_shutdown does
		sessionShutdownHandler();

		// Exit file should still be written
		expect(fs.existsSync(EXIT_FILE)).toBe(true);
		const exitData = peekExitSidecar(TEST_SESSION_DIR);
		expect(exitData?.type).toBe("done");
	});

	it("length (max_tokens) stopReason: exit file still written at session_shutdown", () => {
		const agentEndHandler = getHandler(handlers, "agent_end");
		const sessionShutdownHandler = getHandler(handlers, "session_shutdown");
		const messageUpdateHandler = getHandler(handlers, "message_update");

		// Add some text before truncation
		messageUpdateHandler({
			assistantMessageEvent: { type: "text_delta", delta: "Truncated response" },
		});

		// Simulate max_tokens truncation
		agentEndHandler(
			{
				messages: [
					{ role: "assistant", stopReason: "length", content: "Truncated response" },
				],
			},
			buildMockCtx(),
		);

		// No exit file at agent_end
		expect(fs.existsSync(EXIT_FILE)).toBe(false);

		// Session ends
		sessionShutdownHandler();

		// Exit file IS written (Option 2 advantage)
		expect(fs.existsSync(EXIT_FILE)).toBe(true);
		const exitData = peekExitSidecar(TEST_SESSION_DIR);
		expect(exitData?.type).toBe("done");
		expect(exitData?.output).toBe("Truncated response");
	});

	it("multiple text_delta events accumulate into single output", () => {
		const messageUpdateHandler = getHandler(handlers, "message_update");
		const sessionShutdownHandler = getHandler(handlers, "session_shutdown");

		messageUpdateHandler({
			assistantMessageEvent: { type: "text_delta", delta: "First " },
		});
		messageUpdateHandler({
			assistantMessageEvent: { type: "text_delta", delta: "second " },
		});
		messageUpdateHandler({
			assistantMessageEvent: { type: "text_delta", delta: "third" },
		});

		sessionShutdownHandler();

		const exitData = peekExitSidecar(TEST_SESSION_DIR);
		expect(exitData?.output).toBe("First second third");
	});

	it("thinking_delta events are tracked but don't affect output", () => {
		const messageUpdateHandler = getHandler(handlers, "message_update");
		const sessionShutdownHandler = getHandler(handlers, "session_shutdown");

		messageUpdateHandler({
			assistantMessageEvent: { type: "text_delta", delta: "Actual output" },
		});
		messageUpdateHandler({
			assistantMessageEvent: { type: "thinking_delta", delta: "thinking stuff" },
		});

		sessionShutdownHandler();

		const exitData = peekExitSidecar(TEST_SESSION_DIR);
		// Thinking should not be in output
		expect(exitData?.output).toBe("Actual output");
	});

	it("registers all required event handlers", () => {
		expect(handlers["session_start"]).toBeDefined();
		expect(handlers["input"]).toBeDefined();
		expect(handlers["before_agent_start"]).toBeDefined();
		expect(handlers["agent_start"]).toBeDefined();
		expect(handlers["agent_end"]).toBeDefined();
		expect(handlers["turn_start"]).toBeDefined();
		expect(handlers["turn_end"]).toBeDefined();
		expect(handlers["message_update"]).toBeDefined();
		expect(handlers["tool_execution_start"]).toBeDefined();
		expect(handlers["tool_execution_end"]).toBeDefined();
		expect(handlers["session_shutdown"]).toBeDefined();
	});
});
