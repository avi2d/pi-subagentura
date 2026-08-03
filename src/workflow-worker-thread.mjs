import { parentPort } from "node:worker_threads";
import { runInNewContext } from "node:vm";
import {
  makeGuardedDate,
  makeGuardedMath,
  parseWorkflow,
  workflowStringify,
} from "./workflow-script.mjs";

if (!parentPort) {
  throw new Error("workflow-worker-thread must be run as a Worker thread.");
}

let nextRpcId = 1;
const pending = new Map();
const outstandingAgentCalls = new Set();
let aborted = false;
let workerConfig = {
  syncTimeoutMs: 30_000,
  maxItemsPerCall: 4096,
  maxWorkflowDepth: 1,
  budgetTotal: null,
  cwd: "",
};
let tokensSpent = 0;
const rpcErrorIds = new WeakMap();

function rpc(method, payload) {
  if (aborted) return Promise.reject(new Error("Workflow aborted."));
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ id, method, payload });
  });
}

function rpcIdFromError(error) {
  if (error === null || typeof error !== "object") return undefined;
  return rpcErrorIds.get(error);
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "abort") {
    aborted = true;
    for (const { reject } of pending.values()) {
      reject(new Error("Workflow aborted."));
    }
    pending.clear();
    return;
  }

  if (msg.type === "init") {
    workerConfig = {
      syncTimeoutMs: msg.syncTimeoutMs,
      maxItemsPerCall: msg.maxItemsPerCall,
      maxWorkflowDepth: msg.maxWorkflowDepth,
      budgetTotal: msg.budgetTotal,
      cwd: msg.cwd,
    };
    executeScript(msg.script, msg.args, 0)
      .then((value) => parentPort.postMessage({ type: "result", value }))
      .catch((err) => {
        const rpcId = rpcIdFromError(err);
        parentPort.postMessage({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          ...(rpcId === undefined ? {} : { rpcId }),
        });
      });
    return;
  }

  if (typeof msg.id === "number" && pending.has(msg.id)) {
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    tokensSpent += typeof msg.tokensDelta === "number" ? msg.tokensDelta : 0;
    if (msg.ok) {
      waiter.resolve(msg.value);
    } else {
      const error = new Error(String(msg.error || "Workflow RPC failed."));
      rpcErrorIds.set(error, msg.id);
      waiter.reject(error);
    }
  }
});

async function executeScript(script, args, depth) {
  const parsed = parseWorkflow(script);
  const result = await executeBody(parsed.meta, parsed.body, args, depth);
  while (outstandingAgentCalls.size > 0) {
    await Promise.all([...outstandingAgentCalls]);
  }
  return { meta: parsed.meta, result };
}

async function executeBody(meta, body, args, depth) {
  let currentPhase;

  function checkAbort() {
    if (aborted) throw new Error("Workflow aborted.");
  }

  function agent(prompt, opts = {}) {
    const call = (async () => {
      checkAbort();
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("agent(prompt): prompt must be a non-empty string.");
      }
      if (workerConfig.budgetTotal != null && budgetRemaining() <= 0) {
        throw new Error("Workflow token budget exhausted.");
      }
      const hasExplicitPhase = Object.prototype.hasOwnProperty.call(
        opts,
        "phase",
      );
      const resolvedPhase =
        hasExplicitPhase && opts.phase != null
          ? String(opts.phase)
          : currentPhase;
      const callOpts = { ...opts, phase: resolvedPhase };
      return await rpc("agent", {
        prompt,
        opts: callOpts,
      });
    })();
    outstandingAgentCalls.add(call);
    void call.then(
      () => outstandingAgentCalls.delete(call),
      () => outstandingAgentCalls.delete(call),
    );
    return call;
  }

  async function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      throw new Error("parallel(thunks): expected an array of functions.");
    }
    if (thunks.length > workerConfig.maxItemsPerCall) {
      throw new Error(
        `parallel(): ${thunks.length} thunks exceeds the ${workerConfig.maxItemsPerCall} cap.`,
      );
    }
    return Promise.all(
      thunks.map((t) =>
        Promise.resolve()
          .then(() => {
            if (typeof t !== "function") {
              throw new Error(
                "parallel(): each item must be a thunk () => Promise.",
              );
            }
            checkAbort();
            return t();
          })
          .catch((err) => {
            if (aborted) throw err;
            return null;
          }),
      ),
    );
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) {
      throw new Error("pipeline(items, ...stages): items must be an array.");
    }
    if (items.length > workerConfig.maxItemsPerCall) {
      throw new Error(
        `pipeline(): ${items.length} items exceeds the ${workerConfig.maxItemsPerCall} cap.`,
      );
    }
    for (const stage of stages) {
      if (typeof stage !== "function") {
        throw new Error("pipeline(): stages must be functions.");
      }
    }
    const fns = stages;
    return Promise.all(
      items.map(async (item, index) => {
        let acc = item;
        try {
          for (const stage of fns) {
            checkAbort();
            acc = await stage(acc, item, index);
          }
          return acc;
        } catch (err) {
          if (aborted) throw err;
          return null;
        }
      }),
    );
  }

  function phase(title) {
    const t = String(title ?? "");
    currentPhase = t;
    parentPort.postMessage({
      type: "progress",
      payload: { kind: "phase", phase: t },
    });
  }

  function log(message) {
    parentPort.postMessage({
      type: "progress",
      payload: { kind: "log", message: String(message ?? "") },
    });
  }

  async function workflow(nameOrRef, childArgs) {
    checkAbort();
    if (depth >= workerConfig.maxWorkflowDepth) {
      throw new Error("workflow() composition is one level deep only.");
    }
    const childScript = await rpc("loadWorkflow", nameOrRef);
    const child = await executeScript(childScript, childArgs, depth + 1);
    return child.result;
  }

  const budget = {
    total: workerConfig.budgetTotal,
    spent: () => tokensSpent,
    remaining: () => budgetRemaining(),
  };

  const sandbox = Object.assign(Object.create(null), {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    workflow,
    args,
    budget,
    console: {
      log: (...a) => log(a.map((x) => workflowStringify(x)).join(" ")),
      error: (...a) => log(a.map((x) => workflowStringify(x)).join(" ")),
      warn: (...a) => log(a.map((x) => workflowStringify(x)).join(" ")),
    },
    Date: makeGuardedDate(),
    Math: makeGuardedMath(),
  });
  Object.defineProperty(sandbox, "cwd", {
    value: workerConfig.cwd,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  try {
    return await runInNewContext(
      "(async () => {\n" + body + "\n})()",
      sandbox,
      {
        filename: "workflow:" + meta.name + ".js",
        timeout: workerConfig.syncTimeoutMs,
        contextCodeGeneration: { strings: false, wasm: false },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`Workflow "${meta.name}" failed: ${msg}`);
    const rpcId = rpcIdFromError(err);
    if (rpcId !== undefined) rpcErrorIds.set(wrapped, rpcId);
    throw wrapped;
  }
}

function budgetRemaining() {
  return workerConfig.budgetTotal == null
    ? Infinity
    : Math.max(0, workerConfig.budgetTotal - tokensSpent);
}
