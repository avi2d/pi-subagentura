import { runInNewContext } from "node:vm";
import { cpus, homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SubagentResult, Usage } from "./helpers";

// ── Limits ───────────────────────────────────────────────────────────
// ── Limits ───────────────────────────────────────────────────────────
export const MAX_TOTAL_AGENTS = 1000;
export const MAX_ITEMS_PER_CALL = 4096;
export const SCHEMA_RETRIES = 3;
export const MAX_WORKFLOW_DEPTH = 1; // workflow() composition is one level deep
export const INTERACTIVE_POLL_MS = 1000;
export const INTERACTIVE_DEAD_GRACE_TICKS = 3;
export const WORKFLOW_SYNC_TIMEOUT_MS = 30_000;
export const WORKFLOW_WALL_TIMEOUT_MS = 30 * 60_000;

export function defaultConcurrency(): number {
  const n = cpus()?.length ?? 4;
  return Math.max(1, Math.min(16, n - 2));
}
export function defaultProcessConcurrency(): number {
  const n = cpus()?.length ?? 4;
  return Math.max(1, Math.min(4, n - 2));
}
export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

// ── Public types ─────────────────────────────────────────────────────

/** Options accepted by the injected `agent()` helper. */
export interface WorkflowAgentOpts {
  schema?: unknown;
  label?: string;
  phase?: string;
  model?: string;
  persona?: string;
  /** "process" routes to a tmux/zellij Pi process; otherwise in-process. */
  isolation?: string;
  /** Accepted for fidelity but a no-op in v2. */
  agentType?: string;
}

/** Injectable spawn function — the real one wraps startSubagentJob / launchInteractiveSubagent. */
export type WorkflowAgentRunner = (req: {
  prompt: string;
  persona?: string;
  model?: string;
  signal?: AbortSignal;
  isolation?: string;
  label?: string;
}) => Promise<SubagentResult>;

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
  [k: string]: unknown;
}

export interface WorkflowProgress {
  // "agent_start" fires the moment an agent is launched (counter is incremented), so UIs see
  // mid-run progress. "agent_done" fires after the agent finishes (success, error, or schema fail).
  kind: "phase" | "log" | "agent_start" | "agent_done";
  phase?: string;
  message?: string;
  label?: string;
  agentsSpawned: number;
  errorCount: number;
  tokensSpent: number;
  runningCount: number;
  model?: string;
}

export interface WorkflowRunResult {
  meta: WorkflowMeta;
  result: unknown;
  agentsSpawned: number;
  errorCount: number;
  tokensSpent: number;
  phases: string[];
}

export interface RunWorkflowOptions {
  args?: unknown;
  budgetTotal?: number | null;
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  onProgress?: (p: WorkflowProgress) => void;
  concurrency?: number;
  processConcurrency?: number;
  /** Resolve a saved workflow script by name, for `workflow(name, args)` composition. */
  loadWorkflow?: (name: string) => string | null;
  /** Hard wall-clock cap for the workflow VM worker. Defaults to 30 minutes. */
  workflowTimeoutMs?: number;
}

// ── Script parsing ───────────────────────────────────────────────────

/**
 * Split a workflow script into its static `meta` literal and the executable body.
 * `meta` must be a pure literal — it is evaluated in a helperless context, so a literal that
 * references `agent`/etc. throws.
 */
export function parseWorkflow(script: string): {
  meta: WorkflowMeta;
  body: string;
} {
  const metaRe = /(^|\n)\s*export\s+const\s+meta\s*=\s*/;
  const m = metaRe.exec(script);
  if (!m) {
    throw new Error(
      "Workflow script must declare `export const meta = { name, description }` as a pure literal.",
    );
  }
  const braceStart = script.indexOf("{", m.index + m[0].length);
  if (braceStart === -1) {
    throw new Error(
      "`export const meta` must be assigned an object literal `{ ... }`.",
    );
  }
  const braceEnd = matchBrace(script, braceStart);
  const metaText = script.slice(braceStart, braceEnd + 1);

  let meta: WorkflowMeta;
  try {
    // Evaluate in a helperless context with determinism guards present — a pure literal needs none
    // of them, so any reference (to a helper, or to Date/Math) throws and is reported clearly.
    meta = runInNewContext(`(${metaText})`, {
      Date: makeGuardedDate(),
      Math: makeGuardedMath(),
    }) as WorkflowMeta;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Workflow \`meta\` must be a pure literal (no variables/calls). Eval failed: ${msg}`,
    );
  }
  if (!meta || typeof meta !== "object") {
    throw new Error("Workflow `meta` did not evaluate to an object.");
  }
  if (typeof meta.name !== "string" || !meta.name) {
    throw new Error("Workflow `meta.name` must be a non-empty string.");
  }
  if (typeof meta.description !== "string" || !meta.description) {
    throw new Error("Workflow `meta.description` must be a non-empty string.");
  }

  // Remove the whole `export const meta = {...};` span from the body, then defensively strip any
  // remaining line-anchored `export`/`export default` tokens (workflow bodies are top-level code).
  let trailing = braceEnd + 1;
  if (script[trailing] === ";") trailing++;
  const body = (script.slice(0, m.index) + script.slice(trailing))
    .replace(/(^|\n)\s*export\s+default\s+/g, "$1")
    .replace(/(^|\n)\s*export\s+/g, "$1");
  return { meta, body };
}

