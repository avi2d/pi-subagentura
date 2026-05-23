var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var mod_exports = {};
__export(mod_exports, {
  CallRpcParams: () => import_call_rpc.CallRpcParams,
  KillRpcParams: () => import_kill_rpc.KillRpcParams,
  ListRpcParams: () => import_list_rpc.ListRpcParams,
  SpawnNotifyParams: () => import_spawn_notify.SpawnNotifyParams,
  SpawnRpcParams: () => import_spawn_rpc.SpawnRpcParams,
  callSubagentRpc: () => import_call_rpc.callSubagentRpc,
  killRpcSubagent: () => import_kill_rpc.killRpcSubagent,
  listRpcSubagents: () => import_list_rpc.listRpcSubagents,
  spawnNotifySubagent: () => import_spawn_notify.spawnNotifySubagent,
  spawnRpcSubagent: () => import_spawn_rpc.spawnRpcSubagent
});
module.exports = __toCommonJS(mod_exports);
var import_spawn_rpc = require("./spawn-rpc.js");
var import_call_rpc = require("./call-rpc.js");
var import_list_rpc = require("./list-rpc.js");
var import_kill_rpc = require("./kill-rpc.js");
var import_spawn_notify = require("./spawn-notify.js");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CallRpcParams,
  KillRpcParams,
  ListRpcParams,
  SpawnNotifyParams,
  SpawnRpcParams,
  callSubagentRpc,
  killRpcSubagent,
  listRpcSubagents,
  spawnNotifySubagent,
  spawnRpcSubagent
});
