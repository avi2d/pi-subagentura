import { cpus, homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SubagentResult, Usage } from "./helpers";

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
  /** Defaults to "process" (tmux/zellij); use "in-process" to opt out. */
  isolation?: string;
  /** Accepted for fidelity but a no-op in v2. */
  agentType?: string;
  /** Thinking/reasoning level for the sub-agent. Clamped to model capabilities. */
  thinkingLevel?: ThinkingLevel;
}

export type WorkflowAgentProgress =
  | {
      kind: "phase";
      phase: string;
      message?: string;
      label?: string;
    }
  | {
      kind: "log";
      message: string;
      phase?: string;
      label?: string;
    };

/** Injectable spawn function — the real one wraps startSubagentJob / launchInteractiveSubagent. */
export type WorkflowAgentRunner = (req: {
  prompt: string;
  persona?: string;
  model?: string;
  signal?: AbortSignal;
  isolation?: string;
  label?: string;
  /** Thinking/reasoning level for the sub-agent. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Optional callback for emitting progress events from inside the runner.
   * Used to surface fallback warnings and forward mid-agent live status.
   */
  onProgress?: (event: WorkflowAgentProgress) => void;
  onCancellationSnapshot?: (
    receipt: import("./cancellation-snapshots").CancellationSnapshotReceipt,
  ) => void;
}) => Promise<SubagentResult>;

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
  [k: string]: unknown;
}

export type WorkflowProgress =
  | {
      kind: "phase";
      phase: string;
      message?: string;
      label?: string;
      agentsSpawned: number;
      errorCount: number;
      tokensSpent: number;
      runningCount: number;
      model?: string;
    }
  | {
      kind: "log";
      phase?: string;
      message: string;
      label?: string;
      agentsSpawned: number;
      errorCount: number;
      tokensSpent: number;
      runningCount: number;
      model?: string;
    }
  | {
      kind: "agent_start";
      phase?: string;
      message?: string;
      label?: string;
      agentsSpawned: number;
      errorCount: number;
      tokensSpent: number;
      runningCount: number;
      model?: string;
    }
  | {
      kind: "agent_done";
      phase?: string;
      message?: string;
      label?: string;
      agentsSpawned: number;
      errorCount: number;
      tokensSpent: number;
      runningCount: number;
      model?: string;
    };

export type WorkflowProgressUpdate = {
  [K in WorkflowProgress["kind"]]: Omit<
    Extract<WorkflowProgress, { kind: K }>,
    "agentsSpawned" | "errorCount" | "tokensSpent" | "runningCount"
  >;
}[WorkflowProgress["kind"]];

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
  onCancellationSnapshot?: (
    receipt: import("./cancellation-snapshots").CancellationSnapshotReceipt,
  ) => void;
  concurrency?: number;
  processConcurrency?: number;
  /** Resolve a saved workflow script by name, for `workflow(name, args)` composition. */
  loadWorkflow?: (name: string) => string | null;
  /** Hard wall-clock cap for the workflow VM worker. Defaults to 30 minutes. */
  workflowTimeoutMs?: number;
}

// ── Script parsing ───────────────────────────────────────────────────

import { parseWorkflow } from "./workflow-script";
export { parseWorkflow };

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
  if (matchesType(value, "object")) {
    const obj = value as Record<string, unknown>;
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {};
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(obj, r)) {
          errs.push(`${path}.${r}: required property missing`);
        }
      }
    }
    for (const [k, sub] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        errs.push(...validateSchema(obj[k], sub, `${path}.${k}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errs.push(`${path}.${key}: additional property not allowed`);
        }
      }
    }
  }
  if (matchesType(value, "array")) {
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
    if (schema.items) {
      arr.forEach((el, idx) =>
        errs.push(...validateSchema(el, schema.items, `${path}[${idx}]`)),
      );
    }
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

export function deleteWorkflowScript(
  name: string,
  dir = WORKFLOWS_DIR,
): boolean {
  const safe = sanitizeWorkflowName(name);
  const file = join(dir, `${safe}.js`);
  try {
    unlinkSync(file);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}
