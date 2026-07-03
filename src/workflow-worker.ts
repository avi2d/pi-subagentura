import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents, readOutput } from "./artifact";
import { debugLog } from "./helpers";
import type { SubagentResult } from "./helpers";
import {
  INTERACTIVE_DEAD_GRACE_TICKS,
  INTERACTIVE_POLL_MS,
  MAX_ITEMS_PER_CALL,
  MAX_TOTAL_AGENTS,
  MAX_WORKFLOW_DEPTH,
  SCHEMA_RETRIES,
  WORKFLOW_SYNC_TIMEOUT_MS,
  WORKFLOW_WALL_TIMEOUT_MS,
  createSemaphore,
  defaultConcurrency,
  defaultProcessConcurrency,
  extractJson,
  parseWorkflow,
  validateSchema,
  type RunWorkflowOptions,
  type Semaphore,
  type WorkflowAgentOpts,
  type WorkflowAgentRunner,
  type WorkflowMeta,
  type WorkflowProgress,
  type WorkflowRunResult,
  zeroUsage,
} from "./workflow-core";
import {
  cancelInteractiveSubagent,
  isPaneAlive,
  type InteractiveSubagentState,
} from "./interactive-tmux";

// ── Engine (shared across nested workflows) ──────────────────────────
// ── Engine (shared across nested workflows) ──────────────────────────

interface Engine {
  runAgent: WorkflowAgentRunner;
  abort: AbortController;
  signal: AbortSignal;
  closed: boolean;
  onProgress?: (p: WorkflowProgress) => void;
  sem: Semaphore;
  processSem: Semaphore;
  loadWorkflow?: (name: string) => string | null;
  budgetTotal: number | null;
  workflowTimeoutMs: number;
  counters: {
    agentsSpawned: number;
    errorCount: number;
    tokensSpent: number;
    runningCount: number;
  };
  phases: string[];
}

export async function runWorkflow(
  script: string,
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const abort = new AbortController();
  const forwardAbort = () => abort.abort();
  if (opts.signal?.aborted) {
    abort.abort();
  } else {
    opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const engine: Engine = {
    runAgent: opts.runAgent,
    abort,
    signal: abort.signal,
    closed: false,
    onProgress: opts.onProgress,
    sem: createSemaphore(opts.concurrency ?? defaultConcurrency()),
    processSem: createSemaphore(
      opts.processConcurrency ?? defaultProcessConcurrency(),
    ),
    loadWorkflow: opts.loadWorkflow,
    budgetTotal: opts.budgetTotal ?? null,
    counters: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      runningCount: 0,
    },
    workflowTimeoutMs: opts.workflowTimeoutMs ?? WORKFLOW_WALL_TIMEOUT_MS,
    phases: [],
  };
  try {
    const { meta, result } = await executeScript(script, engine, opts.args, 0);
    return {
      meta,
      result,
      agentsSpawned: engine.counters.agentsSpawned,
      errorCount: engine.counters.errorCount,
      tokensSpent: engine.counters.tokensSpent,
      phases: engine.phases,
    };
  } finally {
    opts.signal?.removeEventListener("abort", forwardAbort);
  }
}

const WORKFLOW_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { runInNewContext } = require("node:vm");

let nextRpcId = 1;
const pending = new Map();
let aborted = false;
let workerConfig = {
  syncTimeoutMs: 30000,
  maxItemsPerCall: 4096,
  maxWorkflowDepth: 1,
  budgetTotal: null,
};
let tokensSpent = 0;

function rpc(method, payload) {
  if (aborted) return Promise.reject(new Error("Workflow aborted."));
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ id, method, payload });
  });
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "abort") {
    aborted = true;
    for (const { reject } of pending.values()) reject(new Error("Workflow aborted."));
    pending.clear();
    return;
  }
  if (msg.type === "init") {
    workerConfig = {
      syncTimeoutMs: msg.syncTimeoutMs,
      maxItemsPerCall: msg.maxItemsPerCall,
      maxWorkflowDepth: msg.maxWorkflowDepth,
      budgetTotal: msg.budgetTotal,
    };
    executeScript(msg.script, msg.args, 0)
      .then((value) => parentPort.postMessage({ type: "result", value }))
      .catch((err) =>
        parentPort.postMessage({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return;
  }
  if (typeof msg.id === "number" && pending.has(msg.id)) {
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.value);
    else waiter.reject(new Error(String(msg.error || "Workflow RPC failed.")));
  }
});

