"use strict";

const fs = require("node:fs");

const logPath = process.env.SUBAGENTURA_E2E_NETWORK_LOG;

function deny(kind, detail) {
  const record = JSON.stringify({
    pid: process.pid,
    kind,
    detail: String(detail || "outbound connection"),
    timestamp: 0,
  });
  if (logPath) fs.appendFileSync(logPath, `${record}\n`, { mode: 0o600 });
  throw new Error(`subagentura terminal E2E forbids network access: ${kind}`);
}

function patchMethods(target, moduleName, names) {
  for (const name of names) {
    if (typeof target?.[name] !== "function") continue;
    target[name] = (...args) => deny(`${moduleName}.${name}`, args[0]);
  }
}

if (typeof globalThis.fetch === "function") {
  globalThis.fetch = async (...args) => deny("fetch", args[0]);
}

if (typeof globalThis.WebSocket === "function") {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: class DeniedWebSocket {
      constructor(url) {
        deny("WebSocket", url);
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
