/**
 * Zellij backend — STUB. Ships with the multiplexer interface refactor (PR #1)
 * to keep the type graph complete; the real implementation lands in PR #2
 * (`feat: zellij-multiplexer-backend`).
 *
 * Until PR #2 lands, every method throws so a misconfigured call site (e.g.,
 * `preference: "zellij"` reaching the resolver) fails loudly with a clear
 * message instead of silently doing the wrong thing.
 */

import type { Multiplexer } from "./multiplexer";

export class ZellijMultiplexer implements Multiplexer {
	readonly name = "zellij" as const;

	private notImplemented(method: string): never {
		throw new Error(
			`ZellijMultiplexer.${method}(): zellij backend is not yet implemented ` +
				"(ships in feat/zellij-multiplexer-backend). " +
				"Use the default tmux backend (preference: 'auto' or 'tmux') for now.",
		);
	}

	isAvailable(): boolean {
		// Until PR #2 lands we never claim to be available. This makes
		// `getMux({ preference: "auto" })` always resolve to tmux when both
		// backends' binaries are present, which is the safe default.
		return false;
	}

	createPane(_opts: Parameters<Multiplexer["createPane"]>[0]): { paneId: string; windowName?: string } {
		this.notImplemented("createPane");
	}

	isPaneAlive(_paneId: string): boolean {
		this.notImplemented("isPaneAlive");
	}

	sendKeys(_paneId: string, _text: string): void {
		this.notImplemented("sendKeys");
	}

	sendEnter(_paneId: string): void {
		this.notImplemented("sendEnter");
	}

	killPane(_paneId: string): void {
		this.notImplemented("killPane");
	}

	buildAttachCommands(_opts: Parameters<Multiplexer["buildAttachCommands"]>[0]): {
		attachCommand: string;
		focusCommand: string;
	} {
		this.notImplemented("buildAttachCommands");
	}
}