async function executeScript(script, args, depth) {
  const parsed = parseWorkflow(script);
  const result = await executeBody(parsed.meta, parsed.body, args, depth);
  return { meta: parsed.meta, result };
}

async function executeBody(meta, body, args, depth) {
  function checkAbort() {
    if (aborted) throw new Error("Workflow aborted.");
  }
  async function agent(prompt, opts = {}) {
    checkAbort();
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("agent(prompt): prompt must be a non-empty string.");
    }
    if (workerConfig.budgetTotal != null && budgetRemaining() <= 0) {
      throw new Error("Workflow token budget exhausted.");
    }
    const res = await rpc("agent", { prompt, opts });
    tokensSpent += res && typeof res.tokensDelta === "number" ? res.tokensDelta : 0;
    return res ? res.value : null;
  }
  async function parallel(thunks) {
    if (!Array.isArray(thunks)) throw new Error("parallel(thunks): expected an array of functions.");
    if (thunks.length > workerConfig.maxItemsPerCall) {
      throw new Error("parallel(): " + thunks.length + " thunks exceeds the " + workerConfig.maxItemsPerCall + " cap.");
    }
    return Promise.all(
      thunks.map((t) =>
        Promise.resolve()
          .then(() => {
            if (typeof t !== "function") throw new Error("parallel(): each item must be a thunk () => Promise.");
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
    if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages): items must be an array.");
    if (items.length > workerConfig.maxItemsPerCall) {
      throw new Error("pipeline(): " + items.length + " items exceeds the " + workerConfig.maxItemsPerCall + " cap.");
    }
    const fns = stages.filter((s) => typeof s === "function");
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
    parentPort.postMessage({ type: "progress", payload: { kind: "phase", phase: t } });
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
  const sandbox = {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    workflow,
    args,
    budget,
    console: {
      log: (...a) => log(a.map((x) => stringify(x)).join(" ")),
      error: (...a) => log(a.map((x) => stringify(x)).join(" ")),
      warn: (...a) => log(a.map((x) => stringify(x)).join(" ")),
    },
    Date: makeGuardedDate(),
    Math: makeGuardedMath(),
  };
  try {
    return await runInNewContext("(async () => {\n" + body + "\n})()", sandbox, {
      filename: "workflow:" + meta.name + ".js",
      timeout: workerConfig.syncTimeoutMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error("Workflow \"" + meta.name + "\" failed: " + msg);
  }
}

function budgetRemaining() {
  return workerConfig.budgetTotal == null
    ? Infinity
    : Math.max(0, workerConfig.budgetTotal - tokensSpent);
}

function parseWorkflow(script) {
  const metaRe = /(^|\n)\s*export\s+const\s+meta\s*=\s*/;
  const m = metaRe.exec(script);
  if (!m) {
    throw new Error("Workflow script must declare \`export const meta = { name, description }\` as a pure literal.");
  }
  const braceStart = script.indexOf("{", m.index + m[0].length);
  if (braceStart === -1) throw new Error("\`export const meta\` must be assigned an object literal \`{ ... }\`.");
  const braceEnd = matchBrace(script, braceStart);
  const metaText = script.slice(braceStart, braceEnd + 1);
  let meta;
  try {
    meta = runInNewContext("(" + metaText + ")", {
      Date: makeGuardedDate(),
      Math: makeGuardedMath(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error("Workflow \`meta\` must be a pure literal (no variables/calls). Eval failed: " + msg);
  }
  if (!meta || typeof meta !== "object") throw new Error("Workflow \`meta\` did not evaluate to an object.");
  if (typeof meta.name !== "string" || !meta.name) throw new Error("Workflow \`meta.name\` must be a non-empty string.");
  if (typeof meta.description !== "string" || !meta.description) throw new Error("Workflow \`meta.description\` must be a non-empty string.");
  let trailing = braceEnd + 1;
  if (script[trailing] === ";") trailing++;
  const body = (script.slice(0, m.index) + script.slice(trailing))
    .replace(/(^|\n)\s*export\s+default\s+/g, "$1")
    .replace(/(^|\n)\s*export\s+/g, "$1");
  return { meta, body };
}

function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "\`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error("Unbalanced braces in \`export const meta\` literal.");
}

function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return src.length;
}

function makeGuardedDate() {
  const Guard = function (...a) {
    if (a.length === 0) {
      throw new Error("\`new Date()\` with no args is non-deterministic and unavailable in workflows. Pass a timestamp via \`args\`.");
    }
    return new Date(...a);
  };
  Guard.now = () => {
    throw new Error("\`Date.now()\` is non-deterministic and unavailable in workflows. Pass a timestamp via \`args\`.");
  };
  Guard.parse = Date.parse;
  Guard.UTC = Date.UTC;
  Guard.prototype = Date.prototype;
  return Guard;
}

function makeGuardedMath() {
  return new Proxy(Math, {
    get(target, prop, recv) {
      if (prop === "random") {
        return () => {
          throw new Error("\`Math.random()\` is non-deterministic and unavailable in workflows. Vary by index instead.");
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

function stringify(x) {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
`;

type WorkerRpcRequest = { id: number; method: string; payload: any };
type WorkerRpcResponse = {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
};

async function executeScript(
  script: string,
  engine: Engine,
  args: unknown,
  _depth: number,
): Promise<{ meta: WorkflowMeta; result: unknown }> {
  const emit = (
    p: Omit<
      WorkflowProgress,
      "agentsSpawned" | "errorCount" | "tokensSpent" | "runningCount"
    >,
  ) => {
    if (engine.closed) return;
    if (p.kind === "phase" && p.phase) engine.phases.push(p.phase);
    engine.onProgress?.({
      ...p,
      agentsSpawned: engine.counters.agentsSpawned,
      errorCount: engine.counters.errorCount,
      tokensSpent: engine.counters.tokensSpent,
      runningCount: engine.counters.runningCount,
    });
  };

  const runAgentCall = async (payload: {
    prompt: unknown;
    opts?: WorkflowAgentOpts;
  }): Promise<{ value: unknown; tokensDelta: number }> => {
    const prompt = payload.prompt;
    const agentOpts = payload.opts ?? {};
    if (engine.signal?.aborted) throw new Error("Workflow aborted.");
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("agent(prompt): prompt must be a non-empty string.");
    }
    if (
      engine.budgetTotal != null &&
      engine.budgetTotal - engine.counters.tokensSpent <= 0
    ) {
      throw new Error("Workflow token budget exhausted.");
    }

    const hasSchema = agentOpts.schema != null;
    const isProcess = agentOpts.isolation === "process";
    const sem = isProcess ? engine.processSem : engine.sem;
    await sem.acquire();
    let tokensDelta = 0;
    try {
      let lastErr = "";
      const attempts = hasSchema ? SCHEMA_RETRIES : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (engine.signal?.aborted) throw new Error("Workflow aborted.");
        if (engine.counters.agentsSpawned >= MAX_TOTAL_AGENTS) {
          throw new Error(
            `Workflow exceeded the ${MAX_TOTAL_AGENTS}-agent lifetime cap.`,
          );
        }
        engine.counters.agentsSpawned++;
        engine.counters.runningCount++;
        try {
          // Emit *before* awaiting runAgent so status polling sees in-flight process agents.
          emit({
            kind: "agent_start",
            label: agentOpts.label,
            phase: agentOpts.phase,
            model: agentOpts.model,
          });
          const finalPrompt = hasSchema
            ? buildSchemaPrompt(prompt, agentOpts.schema, attempt, lastErr)
            : prompt;
          const res = await engine.runAgent({
            prompt: finalPrompt,
            persona: agentOpts.persona,
            model: agentOpts.model,
            signal: engine.signal,
            isolation: agentOpts.isolation,
            label: agentOpts.label,
          });
          const outTokens = res.usage?.output ?? 0;
          tokensDelta += outTokens;
          engine.counters.tokensSpent += outTokens;

          if (res.isError) {
            engine.counters.errorCount++;
            return { value: null, tokensDelta };
          }
          if (!hasSchema) return { value: res.output, tokensDelta };

          const raw = extractJson(res.output);
          if (raw != null) {
            try {
              const parsed = JSON.parse(raw);
              const verrs = validateSchema(parsed, agentOpts.schema);
              if (verrs.length === 0) return { value: parsed, tokensDelta };
              lastErr = verrs.slice(0, 5).join("; ");
            } catch (e) {
              lastErr = `JSON parse error: ${e instanceof Error ? e.message : String(e)}`;
            }
          } else {
            lastErr = "no JSON object/array found in output";
          }
        } finally {
          engine.counters.runningCount--;
          emit({
            kind: "agent_done",
            label: agentOpts.label,
            phase: agentOpts.phase,
            model: agentOpts.model,
          });
        }
      }

      engine.counters.errorCount++;
      emit({
        kind: "log",
        message: `agent(schema) failed after ${attempts} attempts: ${lastErr}`,
      });
      return { value: null, tokensDelta };
    } finally {
      sem.release();
    }
  };

  return runWorkflowWorker(script, args, engine, emit, runAgentCall);
}

function loadWorkflowRef(nameOrRef: unknown, engine: Engine): string | null {
  if (typeof nameOrRef === "string") {
    return engine.loadWorkflow ? engine.loadWorkflow(nameOrRef) : null;
  }
  if (
    nameOrRef &&
    typeof nameOrRef === "object" &&
    typeof (nameOrRef as any).scriptPath === "string"
  ) {
    const p = (nameOrRef as any).scriptPath as string;
    if (!existsSync(p))
      throw new Error(`workflow(): scriptPath not found: ${p}`);
    return readFileSync(p, "utf8");
  }
  throw new Error(
    "workflow(nameOrRef): expected a saved-workflow name or { scriptPath }.",
  );
}

function runWorkflowWorker(
  script: string,
  args: unknown,
  engine: Engine,
  emit: (
    p: Omit<WorkflowProgress, "agentsSpawned" | "errorCount" | "tokensSpent">,
  ) => void,
  runAgentCall: (payload: {
    prompt: unknown;
    opts?: WorkflowAgentOpts;
  }) => Promise<{ value: unknown; tokensDelta: number }>,
): Promise<{ meta: WorkflowMeta; result: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKFLOW_WORKER_SOURCE, { eval: true });
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      engine.closed = true;
      cleanup();
      worker.terminate().catch(() => {});
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const done = (value: { meta: WorkflowMeta; result: unknown }) => {
      if (settled) return;
      settled = true;
      engine.closed = true;
      cleanup();
      worker.terminate().catch(() => {});
      resolve(value);
    };
    const onAbort = () => fail(new Error("Workflow aborted."));
    const timeout = setTimeout(() => {
      const err = new Error(
        `Workflow timed out after ${engine.workflowTimeoutMs}ms; the worker was terminated.`,
      );
      fail(err);
      engine.abort.abort(err);
    }, engine.workflowTimeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      engine.signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };

    engine.signal?.addEventListener("abort", onAbort, { once: true });
    if (engine.signal?.aborted) {
      onAbort();
      return;
    }

    worker.on("message", (msg: WorkerRpcRequest | WorkerRpcResponse | any) => {
      if (settled || !msg || typeof msg !== "object") return;
      if (msg.type === "result") {
        done(msg.value);
        return;
      }
      if (msg.type === "error") {
        fail(new Error(String(msg.error ?? "Workflow worker failed.")));
        return;
      }
      if (msg.type === "progress") {
        emit(msg.payload);
        return;
      }
      if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
      handleWorkerRpc(
        msg as WorkerRpcRequest,
        worker,
        engine,
        runAgentCall,
      ).catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        postWorkerResponse(worker, { id: msg.id, ok: false, error });
      });
    });
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!settled && code !== 0)
        fail(new Error(`Workflow worker exited with code ${code}.`));
    });
    worker.postMessage({
      type: "init",
      script,
      args,
      budgetTotal: engine.budgetTotal,
      syncTimeoutMs: WORKFLOW_SYNC_TIMEOUT_MS,
      maxItemsPerCall: MAX_ITEMS_PER_CALL,
      maxWorkflowDepth: MAX_WORKFLOW_DEPTH,
    });
  });
}

