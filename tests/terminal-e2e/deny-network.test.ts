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

  it("uses the local default for connect(port, connectionListener)", () => {
    expect(deniedEvent('require("node:net").connect(443, () => {})')).toEqual(
      expect.objectContaining({ kind: "node:net.connect", scope: "local" }),
    );
  });

  it.each([
    [
      "third-argument host options",
      'require("node:tls").connect(443, "localhost", { host: "example.com" })',
      "egress",
    ],
    [
      "third-argument hostname options",
      'require("node:tls").connect(443, "example.com", { hostname: "localhost" })',
      "local",
    ],
    [
      "numeric-string port",
      'require("node:net").connect("443", "example.com")',
      "egress",
    ],
  ])("normalizes connect overload %s", (_overload, source, scope) => {
    expect(deniedEvent(source)).toEqual(expect.objectContaining({ scope }));
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

  it.each([
    [
      "explicit hostname",
      'require("node:http").request(new URL("http://example.com/"), { hostname: "localhost", path: "/" })',
      "local",
    ],
    [
      "URL hostname before explicit host",
      'require("node:http").get("http://localhost/", { host: "example.com" })',
      "local",
    ],
    [
      "reverse URL hostname before explicit host",
      'require("node:http").get("http://example.com/", { host: "localhost" })',
      "egress",
    ],
    [
      "socketPath",
      'require("node:http").request("http://example.com/", { socketPath: "service.sock", path: "/" })',
      "local",
    ],
    [
      "request path only",
      'require("node:http").get("http://example.com/", { path: "/" })',
      "egress",
    ],
  ])("normalizes HTTP options %s", (_case, source, scope) => {
    expect(deniedEvent(source)).toEqual(expect.objectContaining({ scope }));
  });

  it.each([
    [
      "absolute net socket",
      'require("node:net").connect("/tmp/subagentura.sock")',
      "node:net.connect",
    ],
    [
      "relative net socket",
      'require("node:net").connect("service.sock")',
      "node:net.connect",
    ],
    [
      "abstract TLS socket",
      'require("node:tls").connect("\\u0000subagentura.sock")',
      "node:tls.connect",
    ],
  ])("labels a %s path as local", (_pathType, source, kind) => {
    expect(deniedEvent(source)).toEqual(
      expect.objectContaining({ kind, scope: "local" }),
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
