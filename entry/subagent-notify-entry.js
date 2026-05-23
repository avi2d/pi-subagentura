var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var net = __toESM(require("net"), 1);
var import_child_process = require("child_process");
var import_util = require("util");
const execAsync = (0, import_util.promisify)(import_child_process.exec);
function parseArgs() {
  const args = process.argv.slice(2);
  let socket = "";
  let jobId = "";
  for (const arg of args) {
    if (arg.startsWith("--socket=")) {
      socket = arg.substring("--socket=".length);
    } else if (arg.startsWith("--jobId=")) {
      jobId = arg.substring("--jobId=".length);
    }
  }
  if (!socket || !jobId) {
    console.error("Usage: node subagent-notify-entry.js --socket=<path> --jobId=<id> [--task=<base64>]");
    process.exit(1);
  }
  return { socket, jobId };
}
function parseTaskConfig() {
  const envTask = process.env.PI_SUBAGENT_TASK;
  if (envTask) {
    try {
      return JSON.parse(Buffer.from(envTask, "base64").toString("utf8"));
    } catch {
    }
  }
  for (const arg of process.argv) {
    if (arg.startsWith("--task=")) {
      try {
        return JSON.parse(Buffer.from(arg.substring("--task=".length), "base64").toString("utf8"));
      } catch {
        console.error("[subagent-notify] Failed to parse task from CLI");
        return null;
      }
    }
  }
  return null;
}
function log(level, message, data) {
  const entry = {
    timestamp: Date.now(),
    level,
    event: message,
    jobId: currentJobId,
    ...data
  };
  console.error(JSON.stringify(entry));
}
let currentJobId = "";
let currentTask = null;
class RpcClient {
  socket = null;
  socketPath;
  jobId;
  pendingRequests = /* @__PURE__ */ new Map();
  handlers = /* @__PURE__ */ new Map();
  buffer = "";
  connected = false;
  constructor(socketPath, jobId) {
    this.socketPath = socketPath;
    this.jobId = jobId;
  }
  async connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath, () => {
        this.connected = true;
        log("info", "Connected to parent socket", { socketPath: this.socketPath });
        resolve();
      });
      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const messages = this.buffer.split("\n");
        this.buffer = messages.pop() || "";
        for (const msg of messages) {
          if (msg.trim()) {
            try {
              const parsed = JSON.parse(msg);
              this.handleMessage(parsed);
            } catch {
              this.send({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Parse error" }
              });
            }
          }
        }
      });
      this.socket.on("close", () => {
        this.connected = false;
        log("info", "Disconnected from parent socket");
      });
      this.socket.on("error", (err) => {
        log("error", "Socket error", { error: err.message });
        if (!this.connected) {
          reject(err);
        }
      });
      setTimeout(() => {
        if (!this.connected) {
          this.socket?.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 5e3);
    });
  }
  handleMessage(message) {
    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if ("error" in message && message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }
    if ("method" in message) {
      const method = message.method;
      const id = message.id;
      const params = message.params;
      const handler = this.handlers.get(method);
      if (handler) {
        handler(params).then((result) => {
          if (id !== void 0) {
            this.send({
              jsonrpc: "2.0",
              id,
              result
            });
          }
        }).catch((err) => {
          if (id !== void 0) {
            this.send({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: err.message }
            });
          }
        });
      } else {
        if (id !== void 0) {
          this.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
          });
        }
      }
    }
  }
  send(message) {
    if (this.socket && this.connected) {
      this.socket.write(JSON.stringify(message) + "\n");
    }
  }
  async sendNotification(method, params) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).substring(7);
      const request = {
        jsonrpc: "2.0",
        id,
        method,
        params
      };
      this.pendingRequests.set(id, {
        resolve: () => resolve(),
        reject: () => resolve()
        // Don't fail notifications
      });
      this.send(request);
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve();
        }
      }, 5e3);
    });
  }
  registerHandler(method, handler) {
    this.handlers.set(method, handler);
  }
  async disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