async function handleWorkerRpc(
  msg: WorkerRpcRequest,
  worker: Worker,
  engine: Engine,
  runAgentCall: (payload: {
    prompt: unknown;
    opts?: WorkflowAgentOpts;
  }) => Promise<{ value: unknown; tokensDelta: number }>,
): Promise<void> {
  if (msg.method === "agent") {
    const value = await runAgentCall(msg.payload);
    postWorkerResponse(worker, { id: msg.id, ok: true, value });
    return;
  }
  if (msg.method === "loadWorkflow") {
    const script = loadWorkflowRef(msg.payload, engine);
    if (script == null && typeof msg.payload === "string") {
      throw new Error(`workflow(): no saved workflow named "${msg.payload}".`);
    }
    postWorkerResponse(worker, { id: msg.id, ok: true, value: script });
    return;
  }
  throw new Error(`Unknown workflow worker RPC method: ${msg.method}`);
}

function postWorkerResponse(worker: Worker, msg: WorkerRpcResponse): void {
  try {
    worker.postMessage(msg);
  } catch {
    /* worker may already be terminated after cancellation */
  }
}

export function stringify(x: unknown): string {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function buildSchemaPrompt(
  prompt: string,
  schema: unknown,
  attempt: number,
  lastErr: string,
): string {
  const schemaText = JSON.stringify(schema, null, 2);
  const retry =
    attempt > 0
      ? `\n\nYour previous response did not satisfy the schema (${lastErr}). Return corrected JSON only.`
      : "";
  return (
    `${prompt}\n\n` +
    `Respond with ONLY a single JSON value that conforms to this JSON Schema. ` +
    `No prose, no markdown fences, no commentary.\n\nJSON Schema:\n${schemaText}${retry}`
  );
}

// ── tmux/zellij process-backed agents ────────────────────────────────

/** Build a SubagentArtifact view over an interactive sub-agent's on-disk artifact dir. */
function artifactFor(state: InteractiveSubagentState) {
  return {
    id: state.id,
    dir: state.artifactDir,
    statusFile: join(state.artifactDir, "events.ndjson"),
    outputFile: join(state.artifactDir, "output.md"),
  };
}

/**
 * Await a process-backed (tmux/zellij) sub-agent's terminal event by polling its artifact dir,
 * then read its output.md. Honors the abort signal and detects a dead pane that never completed.
 */
export async function awaitInteractiveResult(
  state: InteractiveSubagentState,
  signal: AbortSignal | undefined,
  pollMs = INTERACTIVE_POLL_MS,
): Promise<SubagentResult> {
  const art = artifactFor(state);
  let deadTicks = 0;
  for (;;) {
    if (signal?.aborted) {
      try {
        cancelInteractiveSubagent(state.id);
      } catch {
        /* best effort */
      }
      return {
        isError: true,
        output: "",
        usage: zeroUsage(),
        model: undefined,
        errorMessage: "aborted",
      };
    }
    const events = readEvents(art);
    const terminal = [...events]
      .reverse()
      .find(
        (e) =>
          e.type === "done" || e.type === "error" || e.type === "cancelled",
      );
    if (terminal) {
      const output = readOutput(art) ?? "(no output)";
      if (terminal.type === "done") {
        return {
          isError: false,
          output,
          usage: zeroUsage(),
          model: state.model ?? "process",
        };
      }
      return {
        isError: true,
        output,
        usage: zeroUsage(),
        model: undefined,
        errorMessage:
          terminal.message ?? `interactive sub-agent ${terminal.type}`,
      };
    }
    // No terminal event yet — if the pane has died, give it a few grace ticks for a final flush.
    let alive = true;
    try {
      alive = isPaneAlive(state);
    } catch {
      alive = false;
    }
    if (!alive) {
      deadTicks++;
      debugLog("warn", "interactive_dead_pane", {
        deadTicks,
        graceLimit: INTERACTIVE_DEAD_GRACE_TICKS,
      });
      if (deadTicks >= INTERACTIVE_DEAD_GRACE_TICKS) {
        const output = readOutput(art) ?? "(no output)";
        return {
          isError: true,
          output,
          usage: zeroUsage(),
          model: undefined,
          errorMessage: "interactive sub-agent pane exited before completing",
        };
      }
    } else {
      deadTicks = 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
