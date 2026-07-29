/**
 * Tests for the path-traversal fix in findArtifactById (subagent.ts).
 *
 * Two layered defences are exercised here:
 *
 *  1. The 16-lowercase-hex regex check on the id (blocks "../" sequences and
 *     other non-hex shapes — the original criticals fix).
 *  2. A realpath-aware containment check via is-path-inside, so a symlink
 *     at <root>/<cwd>/artifacts/<id> pointing outside the artifact root
 *     is rejected even though the id itself is well-formed
 *     (the residual symlink-escape primitive the regex alone doesn't cover).
 *
 * The beforeEach creates the dirs the malicious ids WOULD resolve to via
 * path.join, so a regression to the pre-fix code would actually find them
 * via statSync and return a non-null artifact — only the regex
 * (or the realpath check) makes these return null.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFresh } from "./test-utils";

describe("findArtifactById (path-traversal guard)", () => {
  let tmp: string;
  let legitDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-subagentura-findartifact-"));
    // The production layout is <root>/<cwdLabel>/artifacts/<id>.
    // Create one such directory to use for the well-formed id test.
    legitDir = join(tmp, "cwdLabel1", "artifacts", "deadbeefcafebabe");
    mkdirSync(legitDir, { recursive: true });
    // POSITIVE CONTROLS — these dirs are what the malicious ids would
    // resolve to via path.join. The pre-fix vulnerable code would find
    // them via statSync and return a non-null artifact; the regex fix
    // is what makes these return null.
    mkdirSync(join(tmp, "etc"), { recursive: true });
    mkdirSync(join(tmp, "legit-id"), { recursive: true });
    // stubEnv so vi.resetModules() inside importFresh() doesn't lose the value.
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("returns null for ids with path-traversal sequences", async () => {
    const { findArtifactById } =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // Each of these would have resolved outside the artifact root before the fix.
    // With the positive controls in beforeEach, the parent dir /etc and
    // the sibling /legit-id exist on disk — so the pre-fix code would
    // find them and return a non-null artifact. Only the regex fix makes
    // these return null.
    for (const bad of [
      "../../../etc",
      "..",
      "../../legit-id",
      "/etc/passwd",
      "..\\..\\windows",
    ]) {
      expect(
        findArtifactById(bad),
        `id=${JSON.stringify(bad)} should return null`,
      ).toBeNull();
    }
  });

  it("returns null for ids that do not match the 16-hex-char shape", async () => {
    const { findArtifactById } =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // Either too short, too long, contains non-hex / non-ASCII / control
    // chars, or uppercase hex (the regex is anchored to [a-f0-9], not
    // case-insensitive — uppercase would survive any "looks like hex"
    // heuristic but must not match).
    for (const bad of [
      "",
      "abc",
      "z".repeat(16),
      "123456789abcdef", // 15 chars
      "123456789abcdef01", // 17 chars
      "deadbeefcafebabe\n", // valid id plus LF
      "deadbeefcafebabe\r\n", // valid id plus CRLF
      "deadbeefcafebabe\u2028", // valid id plus Unicode line separator
      "deadbeefcafebabe\u2029", // valid id plus Unicode paragraph separator
      "abc1234 ",
      "abc-1234",
      "DEADBEEFCAFEBABE", // uppercase hex — must not match [a-f0-9]
      "абвгдежзийклмноп", // Cyrillic unicode, 16 chars by codepoint count
      "\0".repeat(16), // 16 NUL bytes
      "a".repeat(1000), // absurdly long
    ]) {
      expect(
        findArtifactById(bad),
        `id=${JSON.stringify(bad)} should return null`,
      ).toBeNull();
    }
  });

  it("returns the artifact for a well-formed id when present on disk", async () => {
    // Sanity-check the fixture: the directory we created should be a directory.
    expect(statSync(legitDir).isDirectory()).toBe(true);
    const { findArtifactById } =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const art = findArtifactById("deadbeefcafebabe");
    expect(
      art,
      "well-formed id with matching dir on disk should be found",
    ).not.toBeNull();
    expect(art!.id).toBe("deadbeefcafebabe");
  });

  it("returns null for a well-formed id that does not exist on disk", async () => {
    const { findArtifactById } =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    expect(findArtifactById("feedfacecafebeef")).toBeNull();
  });

  it("blocks symlink escapes (realpath-aware containment check)", async () => {
    // Replace the legit deadbeefcafebabe directory with a symlink that points
    // OUTSIDE the artifact root. The id "deadbeefcafebabe" is well-formed and
    // statSync-follows-symlinks would see a directory at the candidate
    // path — only the realpath check inside findArtifactById can stop
    // this primitive. The target has to escape the root, not just the
    // cwdLabel1/artifacts subdir, so we point it at the real /etc dir.
    rmSync(legitDir, { recursive: true, force: true });
    // /etc is a directory on every unix-like system. The artifact root
    // is mkdtemp'd under tmpdir(), so /etc is definitely outside it.
    if (process.platform === "win32") return; // findArtifactById has no Windows consumers
    symlinkSync("/etc", legitDir);
    // Sanity: statSync follows the symlink, so the candidate IS a directory.
    expect(statSync(legitDir).isDirectory()).toBe(true);

    const { findArtifactById } =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const art = findArtifactById("deadbeefcafebabe");
    expect(
      art,
      "symlink escaping the artifact root must be rejected",
    ).toBeNull();
  });
});
