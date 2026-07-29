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

const HTTP_METHODS = new Set([
  "node:http.request",
  "node:http.get",
  "node:https.request",
  "node:https.get",
]);

const IPC_CONNECT_METHODS = new Set([
  "node:net.connect",
  "node:net.createConnection",
  "node:net.Socket.connect",
  "node:tls.connect",
  "node:tls.createConnection",
  "node:tls.TLSSocket.connect",
]);

function optionsFromUrl(value) {
  let url = value;
  if (typeof value === "string") {
    try {
      url = new URL(value);
    } catch {
      return { host: value };
    }
  }
  return { hostname: url.hostname };
}

function normalizeHttpTarget(args) {
  const input = args[0];
  const baseOptions =
    input instanceof URL || typeof input === "string"
      ? optionsFromUrl(input)
      : input && typeof input === "object"
        ? input
        : {};
  const overrides =
    args[1] && typeof args[1] === "object" ? args[1] : undefined;
  const options = overrides ? { ...baseOptions, ...overrides } : baseOptions;
  return {
    socket: options.socketPath != null,
    host: options.hostname ?? options.host,
    defaultLocal: true,
  };
}

function normalizeConnectTarget(args) {
  const input = args[0];
  const options = {};
  for (const argument of args) {
    if (argument && typeof argument === "object") {
      Object.assign(options, argument);
    }
  }

  if (input && typeof input === "object") {
    return {
      socket: options.socketPath != null || options.path != null,
      host: options.hostname ?? options.host,
      defaultLocal: true,
    };
  }

  const isPort =
    typeof input === "number" ||
    (typeof input === "string" && /^\d+$/.test(input));
  if (!isPort && typeof input === "string") {
    return { socket: true, host: undefined, defaultLocal: true };
  }

  const positionalHost = typeof args[1] === "string" ? args[1] : undefined;
  return {
    socket: options.socketPath != null || options.path != null,
    host: options.hostname ?? options.host ?? positionalHost,
    defaultLocal: true,
  };
}

function normalizeGenericTarget(args) {
  const input = args[0];
  if (input instanceof URL) {
    return { socket: false, host: input.hostname, defaultLocal: false };
  }
  if (input && typeof input === "object") {
    if (input.url != null) return normalizeGenericTarget([input.url]);
    return {
      socket: input.socketPath != null || input.path != null,
      host: input.hostname ?? input.host,
      defaultLocal: false,
    };
  }
  if (typeof input === "number") {
    const host = typeof args[1] === "string" ? args[1] : undefined;
    return { socket: false, host, defaultLocal: host == null };
  }

  const text = String(input ?? "");
  try {
    const url = new URL(text);
    if (url.hostname) {
      return { socket: false, host: url.hostname, defaultLocal: false };
    }
  } catch {
    /* not a URL */
  }
  const socket = text.startsWith("/") || text.startsWith("./");
  return { socket, host: socket ? undefined : text, defaultLocal: false };
}

function scopeOf(kind, args) {
  const target = HTTP_METHODS.has(kind)
    ? normalizeHttpTarget(args)
    : IPC_CONNECT_METHODS.has(kind)
      ? normalizeConnectTarget(args)
      : normalizeGenericTarget(args);
  if (target.socket || (target.host == null && target.defaultLocal)) {
    return "local";
  }
  return target.host == null ? "egress" : scopeOfHost(target.host);
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
