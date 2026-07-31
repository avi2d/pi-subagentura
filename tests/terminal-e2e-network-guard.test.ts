import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Needs neither tmux nor Pi, so it lives in the normal unit suite and runs on
// every `npm test` rather than only under `test:tui`.
const guard = fileURLToPath(
  new URL("./terminal-e2e/fixtures/deny-network.cjs", import.meta.url),
);
const temporaryRoots: string[] = [];

const escapePaths = [
  {
    name: "fetch",
    source:
      'fetch("http://127.0.0.1:9").then(() => process.exit(0), () => process.exit(7))',
    kind: "fetch",
  },
  {
    name: "net socket prototype",
    source: 'new (require("node:net").Socket)().connect(9, "127.0.0.1")',
    kind: "node:net.Socket.connect",
  },
  {
    name: "UDP",
    source:
      'require("node:dgram").createSocket("udp4").send("x", 9, "127.0.0.1")',
    kind: "node:dgram.createSocket",
  },
  {
    name: "DNS",
    source: 'require("node:dns").lookup("localhost", () => {})',
    kind: "node:dns.lookup",
  },
  {
    name: "HTTP/2",
    source: 'require("node:http2").connect("http://127.0.0.1:9")',
    kind: "node:http2.connect",
  },
  {
    name: "HTTP",
    source: 'require("node:http").request("http://127.0.0.1:9")',
    kind: "node:http.request",
  },
];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runGuarded(source: string) {
  const root = mkdtempSync(join(tmpdir(), "subagentura-network-guard-"));
  const log = join(root, "network.ndjson");
  temporaryRoots.push(root);

  const result = spawnSync(
    process.execPath,
    ["--require", guard, "--eval", source],
    {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, SUBAGENTURA_E2E_NETWORK_LOG: log },
    },
  );
  const records = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { result, records };
}

describe("terminal E2E network guard", () => {
  it.each(escapePaths)("denies $name before transport", ({ source, kind }) => {
    const { result, records } = runGuarded(source);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(records).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind })]),
    );
  });

  it("records that it armed, so an empty log cannot pass vacuously", () => {
    const { records } = runGuarded("process.exit(0)");

    expect(records).toEqual([
      expect.objectContaining({ kind: "armed", pid: expect.any(Number) }),
    ]);
  });

  it("labels a UNIX socket attempt local so it cannot read as egress", () => {
    const { records } = runGuarded(
      'require("node:net").connect("/tmp/subagentura-e2e-absent.sock")',
    );

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "node:net.connect", scope: "local" }),
      ]),
    );
  });
});
