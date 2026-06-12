/**
 * Tests for the `send_interactive_subagent_message` tool.
 *
 * Verifies that the parent-facing tool:
 *   - calls `sendCommandToTmuxPane` with the right pane id and message
 *   - refuses invalid / unknown / non-running sub-agents
 *   - returns a structured error if tmux itself rejects the send-keys call
 *
 * The tool uses `sendCommandToTmuxPane` (which shells out to `tmux send-keys`)
 * and `interactiveSubagentRegistry` — both are mocked here so the test stays
 * hermetic and doesn't require a live tmux server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendCommandToTmuxPane, mockGet } = vi.hoisted(() => ({
	mockSendCommandToTmuxPane: vi.fn(),
	mockGet: vi.fn(),
}));

// Mock interactive-tmux so we get a stub registry + controllable send-keys helper.
vi.mock("./interactive-tmux", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./interactive-tmux")>();
	return {
		...actual,
		sendCommandToTmuxPane: mockSendCommandToTmuxPane,
		interactiveSubagentRegistry: {
			get: mockGet,
		} as any,
	};
});

import registerExtension from "./subagent";

function setupExtension() {
	const api = {
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		on: vi.fn(),
	};
	registerExtension(api as any);
	return api;
}

function getToolDef(api: { registerTool: ReturnType<typeof vi.fn> }, name: string) {
	return api.registerTool.mock.calls.find(([t]: any[]) => t.name === name)?.[0];
}

function runningState(overrides: Record<string, any> = {}) {
	return {
		id: "abc12345",
		name: "Test",
		paneId: "%99",
		status: "running",
		...overrides,
	};
}

describe("send_interactive_subagent_message", () => {
	let api: ReturnType<typeof setupExtension>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = setupExtension() as any;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("is registered with the expected name", () => {
		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		expect(toolDef).toBeDefined();
	});

	it("sends the message to the pane and returns success details", async () => {
		mockGet.mockReturnValue(runningState());
		mockSendCommandToTmuxPane.mockReturnValue(undefined);

		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		const result = await toolDef.execute("call-1", {
			id: "abc12345",
			message: "now do step 2",
		});

		expect(mockGet).toHaveBeenCalledWith("abc12345");
		expect(mockSendCommandToTmuxPane).toHaveBeenCalledWith("%99", "now do step 2");
		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({
			id: "abc12345",
			paneId: "%99",
			messageLength: "now do step 2".length,
			status: "sent",
		});
		expect(result.content[0].text).toContain("Sent follow-up to interactive sub-agent abc12345");
		expect(result.content[0].text).toContain("pane %99");
	});

	it("accepts 'idle' sub-agents (the follow-up case — child between turns, REPL open)", async () => {
		// 'idle' is the whole point of the follow-up flow: the child finished a turn, REPL is still
		// open, status='idle' (not 'exited'). The tool must accept sends in this state.
		mockGet.mockReturnValue(runningState({ status: "idle" }));
		mockSendCommandToTmuxPane.mockReturnValue(undefined);

		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		const result = await toolDef.execute("call-1b", {
			id: "abc12345",
			message: "follow-up after turn 1",
		});

		expect(mockSendCommandToTmuxPane).toHaveBeenCalledWith("%99", "follow-up after turn 1");
		expect(result.isError).toBeFalsy();
		expect(result.details.status).toBe("sent");
	});


	it("rejects malformed ids with a precise error", async () => {
		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		const result = await toolDef.execute("call-2", { id: "not-hex", message: "hi" });

		expect(mockGet).not.toHaveBeenCalled();
		expect(mockSendCommandToTmuxPane).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.details.status).toBe("invalid_id");
		expect(result.content[0].text).toMatch(/Invalid sub-agent id/);
	});

	it.each(["", "   ", "\n\n", "\t  \n"])("rejects empty / whitespace-only message: %j", async (message) => {
		// An empty Enter in the child REPL would submit a blank prompt and confuse the child;
		// reject it before any registry / tmux work happens.
		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		const result = await toolDef.execute("call-empty", { id: "abc12345", message });

		expect(mockGet).not.toHaveBeenCalled();
		expect(mockSendCommandToTmuxPane).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.details.status).toBe("empty_message");
		expect(result.details.messageLength).toBe(0);
		expect(result.content[0].text).toMatch(/empty/i);
	});

	it("rejects a message larger than 64 KiB", async () => {
		// Symmetric with MAX_PERSONA_BYTES in interactive-tmux.ts. 64 KiB UTF-8 is well above any
		// realistic follow-up prompt; larger values risk blowing the child REPL history.
		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		const message = "x".repeat(64 * 1024 + 1);
		const result = await toolDef.execute("call-huge", { id: "abc12345", message });

		expect(mockGet).not.toHaveBeenCalled();
		expect(mockSendCommandToTmuxPane).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			id: "abc12345",
			status: "message_too_large",
			messageLength: 64 * 1024 + 1,
			maxBytes: 64 * 1024,
		});
		expect(result.content[0].text).toMatch(/too large/);
		expect(result.content[0].text).toMatch(/65536/);
	});

	it("accepts a message exactly at the 64 KiB boundary", async () => {
		// Boundary check: 64 KiB is allowed, 64 KiB + 1 is not.
		mockGet.mockReturnValue(runningState());
		mockSendCommandToTmuxPane.mockReturnValue(undefined);

		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		const message = "x".repeat(64 * 1024);
		const result = await toolDef.execute("call-boundary", { id: "abc12345", message });

		expect(mockSendCommandToTmuxPane).toHaveBeenCalledWith("%99", message);
		expect(result.isError).toBeFalsy();
		expect(result.details.status).toBe("sent");
		expect(result.details.messageLength).toBe(64 * 1024);
	});
	it("rejects unknown sub-agent ids", async () => {
		mockGet.mockReturnValue(undefined);

		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		const result = await toolDef.execute("call-3", { id: "deadbeef", message: "hi" });

		expect(mockSendCommandToTmuxPane).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.details.status).toBe("not_found");
	});

	it.each(["cancelled", "exited", "unknown"] as const)(
		"refuses to send when the sub-agent status is %s",
		async (status) => {
			mockGet.mockReturnValue(runningState({ status }));

			const toolDef = getToolDef(api, "send_interactive_subagent_message");
			const result = await toolDef.execute("call-4", { id: "abc12345", message: "hi" });

			expect(mockSendCommandToTmuxPane).not.toHaveBeenCalled();
			expect(result.isError).toBe(true);
			expect(result.details.status).toBe(status);
			expect(result.content[0].text).toContain(`is ${status}`);
		},
	);

	it("returns a structured error when tmux send-keys throws (pane gone between check and send)", async () => {
		mockGet.mockReturnValue(runningState());
		mockSendCommandToTmuxPane.mockImplementation(() => {
			throw new Error("can't find pane: %99");
		});

		const toolDef = getToolDef(api, "send_interactive_subagent_message");
		const result = await toolDef.execute("call-5", { id: "abc12345", message: "hi" });

		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			id: "abc12345",
			paneId: "%99",
			status: "send_failed",
		});
		expect(result.content[0].text).toContain("Failed to send message");
		expect(result.content[0].text).toContain("can't find pane: %99");
	});
});
