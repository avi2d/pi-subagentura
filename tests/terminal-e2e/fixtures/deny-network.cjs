"use strict";

const fs = require("node:fs");

const logPath = process.env.SUBAGENTURA_E2E_NETWORK_LOG;

function record(entry) {
  if (!logPath) return;
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ pid: process.pid, timestamp: 0, ...entry })}\n`,
    { mode: 0o600 },
  );
}

const LOOPBACK =
  /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$|^(?:https?:\/\/)?(?:localhost|127(?:\.\d+){3}|\[::1\])(?::|\/|$)/i;

/**
 * A UNIX-socket or loopback attempt is not egress. Both are still denied — this
 * suite has no reason to open either — but they are labelled so a future
 * IPC-over-socket failure cannot be misreported as "network denial was invoked".
 */
function scopeOfHost(host) {
  return LOOPBACK.test(String(host)) ? "local" : "egress";
}

function scopeOfOptions(options, pathIsSocket) {
  if (!options || typeof options !== "object") return undefined;
  if (options.socketPath != null) return "local";
  if (pathIsSocket && options.path != null) return "local";
  const host = options.hostname ?? options.host;
  return host == null ? undefined : scopeOfHost(host);
}

function scopeOf(kind, args) {
  const [target, positionalHost] = args;
  const isHttpRequest =
    kind === "node:http.request" ||
    kind === "node:http.get" ||
    kind === "node:https.request" ||
    kind === "node:https.get";
  const isIpcConnect =
    kind === "node:net.connect" ||
    kind === "node:net.createConnection" ||
    kind === "node:net.Socket.connect" ||
    kind === "node:tls.connect" ||
    kind === "node:tls.createConnection" ||
    kind === "node:tls.TLSSocket.connect";

  if (isHttpRequest && (target instanceof URL || typeof target === "string")) {
    const overrideScope = scopeOfOptions(args[1], false);
    if (overrideScope) return overrideScope;
  }

  if (target instanceof URL) return scopeOfHost(target.hostname);

  if (target && typeof target === "object") {
    const optionsScope = scopeOfOptions(target, !isHttpRequest);
    if (optionsScope) return optionsScope;
    if (target.url != null) return scopeOf(kind, [target.url]);
    // HTTP request options without a host use Node's loopback default. Their
    // `.path` is an HTTP request target, not a UNIX socket path.
    if (isHttpRequest) return "local";
    return "egress";
  }

  if (typeof target === "number") {
    if (typeof positionalHost === "string") {
      return scopeOfHost(positionalHost);
    }
    const optionsScope = scopeOfOptions(positionalHost, true);
    return optionsScope ?? "local";
  }

  // In the net/tls connect overloads a string first argument is an IPC path,
  // including relative and Linux abstract socket names.
  if (isIpcConnect && typeof target === "string") return "local";

  const text = String(target ?? "");
  try {
    const url = new URL(text);
    if (url.hostname) return scopeOfHost(url.hostname);
  } catch {
    /* not a URL */
  }
  if (!isHttpRequest && (text.startsWith("/") || text.startsWith("./"))) {
    return "local";
  }
  return LOOPBACK.test(text) ? "local" : "egress";
}

function deny(kind, args) {
  let detail;
  try {
    detail = JSON.stringify(args);
  } catch {
    detail = args.map(String).join(", ");
  }
  record({
    kind,
    scope: scopeOf(kind, args),
    detail: detail || "outbound connection",
  });
  throw new Error(`subagentura terminal E2E forbids network access: ${kind}`);
}

// Positive control: proves to assertNoNetwork() that this preload actually
// applied to the process under test. Without it an empty log is ambiguous.
record({ kind: "armed" });

function patchMethods(target, moduleName, names) {
  for (const name of names) {
    if (typeof target?.[name] !== "function") continue;
    target[name] = (...args) => deny(`${moduleName}.${name}`, args);
  }
}

if (typeof globalThis.fetch === "function") {
  globalThis.fetch = async (...args) => deny("fetch", args);
}

if (typeof globalThis.WebSocket === "function") {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: class DeniedWebSocket {
      constructor(...args) {
        deny("WebSocket", args);
      }
    },
  });
}

for (const moduleName of ["node:http", "node:https"]) {
  patchMethods(require(moduleName), moduleName, ["request", "get"]);
}

const http2 = require("node:http2");
patchMethods(http2, "node:http2", ["connect"]);

const net = require("node:net");
patchMethods(net, "node:net", ["connect", "createConnection"]);
patchMethods(net.Socket?.prototype, "node:net.Socket", ["connect"]);

const tls = require("node:tls");
patchMethods(tls, "node:tls", ["connect", "createConnection"]);
patchMethods(tls.TLSSocket?.prototype, "node:tls.TLSSocket", ["connect"]);

const dgram = require("node:dgram");
patchMethods(dgram, "node:dgram", ["createSocket"]);
patchMethods(dgram.Socket?.prototype, "node:dgram.Socket", [
  "bind",
  "connect",
  "send",
]);

const dnsMethods = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
];
const dns = require("node:dns");
patchMethods(dns, "node:dns", dnsMethods);
patchMethods(dns.promises, "node:dns.promises", dnsMethods);
patchMethods(require("node:dns/promises"), "node:dns/promises", dnsMethods);