/** Brace-match starting at `openIdx` (which must point at `{`), skipping strings and comments. */
function matchBrace(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
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
  throw new Error("Unbalanced braces in `export const meta` literal.");
}

/** Given index of a quote char, return index just past the closing quote. */
function skipString(src: string, start: number): number {
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

// ── Determinism guards ───────────────────────────────────────────────

function makeGuardedDate(): typeof Date {
  const Guard = function (this: unknown, ...a: unknown[]) {
    if (a.length === 0) {
      throw new Error(
        "`new Date()` with no args is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
      );
    }
    // @ts-expect-error spread into Date constructor
    return new Date(...a);
  } as any;
  Guard.now = () => {
    throw new Error(
      "`Date.now()` is non-deterministic and unavailable in workflows. Pass a timestamp via `args`.",
    );
  };
  Guard.parse = Date.parse;
  Guard.UTC = Date.UTC;
  Guard.prototype = Date.prototype;
  return Guard as typeof Date;
}

function makeGuardedMath(): Math {
  return new Proxy(Math, {
    get(target, prop, recv) {
      if (prop === "random") {
        return () => {
          throw new Error(
            "`Math.random()` is non-deterministic and unavailable in workflows. Vary by index instead.",
          );
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

// ── Minimal JSON-Schema validation (dependency-free) ─────────────────

/** Strip markdown fences and extract the first balanced JSON value from free-form model text. */
export function extractJson(text: string): string | null {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let i = start;
  let inStr: string | null = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Validate `value` against a small JSON-Schema subset. Returns a list of human-readable errors. */
export function validateSchema(
  value: unknown,
  schema: any,
  path = "$",
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const errs: string[] = [];
  const t = schema.type as string | string[] | undefined;
  if (t) {
    const types = Array.isArray(t) ? t : [t];
    if (!types.some((ty) => matchesType(value, ty))) {
      errs.push(
        `${path}: expected type ${types.join("|")}, got ${jsType(value)}`,
      );
      return errs; // type mismatch — deeper checks are noise
    }
  }
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.some((e: unknown) => deepEqual(e, value))) {
      errs.push(`${path}: value not in enum`);
    }
  }
  if (matchesType(value, "object") && schema.properties) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!(r in obj)) errs.push(`${path}.${r}: required property missing`);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (k in obj) errs.push(...validateSchema(obj[k], sub, `${path}.${k}`));
    }
  }
  if (matchesType(value, "array") && schema.items) {
    const arr = value as unknown[];
    if (typeof schema.minItems === "number" && arr.length < schema.minItems) {
      errs.push(
        `${path}: expected >= ${schema.minItems} items, got ${arr.length}`,
      );
    }
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems) {
      errs.push(
        `${path}: expected <= ${schema.maxItems} items, got ${arr.length}`,
      );
    }
    arr.forEach((el, idx) =>
      errs.push(...validateSchema(el, schema.items, `${path}[${idx}]`)),
    );
  }
  return errs;
}

function matchesType(v: unknown, ty: string): boolean {
  switch (ty) {
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && !Number.isNaN(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return true;
  }
}

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== typeof b ||
    a === null ||
    b === null ||
    typeof a !== "object"
  )
    return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

// ── Concurrency semaphore ────────────────────────────────────────────

export interface Semaphore {
  acquire: () => Promise<void>;
  release: () => void;
}

export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      const tryRun = () => {
        if (active < max) {
          active++;
          resolve();
        } else {
          queue.push(tryRun);
        }
      };
      tryRun();
    });
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  return { acquire, release };
}

// ── Saved workflows ──────────────────────────────────────────────────

export const WORKFLOWS_DIR = join(homedir(), ".pi-subagentura", "workflows");

export function sanitizeWorkflowName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(
      `Invalid workflow name ${JSON.stringify(name)}; use lowercase letters, digits, and hyphens (max 64).`,
    );
  }
  return name;
}

export function saveWorkflowScript(
  name: string,
  script: string,
  dir = WORKFLOWS_DIR,
): string {
  const safe = sanitizeWorkflowName(name);
  parseWorkflow(script); // validate before persisting
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${safe}.js`);
  writeFileSync(file, script, { encoding: "utf8", mode: 0o600 });
  return file;
}

export function loadWorkflowScript(
  name: string,
  dir = WORKFLOWS_DIR,
): string | null {
  let safe: string;
  try {
    safe = sanitizeWorkflowName(name);
  } catch {
    return null;
  }
  const file = join(dir, `${safe}.js`);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function listSavedWorkflows(
  dir = WORKFLOWS_DIR,
): Array<{ name: string; description: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of readdirSync(dir)) {
    const m = /^(.+)\.js$/.exec(entry);
    if (!m) continue;
    let description = "";
    try {
      description = parseWorkflow(readFileSync(join(dir, entry), "utf8")).meta
        .description;
    } catch {
      description = "(unparseable)";
    }
    out.push({ name: m[1], description });
  }
  return out;
}