async function executeTask(task, client) {
  log("info", "Executing task", { task: task.task.slice(0, 100) });
  try {
    const cwd = task.cwd || process.cwd();
    const output = `[Subagent ${task.jobId}] Task executed: ${task.task.slice(0, 100)}...
Persona: ${task.persona || "default"}
CWD: ${cwd}`;
    await new Promise((r) => setTimeout(r, 1e3));
    return { output, isError: false };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log("error", "Task execution failed", { error: errorMessage });
    return { output: errorMessage, isError: true };
  }
}
function setupSignalHandlers(client) {
  const shutdown = async (signal) => {
    log("info", `Received ${signal}, initiating graceful shutdown`, { jobId: currentJobId });
    try {
      await client.sendNotification("session.shutdown.starting", { jobId: currentJobId, signal });
    } catch {
    }
    await new Promise((r) => setTimeout(r, 1e3));
    log("info", "Shutdown complete", { jobId: currentJobId });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}
async function main() {
  const args = parseArgs();
  currentJobId = args.jobId;
  currentTask = parseTaskConfig();
  if (!currentTask) {
    console.error("[subagent-notify] No task configuration found");
    currentTask = {
      task: "",
      jobId: currentJobId,
      correlationId: ""
    };
  }
  log("info", "Starting notify subagent", { jobId: currentJobId, hasTask: !!currentTask.task });
  const client = new RpcClient(args.socket, args.jobId);
  try {
    await client.connect();
  } catch (err) {
    log("error", "Failed to connect to parent", { error: err.message });
    process.exit(1);
  }
  client.registerHandler("agent.prompt", async (params) => {
    log("debug", "agent.prompt", { prompt: params?.prompt });
    return { success: true, prompt: params?.prompt, executed: true };
  });
  client.registerHandler("agent.status", async () => {
    return { status: "running", jobId: currentJobId, hasTask: !!currentTask?.task };
  });
  client.registerHandler("tools.list", async () => {
    return { tools: ["agent.prompt", "agent.status", "tools.list", "tools.execute", "session.output"] };
  });
  client.registerHandler("tools.execute", async (params) => {
    log("debug", "tools.execute", { name: params?.name });
    return { success: true, tool: params?.name };
  });
  client.registerHandler("session.shutdown", async (params) => {
    log("info", "Shutdown requested", { correlationId: params?.correlationId });
    if (currentTask?.task) {
      const result = await executeTask(currentTask, client);
      await client.sendNotification("session.output", {
        jobId: currentJobId,
        output: result.output,
        isError: result.isError,
        correlationId: params?.correlationId
      });
    }
    try {
      await client.sendNotification("session.shutdown.ack", {
        jobId: currentJobId,
        correlationId: params?.correlationId
      });
    } catch {
    }
    return { acknowledged: true };
  });
  client.registerHandler("session.heartbeat", async (params) => {
    return { seq: params?.seq, correlationId: params?.correlationId };
  });
  client.registerHandler("session.execute", async (params) => {
    log("info", "session.execute called", { jobId: currentJobId });
    if (!currentTask?.task) {
      return { output: "No task configured", isError: true };
    }
    const result = await executeTask(currentTask, client);
    await client.sendNotification("session.output", {
      jobId: currentJobId,
      output: result.output,
      isError: result.isError,
      correlationId: params?.correlationId
    });
    return result;
  });
  setupSignalHandlers(client);
  try {
    await client.sendNotification("session.ready", { jobId: currentJobId });
    log("info", "Ready notification sent");
  } catch (err) {
    log("warn", "Failed to send ready notification", { error: err.message });
  }
  if (currentTask?.task && currentTask.notifyOnComplete) {
    log("info", "Auto-executing task with notifyOnComplete", { mode: currentTask.notifyOnComplete });
    executeTask(currentTask, client).then(async (result) => {
      log("info", "Task completed", { isError: result.isError });
      await client.sendNotification("session.output", {
        jobId: currentJobId,
        output: result.output,
        isError: result.isError
      });
      await client.sendNotification("session.done", {
        jobId: currentJobId,
        output: result.output,
        isError: result.isError
      });
      await client.sendNotification("session.exit", {
        jobId: currentJobId,
        exitCode: result.isError ? 1 : 0
      });
      await new Promise((r) => setTimeout(r, 500));
      process.exit(result.isError ? 1 : 0);
    });
  }
  log("info", "RPC client running, waiting for requests...");
  await new Promise((resolve) => {
    const checkConnection = setInterval(() => {
      if (!client) {
        clearInterval(checkConnection);
        resolve();
      }
    }, 1e3);
  });
}
main().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
