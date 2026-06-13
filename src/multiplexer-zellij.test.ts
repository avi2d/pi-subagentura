import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

/** Standard zellij pane id returned by mocks. Zellij uses bare integers. */
const MOCK_PANE_ID = "42";

/** JSON returned by `list-panes --json` when one pane exists. */
const PANES_BEFORE = JSON.stringify([{ id: 1, tab_position: 0 }]);

/** JSON with an added pane after `new-tab`. */
const PANES_AFTER = JSON.stringify([
	{ id: 1, tab_position: 0 },
	{ id: 2, tab_position: 1 },
]);

function installMockExec(scenario: (file: string, args: string[]) => string) {
	vi.resetModules();
	vi.doMock("node:child_process", () => ({
		execFileSync: (_file: string, args: string[]) => scenario("zellij", args as string[]),
	}));
}

describe("multiplexer-zellij", () => {
	beforeEach(() => {
		const g = globalThis as any;
		g.__piSubagenturaInteractiveRegistry?.clear?.();
	});

	afterEach(() => {
		vi.doUnmock("node:child_process");
	});

	/* ------------------------------------------------------------------ */
	/*  isAvailable                                                        */
	/* ------------------------------------------------------------------ */

	it("isAvailable returns true when ZELLIJ env var is set and binary exists", async () => {
		process.env.ZELLIJ = "0";
		installMockExec((_f, args) => {
			// command -v zellij — return empty means success
			if (args.includes("-lc")) return "";
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(mux.isAvailable()).toBe(true);
	});

	it("isAvailable returns false when ZELLIJ env var is missing", async () => {
		process.env.ZELLIJ = "";
		installMockExec(() => "");

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(mux.isAvailable()).toBe(false);
	});

	it("isAvailable returns false when zellij binary is not on PATH", async () => {
		process.env.ZELLIJ = "0";
		installMockExec((_f, args) => {
			if (args.includes("-lc")) throw new Error("command not found");
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(mux.isAvailable()).toBe(false);
	});

	/* ------------------------------------------------------------------ */
	/*  createPane — background mode (new-tab)                             */
	/* ------------------------------------------------------------------ */

	it("createPane in background mode (new-tab) returns paneId and windowName", async () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "main";
		const calls: string[][] = [];
		let listCallCount = 0;

		installMockExec((_f, args) => {
			calls.push(args);
			if (args.includes("list-panes") && args.includes("--json")) {
				listCallCount++;
				return listCallCount === 1 ? PANES_BEFORE : PANES_AFTER;
			}
			if (args.includes("new-tab")) return "";
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const result = mux.createPane({ name: "Demo", cwd: "/tmp", background: true });

		expect(result.paneId).toBe("2");
		expect(result.windowName).toBe("demo");

		const usedNewTab = calls.some((a) => a.includes("new-tab"));
		const usedNewPane = calls.some((a) => a.includes("new-pane"));
		expect(usedNewTab).toBe(true);
		expect(usedNewPane).toBe(false);
	});

	/* ------------------------------------------------------------------ */
	/*  createPane — visible-split mode (new-pane)                         */
	/* ------------------------------------------------------------------ */

	it("createPane in visible-split mode (new-pane) returns paneId, no windowName", async () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "main";
		const calls: string[][] = [];

		installMockExec((_f, args) => {
			calls.push(args);
			if (args.includes("new-pane")) return `${MOCK_PANE_ID}\n`;
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const result = mux.createPane({ name: "Demo", cwd: "/tmp", background: false });

		expect(result.paneId).toBe(MOCK_PANE_ID);
		expect(result.windowName).toBeUndefined();

		const usedNewPane = calls.some((a) => a.includes("new-pane"));
		const usedNewTab = calls.some((a) => a.includes("new-tab"));
		expect(usedNewPane).toBe(true);
		expect(usedNewTab).toBe(false);
	});

	it("createPane uses --in-pane-id when parentPane is provided", async () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "main";
		const calls: string[][] = [];

		installMockExec((_f, args) => {
			calls.push(args);
			if (args.includes("new-pane")) return `${MOCK_PANE_ID}\n`;
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		mux.createPane({ name: "Demo", cwd: "/tmp", background: false, parentPane: "1" });

		const newPaneCall = calls.find((a) => a.includes("new-pane"));
		expect(newPaneCall).toBeDefined();
		expect(newPaneCall).toContain("--in-pane-id");
		expect(newPaneCall).toContain("1");
	});

	/* ------------------------------------------------------------------ */
	/*  createPane — relaxed path (parent not in zellij)                   */
	/* ------------------------------------------------------------------ */

	it("createPane with relaxed path (parent not in zellij) creates background session", async () => {
		process.env.ZELLIJ = "";
		delete process.env.ZELLIJ_SESSION_NAME;
		const calls: string[][] = [];

		installMockExec((_f, args) => {
			calls.push(args);
			if (args.includes("attach") && args.includes("--create-background")) return "";
			if (args.includes("new-pane")) return `${MOCK_PANE_ID}\n`;
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const result = mux.createPane({
			name: "Demo",
			cwd: "/tmp",
			background: false,
			id: "abc12345",
		});

		expect(result.paneId).toBe(MOCK_PANE_ID);
		const attachCall = calls.find((a) => a.includes("attach"));
		expect(attachCall).toBeDefined();
		expect(attachCall).toContain("--create-background");
		expect(attachCall).toContain("pi-subagent-abc12345");
	});

	/* ------------------------------------------------------------------ */
	/*  isPaneAlive                                                        */
	/* ------------------------------------------------------------------ */

	it("isPaneAlive returns true when pane exists in list", async () => {
		process.env.ZELLIJ = "0";
		installMockExec((_f, args) => {
			if (args.includes("list-panes") && args.includes("--json")) {
				return JSON.stringify([
					{ id: 1 },
					{ id: 42 },
					{ id: 3 },
				]);
			}
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(mux.isPaneAlive("42")).toBe(true);
	});

	it("isPaneAlive returns false when pane does not exist in list", async () => {
		process.env.ZELLIJ = "0";
		installMockExec((_f, args) => {
			if (args.includes("list-panes") && args.includes("--json")) {
				return JSON.stringify([{ id: 1 }, { id: 2 }]);
			}
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(mux.isPaneAlive("99")).toBe(false);
	});

	it("isPaneAlive returns false on exec error", async () => {
		process.env.ZELLIJ = "0";
		installMockExec(() => {
			throw new Error("no such pane");
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(mux.isPaneAlive("42")).toBe(false);
	});

	/* ------------------------------------------------------------------ */
	/*  sendKeys + sendEnter                                               */
	/* ------------------------------------------------------------------ */

	it("sendKeys calls write-chars with the text", async () => {
		process.env.ZELLIJ = "0";
		const calls: string[][] = [];

		installMockExec((_f, args) => {
			calls.push(args);
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		mux.sendKeys("42", "echo hello");

		const writeCharsCall = calls.find((a) => a.includes("write-chars"));
		expect(writeCharsCall).toBeDefined();
		expect(writeCharsCall).toContain("--pane-id");
		expect(writeCharsCall).toContain("42");
		expect(writeCharsCall).toContain("echo hello");
	});

	it("sendEnter calls write with 13 (Enter key)", async () => {
		process.env.ZELLIJ = "0";
		const calls: string[][] = [];

		installMockExec((_f, args) => {
			calls.push(args);
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		mux.sendEnter("42");

		const writeCall = calls.find((a) => a.includes("write") && !a.includes("write-chars"));
		expect(writeCall).toBeDefined();
		expect(writeCall).toContain("--pane-id");
		expect(writeCall).toContain("42");
		expect(writeCall).toContain("13");
	});

	/* ------------------------------------------------------------------ */
	/*  killPane                                                           */
	/* ------------------------------------------------------------------ */

	it("killPane calls close-pane", async () => {
		process.env.ZELLIJ = "0";
		const calls: string[][] = [];

		installMockExec((_f, args) => {
			calls.push(args);
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		mux.killPane("42");

		const closeCall = calls.find((a) => a.includes("close-pane"));
		expect(closeCall).toBeDefined();
		expect(closeCall).toContain("--pane-id");
		expect(closeCall).toContain("42");
	});

	it("killPane does not throw on error (best-effort)", async () => {
		process.env.ZELLIJ = "0";
		installMockExec(() => {
			throw new Error("pane not found");
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(() => mux.killPane("42")).not.toThrow();
	});

	/* ------------------------------------------------------------------ */
	/*  buildAttachCommands — with windowName (tab mode)                   */
	/* ------------------------------------------------------------------ */

	it("buildAttachCommands with windowName returns tab-focused commands", async () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "main";

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const cmds = mux.buildAttachCommands({ paneId: "42", windowName: "demo" });

		expect(cmds.attachCommand).toBe("zellij attach 'main'");
		expect(cmds.focusCommand).toBe("zellij action go-to-tab-name 'demo'");
	});

	/* ------------------------------------------------------------------ */
	/*  buildAttachCommands — without windowName (pane mode)               */
	/* ------------------------------------------------------------------ */

	it("buildAttachCommands without windowName returns pane-focused commands", async () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "main";

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const cmds = mux.buildAttachCommands({ paneId: "42" });

		expect(cmds.attachCommand).toBe(
			"zellij attach 'main'",
		);
		expect(cmds.focusCommand).toBe("zellij action focus-pane 42");
	});

	it("attachCommand for visible split does NOT use tmux \; chaining (zellij doesn't support it)", async () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "main";

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const cmds = mux.buildAttachCommands({ paneId: "42" });

		// Zellij does not support tmux-style \; command chaining.
		// The attach command should be a simple `zellij attach <sess>`
		// without chained actions.
		expect(cmds.attachCommand).not.toContain("\\;");
		expect(cmds.attachCommand).toBe("zellij attach 'main'");
	});

	it("buildAttachCommands uses _sessionName when ZELLIJ_SESSION_NAME is not set", async () => {
		process.env.ZELLIJ = "";
		delete process.env.ZELLIJ_SESSION_NAME;

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		// Set the internal session name (as createPane would)
		(mux as any)._sessionName = "pi-subagent-abc123";

		const cmds = mux.buildAttachCommands({ paneId: "42", windowName: "demo" });
		expect(cmds.attachCommand).toBe("zellij attach 'pi-subagent-abc123'");
		expect(cmds.focusCommand).toBe("zellij action go-to-tab-name 'demo'");
	});
});
