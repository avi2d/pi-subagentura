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

	it("isAvailable is binary-only: returns true even when ZELLIJ env var is unset", async () => {
		// Regression for the auto-resolution bug: isAvailable must NOT require
		// ZELLIJ === "0". The "am I inside zellij" heuristic lives in getMux();
		// keeping it out of isAvailable lets the relaxed-spawn fallback select
		// zellij from a plain terminal. Symmetric with TmuxMultiplexer.
		process.env.ZELLIJ = "";
		delete process.env.ZELLIJ_SESSION_NAME;
		installMockExec((_f, args) => {
			if (args.includes("-lc")) return ""; // command -v zellij succeeds
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(mux.isAvailable()).toBe(true);
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
		// In-session spawn: session is ZELLIJ_SESSION_NAME so later ops target it.
		expect(result.session).toBe("main");

		const usedNewTab = calls.some((a) => a.includes("new-tab"));
		const usedNewPane = calls.some((a) => a.includes("new-pane"));
		expect(usedNewTab).toBe(true);
		expect(usedNewPane).toBe(false);
	});

	/* ------------------------------------------------------------------ */
	/*  createPane — visible-split mode (new-pane)                         */
	/* ------------------------------------------------------------------ */

	it("createPane in visible-split mode (in zellij) uses new-pane and recovers the list-panes id via diff", async () => {
		// `new-pane`'s `terminal_<n>` stdout counter is NOT the same number as the
		// `id` field in `list-panes` (verified on zellij 0.44.3), so createPane
		// recovers the canonical id from a before/after list-panes diff — the same
		// number every other op (isPaneAlive/sendKeys/killPane) compares against.
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
			if (args.includes("new-pane")) return "terminal_2\n"; // distinct counter; must be ignored
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const result = mux.createPane({ name: "Demo", cwd: "/tmp", background: false });

		expect(result.paneId).toBe("2"); // from list-panes diff, not new-pane stdout
		expect(result.windowName).toBeUndefined();

		const usedNewPane = calls.some((a) => a.includes("new-pane"));
		const usedNewTab = calls.some((a) => a.includes("new-tab"));
		expect(usedNewPane).toBe(true);
		expect(usedNewTab).toBe(false);
	});

	it("createPane new-pane passes neither --in-pane-id nor --close-on-exit", async () => {
		// `new-pane` has no `--in-pane-id` flag (parentPane has no mapping in
		// zellij — it splits the focused pane). And `--close-on-exit` makes a
		// trailing <COMMAND> mandatory, so passing it without a command makes
		// zellij exit non-zero. Both must be absent.
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
			if (args.includes("new-pane")) return "terminal_2\n";
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		mux.createPane({ name: "Demo", cwd: "/tmp", background: false, parentPane: "1" });

		const newPaneCall = calls.find((a) => a.includes("new-pane"));
		expect(newPaneCall).toBeDefined();
		expect(newPaneCall).not.toContain("--in-pane-id");
		expect(newPaneCall).not.toContain("--close-on-exit");
	});

	/* ------------------------------------------------------------------ */
	/*  createPane — relaxed path (parent not in zellij)                   */
	/* ------------------------------------------------------------------ */

	it("createPane relaxed path creates a background session and forces new-tab (no attached client → no split)", async () => {
		// Parent not in zellij ⇒ no attached client. A visible split is invisible
		// and isn't tracked by list-panes in a detached session, so createPane
		// must force background (new-tab) mode even when background:false is asked
		// — mirroring the tmux backend's relaxed path.
		process.env.ZELLIJ = "";
		delete process.env.ZELLIJ_SESSION_NAME;
		const calls: string[][] = [];
		let listCallCount = 0;

		installMockExec((_f, args) => {
			calls.push(args);
			if (args.includes("attach") && args.includes("--create-background")) return "";
			if (args.includes("list-panes") && args.includes("--json")) {
				listCallCount++;
				return listCallCount === 1 ? PANES_BEFORE : PANES_AFTER;
			}
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const result = mux.createPane({
			name: "Demo",
			cwd: "/tmp",
			background: false, // asked for split, but relaxed path must override
			id: "abc12345",
		});

		expect(result.paneId).toBe("2");
		// The created session must be returned so the orchestrator can persist it
		// on state.muxSession and target later ops — it is NOT held on the
		// (resolver-shared) backend instance.
		expect(result.session).toBe("pi-subagent-abc12345");
		const attachCall = calls.find((a) => a.includes("attach"));
		expect(attachCall).toBeDefined();
		expect(attachCall).toContain("--create-background");
		expect(attachCall).toContain("pi-subagent-abc12345");
		// Forced background: new-tab, never new-pane.
		expect(calls.some((a) => a.includes("new-tab"))).toBe(true);
		expect(calls.some((a) => a.includes("new-pane"))).toBe(false);
		// And every action after session creation must carry --session <name>.
		const newTabCall = calls.find((a) => a.includes("new-tab"));
		expect(newTabCall).toEqual(expect.arrayContaining(["--session", "pi-subagent-abc12345"]));
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
		// The action is `focus-pane-id <id>` — there is no `focus-pane` subcommand.
		expect(cmds.focusCommand).toBe("zellij action focus-pane-id 42");
	});

	it("buildAttachCommands normalizes a terminal_<n> paneId in the focus command", async () => {
		process.env.ZELLIJ = "0";
		process.env.ZELLIJ_SESSION_NAME = "main";

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const cmds = mux.buildAttachCommands({ paneId: "terminal_42" });
		expect(cmds.focusCommand).toBe("zellij action focus-pane-id 42");
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

	it("buildAttachCommands uses the session passed via opts (relaxed-path session)", async () => {
		// The relaxed-path session name is threaded in through opts.session
		// (persisted on state.muxSession by the orchestrator), NOT stored on the
		// shared backend instance — so concurrent spawns can't clobber it.
		process.env.ZELLIJ = "";
		delete process.env.ZELLIJ_SESSION_NAME;

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();

		const cmds = mux.buildAttachCommands({
			paneId: "42",
			windowName: "demo",
			session: "pi-subagent-abc123",
		});
		expect(cmds.attachCommand).toBe("zellij attach 'pi-subagent-abc123'");
		expect(cmds.focusCommand).toBe("zellij action go-to-tab-name 'demo'");
	});

	/* ------------------------------------------------------------------ */
	/*  session threading + isPaneAlive exited-guard / normalization       */
	/* ------------------------------------------------------------------ */

	it("ops target the supplied session via --session and normalize prefixed ids", async () => {
		process.env.ZELLIJ = "0";
		const calls: string[][] = [];
		installMockExec((_f, args) => {
			calls.push(args);
			if (args.includes("list-panes")) return JSON.stringify([{ id: 42 }]);
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		const sess = "pi-subagent-xyz";

		expect(mux.isPaneAlive("terminal_42", sess)).toBe(true);
		mux.sendKeys("terminal_42", "echo hi", sess);
		mux.sendEnter("terminal_42", sess);
		mux.killPane("terminal_42", sess);

		// Every call carries --session, and the pane id is the bare integer.
		for (const verb of ["list-panes", "write-chars", "write", "close-pane"]) {
			const call = calls.find((a) => a.includes(verb));
			expect(call, verb).toEqual(expect.arrayContaining(["--session", sess]));
		}
		const writeChars = calls.find((a) => a.includes("write-chars"))!;
		expect(writeChars).toEqual(expect.arrayContaining(["--pane-id", "42"]));
		expect(writeChars).not.toContain("terminal_42");
	});

	it("isPaneAlive returns false for a pane reported as exited", async () => {
		// `--close-on-exit` is not always set, so a finished pane can linger in
		// list-panes with exited:true. Presence alone must not mean 'alive'.
		process.env.ZELLIJ = "0";
		installMockExec((_f, args) => {
			if (args.includes("list-panes")) {
				return JSON.stringify([{ id: 42, exited: true }]);
			}
			return "";
		});

		const { ZellijMultiplexer } = await importFresh<typeof import("./multiplexer-zellij")>(
			"./multiplexer-zellij",
		);
		const mux = new ZellijMultiplexer();
		expect(mux.isPaneAlive("42")).toBe(false);
	});
});
