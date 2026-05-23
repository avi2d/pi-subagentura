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
const ENV_TASK = process.env.PI_TASK || "";
const ENV_PERSONA = process.env.PI_PERSONA || "";
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
    console.error("Usage: node subagent-rpc-client.js --socket=<path> --jobId=<id>");
    process.exit(1);
  }
  return { socket, jobId };
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
let correlationId = "";
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
async function executePiTask(task, persona, cwd) {
  return new Promise((resolve) => {
    const args = [];
    if (persona) {
      const escapedPersona = persona.replace(/'/g, "'\\''");
      args.push(`--persona='${escapedPersona}'`);
    }
    const escapedTask = task.replace(/'/g, "'\\''");
    args.push(`'${escapedTask}'`);
    log("info", "spawning-pi", { cwd, args: args.join(" ") });
    const pi = (0, import_child_process.spawn)("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm" }
    });
    let stdout = "";
    let stderr = "";
    pi.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    pi.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    pi.on("close", (code) => {
      const output = stdout || (stderr ? `Errors:
${stderr}` : "(no output)");
      const isError = code !== 0;
      if (isError && stderr) {
        log("warn", "pi-exited-with-error", { exitCode: code, stderr: stderr.slice(0, 500) });
      }
      resolve({ output, isError });
    });
    pi.on("error", (err) => {
      log("error", "pi-process-error", { error: err.message });
      resolve({ output: `Failed to spawn pi: ${err.message}`, isError: true });
    });
  });
}
async function main() {
  const args = parseArgs();
  currentJobId = args.jobId;
  correlationId = currentJobId;
  log("info", "Starting RPC client", { jobId: currentJobId, socket: args.socket });
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
    return { status: "running", jobId: currentJobId };
  });
  client.registerHandler("tools.list", async () => {
    return { tools: ["agent.prompt", "agent.status", "tools.list", "tools.execute"] };
  });
  client.registerHandler("tools.execute", async (params) => {
    log("debug", "tools.execute", { name: params?.name });
    return { success: true, tool: params?.name };
  });
  client.registerHandler("session.shutdown", async (params) => {
    log("info", "Shutdown requested", { correlationId: params?.correlationId });
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
    const task = params?.task || "";
    const persona = params?.persona;
    const cwd = params?.cwd || process.cwd();
    try {
      const result = await executePiTask(task, persona, cwd);
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
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log("error", "Task execution failed", { error: errorMessage });
      await client.sendNotification("session.output", {
        jobId: currentJobId,
        output: errorMessage,
        isError: true
      });
      return { output: errorMessage, isError: true };
    }
  });
  try {
    await client.sendNotification("session.ready", { jobId: currentJobId });
    log("info", "Ready notification sent");
  } catch (err) {
    log("warn", "Failed to send ready notification", { error: err.message });
  }
  if (ENV_TASK) {
    log("info", "Auto-executing task from environment", { taskLength: ENV_TASK.length });
    const result = await executePiTask(ENV_TASK, ENV_PERSONA || void 0, process.cwd());
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
    log("info", "Auto-execution complete", { isError: result.isError });
  } else {
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
}
main().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
