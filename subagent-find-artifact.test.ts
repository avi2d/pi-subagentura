/**
 * Tests for the path-traversal fix in findArtifactById (subagent.ts).
 *
 * Before the fix, the function passed the LLM-supplied id directly into
 * `path.join(root, entry, "artifacts", id)`, so an id like "../../../etc"
 * would resolve outside the artifact root. The fix validates the id against
 * the 8-hex-char shape used at spawn time (randomBytes(4).toString("hex"))
 * and returns null for anything that doesn't match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function importFresh() {
	vi.resetModules();
	return import("./subagent");
}

describe("findArtifactById (path-traversal guard)", () => {
	let tmp: string;
	let legitDir: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "pi-subagentura-findartifact-"));
		// The production layout is <root>/<cwdLabel>/artifacts/<id>.
		// Create one such directory to use for the well-formed id test.
		legitDir = join(tmp, "cwdLabel1", "artifacts", "deadbeef");
		mkdirSync(legitDir, { recursive: true });
		// stubEnv so vi.resetModules() inside importFresh() doesn't lose the value.
		vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", tmp);
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("returns null for ids with path-traversal sequences", async () => {
		const { findArtifactById } = await importFresh();
		// Each of these would have resolved outside the artifact root before the fix.
		for (const bad of ["../../../etc", "..", "../../legit-id", "/etc/passwd", "..\\..\\windows"]) {
			expect(findArtifactById(bad), `id=${JSON.stringify(bad)} should return null`).toBeNull();
		}
	});

	it("returns null for ids that do not match the 8-hex-char shape", async () => {
		const { findArtifactById } = await importFresh();
		// Either too short, too long, or contains non-hex chars.
		for (const bad of ["", "abc", "zzzzzzzz", "1234567", "123456789", "abc1234 ", "abc-1234"]) {
			expect(findArtifactById(bad), `id=${JSON.stringify(bad)} should return null`).toBeNull();
		}
	});

	it("returns the artifact for a well-formed id when present on disk", async () => {
		// Sanity-check the fixture: the directory we created should be a directory.
		expect(statSync(legitDir).isDirectory()).toBe(true);
		const { findArtifactById } = await importFresh();
		const art = findArtifactById("deadbeef");
		expect(art, "well-formed id with matching dir on disk should be found").not.toBeNull();
		expect(art!.id).toBe("deadbeef");
	});

	it("returns null for a well-formed id that does not exist on disk", async () => {
		const { findArtifactById } = await importFresh();
		expect(findArtifactById("feedface")).toBeNull();
	});
});
