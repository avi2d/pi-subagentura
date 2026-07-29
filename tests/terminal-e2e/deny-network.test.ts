import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const preload = fileURLToPath(
  new URL("./fixtures/deny-network.cjs", import.meta.url),
);

function deniedEvent(source: string) {
  const root = mkdtempSync(join(tmpdir(), "deny-network-contract-"));
  const log = join(root, "network.ndjson");
  try {
    execFileSync(process.execPath, ["--eval", `try { ${source} } catch {}`], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${preload}`,
        SUBAGENTURA_E2E_NETWORK_LOG: log,
      },
      stdio: "ignore",
      timeout: 5_000,
    });
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.kind !== "armed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("terminal E2E network guard scope", () => {
  it("labels positional loopback connect as local", () => {
    expect(
      deniedEvent('require("node:net").connect(443, "127.0.0.1")'),
    ).toEqual(
      expect.objectContaining({ kind: "node:net.connect", scope: "local" }),
    );
  });

  it.each(["host", "hostname"])(
    "labels remote HTTP options using %s as egress even with a request path",
    (hostKey) => {
      expect(
        deniedEvent(
          `require("node:http").request({ ${hostKey}: "example.com", path: "/" })`,
        ),
      ).toEqual(
        expect.objectContaining({
          kind: "node:http.request",
          scope: "egress",
        }),
      );
    },
  );

  it("labels a UNIX socket connect as local", () => {
    expect(
      deniedEvent('require("node:net").connect("/tmp/subagentura.sock")'),
    ).toEqual(
      expect.objectContaining({ kind: "node:net.connect", scope: "local" }),
    );
  });

  it.each([
    [
      "URL",
      'require("node:http").request(new URL("http://localhost/"))',
      "local",
    ],
    [
      "string",
      'require("node:https").request("https://example.com/")',
      "egress",
    ],
  ])("classifies %s request inputs", (_inputType, source, scope) => {
    expect(deniedEvent(source)).toEqual(expect.objectContaining({ scope }));
  });
});
