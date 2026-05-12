/**
 * Shared helpers for pi-subagentura
 *
 * Exported so both subagent.ts and test files can import them.
 * Keeps helper logic in one place — single source of truth.
 */

import { randomBytes } from "node:crypto";
import { getModel, getProviders } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

// Note: Model<TApi> and AgentToolResult<T> are SDK generics. We use `unknown` as
// the type argument to avoid strict generic instantiation issues with tsc.
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Milliseconds to wait before showing activeTool in the live status preview.
 * Prevents UI flicker for fast tool executions that start and end within this window.
 *
 * Note: If Pi adds new model providers, update KNOWN_PROVIDERS below.
 */
export const ACTIVE_TOOL_DEBOUNCE_MS = 150;

// Note: If Pi adds new providers, getProviders() from @mariozechner/pi-ai will
// return them automatically. We no longer maintain a hardcoded list.

// ── Types ───────────────────────────────────────────────────────────

export interface SubagentResult {
  output: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
  model?: string;
  isError: boolean;
  errorMessage?: string;
}

export interface SubagentLiveStatus {
  turn: number;
  activeTool?: { name: string; args: Record<string, unknown> };
  output: string;
  usage: SubagentResult["usage"];
}

// ── Async Job Types ─────────────────────────────────────────────────

export type JobStatus = "running" | "done" | "error" | "cancelled";

/** Notification delivery mode for async subagent completion */
export type NotifyOnComplete = "notify" | "inject";

export interface JobState {
  id: string;
  status: JobStatus;
  liveStatus: SubagentLiveStatus;
  result?: SubagentResult;
  session: AgentSession;
  startedAt: number;
  promise: Promise<SubagentResult>;
  modelLabel?: string;
  /** Notification mode requested by spawner's notifyOnComplete param */
  notifyOnComplete?: NotifyOnComplete;
  /** At-most-once delivery guard */
  notificationDelivered?: boolean;
  /** Set true by get_subagent_result to suppress redundant notification */
  resultRetrieved?: boolean;
  /** Optional TTL in ms for completed job retention */
  maxAge?: number;
}

// ── Job Registry ────────────────────────────────────────────────────

/**
 * Persisted job registry using global to survive module reloads (jiti).
 *
 * Lifecycle:
 *   - Jobs added on async subagent spawn
 *   - Completed/error jobs persist indefinitely (no TTL)
 *   - Cancelled jobs removed immediately
 *   - All jobs lost on Pi restart (in-memory only)
 */

// Use 'global' for Node.js global, fall back to globalThis
const g = typeof global !== "undefined" ? global : globalThis;

// Create or reuse the registry on the global object
if (!g.__piSubagenturaRegistry) {
  g.__piSubagenturaRegistry = new Map<string, JobState>();
}

export const jobRegistry = g.__piSubagenturaRegistry as Map<string, JobState>;

// Declare global piref for notification delivery (set by extension factory, read by delivery code)
declare global {
  var __piSubagenturaPiRef: unknown; // ExtensionAPI ref — set in subagent.ts factory
}

// Initialize the global pi ref
if (!g.__piSubagenturaPiRef) {
  g.__piSubagenturaPiRef = undefined;
}

/** Jobs persist indefinitely — no automatic expiration */
export const JOB_CLEANUP_TTL_MS = 0;

/** Maximum number of jobs to retain in the registry */
export const MAX_REGISTRY_SIZE = 100;

/** Remove the oldest completed or error job from the registry */
export function pruneOldestJob(): boolean {
  for (const [jobId, job] of jobRegistry) {
    if (job.status === "done" || job.status === "error") {
      jobRegistry.delete(jobId);
      return true;
    }
  }
  return false;
}

/** Remove all completed and error jobs from the registry. Returns count removed. */
export function pruneCompletedJobs(): number {
  let removed = 0;
  for (const [jobId, job] of jobRegistry) {
    if (job.status === "done" || job.status === "error") {
      jobRegistry.delete(jobId);
      removed++;
    }
  }
  return removed;
}

export function scheduleJobCleanup(
  jobId: string,
  immediate = false,
  maxAge?: number,
): void {
  if (!immediate) {
    if (maxAge && maxAge > 0) {
      setTimeout(() => {
        jobRegistry.delete(jobId);
      }, maxAge);
    }
    return; // persist indefinitely unless maxAge specified
  }
  setTimeout(() => {
    jobRegistry.delete(jobId);
  }, 0);
}

/** Generate a unique job ID (16 hex chars from crypto.randomBytes) */
export function generateJobId(): string {
  // Uses randomBytes for Node 18 compatibility (randomUUID needs Node 19+)
  return randomBytes(8).toString("hex");
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a model from a string identifier and an optional default.
 *
 * The caller (LLM agent) is responsible for providing the correct model id.
 * This function does NOT guess — it only does exact lookups:
 *   1. undefined → defaultModel
 *   2. Use parent modelRegistry (has extension-added models like minimax)
 *   3. "provider/id" format → exact getModel lookup (global static registry)
 *   4. Bare id → exact getModel scan across all providers (global static registry)
 *   5. Falls back to defaultModel when nothing matches
 */
export function resolveModel(
  modelId: string | undefined,
  // @ts-expect-error — Model<TApi> requires type arg; unknown is a safe placeholder
  defaultModel: Model | undefined,
  parentModelRegistry?: ModelRegistry,
) {
  if (!modelId) return defaultModel;

  // 1. Try parent modelRegistry first (has extension-added models like minimax)
  if (parentModelRegistry) {
    const allModels = parentModelRegistry.getAll();
    const availableModels = parentModelRegistry.getAvailable();

    if (modelId.includes("/")) {
      const [provider, id] = modelId.split("/", 2);
      // Exact match
      const exact = parentModelRegistry.find(provider, id);
      if (exact) return exact as any;
      // Case-insensitive provider match
      for (const m of allModels) {
        if (m.provider.toLowerCase() === provider.toLowerCase() && m.id === id) {
          return m as any;
        }
      }
    } else {
      const needle = modelId.toLowerCase();

      // 1) Exact model ID match
      for (const m of allModels) {
        if (m.id.toLowerCase() === needle) return m as any;
      }

      // 2) Provider name match — pick best model from that provider (prefer available)
      for (const m of allModels) {
        if (m.provider.toLowerCase() === needle) {
          // Found matching provider — check if any model from it is available
          const providerAvailable = availableModels.find(
            (a) => a.provider === m.provider,
          );
          if (providerAvailable) return providerAvailable as any;
          // No available model — return any model from this provider
          return m as any;
        }
      }

      // 3) Model name match (case-insensitive substring)
      for (const m of allModels) {
        if (m.name?.toLowerCase().includes(needle)) return m as any;
      }

      // 4) Provider name substring match (e.g. "mini" matches "minimax")
      for (const m of allModels) {
        if (m.provider.toLowerCase().includes(needle)) return m as any;
      }
    }
  }

  // 2. Fall back to global static registry (built-in models only)
  if (modelId.includes("/")) {
    const [provider, id] = modelId.split("/", 2);
    // @ts-expect-error — getModel requires KnownProvider union; we trust the caller
    return getModel(provider, id) ?? defaultModel;
  }

  // Bare id — exact match across all providers
  for (const provider of getProviders()) {
    // @ts-expect-error — KnownProvider cast needed; string is assignable to it at runtime
    const found = getModel(provider, modelId);
    if (found) return found;
  }

  return defaultModel;
}
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(
  u: SubagentResult["usage"],
  model?: string,
): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function buildLiveUpdate(
  status: SubagentLiveStatus,
  model?: string,
  // @ts-expect-error — AgentToolResult<T> requires type arg; unknown is a safe placeholder
): AgentToolResult {
  return {
    content: [{ type: "text", text: status.output }],
    details: {
      status: "running",
      subagentStatus: status,
      model,
    },
  };
}

// ── startSubagentJob ────────────────────────────────────────────────

export interface StartSubagentJobParams {
  task: string;
  persona: string | undefined;
  modelOverride: string | undefined;
  cwd: string;
  contextText: string | null;
  signal: AbortSignal | undefined;
  // @ts-expect-error — AgentToolResult<T> requires type arg
  onUpdate: ((partial: AgentToolResult) => void) | undefined;
  // @ts-expect-error — Model<TApi> requires type arg
  defaultModel: Model | undefined;
  maxAge?: number;
  /** Parent session's model registry for resolving extension-added models (e.g. minimax) */
  parentModelRegistry?: ModelRegistry;
}

export interface StartSubagentJobResult {
  jobId: string;
  jobPromise: Promise<SubagentResult>;
  session: AgentSession;
  liveStatus: SubagentLiveStatus;
  modelLabel?: string;
}

/**
 * Create a subagent session and start its prompt execution.
 *
 * Returns immediately with { jobId, jobPromise, session, liveStatus }.
 * The jobPromise resolves to a SubagentResult when the subagent completes.
 * The liveStatus object is mutated in real-time by the event subscriber.
 *
 * This is the shared core used by both sync (runSubagent) and async paths.
 */
export async function startSubagentJob(
  params: StartSubagentJobParams,
): Promise<StartSubagentJobResult> {
  const {
    task,
    persona,
    modelOverride,
    cwd,
    contextText,
    signal,
    onUpdate,
    defaultModel,
    parentModelRegistry,
  } = params;

  // Enforce registry size cap before adding a new job
  while (jobRegistry.size >= MAX_REGISTRY_SIZE) {
    if (!pruneOldestJob()) break; // no old jobs to evict, allow slight overcap
  }

  const jobId = generateJobId();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // Resolve model: exact match only, fallback to default
  // Uses parent's modelRegistry to find extension-added models (e.g. minimax)
  const targetModel = resolveModel(modelOverride, defaultModel, parentModelRegistry);
  const modelLabel = targetModel
    ? `${targetModel.provider}/${targetModel.id}`
    : undefined;

  let handleAbort: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  const liveStatus: SubagentLiveStatus = {
    turn: 0,
    output: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
  };

  // Debounce activeTool updates to prevent flickering on fast tool calls.
  // When onUpdate is undefined (async path), skip the debounce entirely —
  // no rendering to flicker, and the timer overhead is wasted.
  let activeToolTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingActiveTool: SubagentLiveStatus["activeTool"] = undefined;

  function setActiveToolDebounced(tool: SubagentLiveStatus["activeTool"]) {
    pendingActiveTool = tool;
    if (activeToolTimer) {
      clearTimeout(activeToolTimer);
      activeToolTimer = undefined;
    }
    if (tool) {
      if (!onUpdate) {
        // Async path: no rendering, apply immediately
        liveStatus.activeTool = tool;
        return;
      }
      activeToolTimer = setTimeout(() => {
        activeToolTimer = undefined;
        liveStatus.activeTool = pendingActiveTool;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
      }, ACTIVE_TOOL_DEBOUNCE_MS);
    } else {
      if (liveStatus.activeTool) {
        liveStatus.activeTool = undefined;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
      }
    }
  }

  // Create session
  const session = (
    await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      model: targetModel,
      cwd,
    })
  ).session;

  // Wire abort signal
  if (signal) {
    handleAbort = () => {
      session.abort().catch(() => {});
    };
    if (signal.aborted) {
      handleAbort();
    } else {
      signal.addEventListener("abort", handleAbort);
    }
  }

  // Wire session events
  unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "turn_start": {
        liveStatus.turn++;
        liveStatus.usage.turns = liveStatus.turn;
        liveStatus.output = "";
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
        break;
      }
      case "tool_execution_start": {
        setActiveToolDebounced({
          name: event.toolName,
          args: event.args as Record<string, unknown>,
        });
        break;
      }
      case "tool_execution_end": {
        setActiveToolDebounced(undefined);
        break;
      }
      case "turn_end": {
        if (activeToolTimer) {
          clearTimeout(activeToolTimer);
          activeToolTimer = undefined;
        }
        liveStatus.activeTool = undefined;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
        break;
      }
      case "message_update": {
        if (event.assistantMessageEvent.type === "text_delta") {
          liveStatus.output += event.assistantMessageEvent.delta;
          onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
        }
        break;
      }
    }
  });

  // Build prompt text
  const personaPrefix = persona ? `${persona}\n\n` : "";
  const finalPrompt = contextText
    ? `${personaPrefix}You are a SEPARATE background sub-agent. Your ONLY job is the task below.\nThe conversation history above is CONTEXT ONLY — do NOT comment on it, do NOT role-play as the main assistant, do NOT describe the spawning process. Execute ONLY the task and return ONLY the result.\n\n## Conversation History (context only — do not respond to this)\n${contextText}\n\n## Your Task (respond ONLY to this)\n${task}`
    : `${personaPrefix}Task: ${task}`;

  // Launch the prompt in a promise chain (NOT awaited — returns immediately).
  // The jobPromise represents the full lifecycle: prompt → extraction → cleanup.
  const jobPromise = (async (): Promise<SubagentResult> => {
    let result: SubagentResult;
    try {
      await session.prompt(finalPrompt);

      // Extract final assistant output
      const messages = session.agent.state.messages;
      let finalOutput = liveStatus.output;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
          const textParts = msg.content
            ?.filter(
              (c: {
                type: string;
                text?: string;
              }): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n");
          if (textParts) {
            finalOutput = textParts;
            break;
          }
        }
      }

      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      };
      for (const msg of messages) {
        if (msg.role === "assistant" && msg.usage) {
          usage.turns++;
          usage.input += msg.usage.input;
          usage.output += msg.usage.output;
          usage.cacheRead += msg.usage.cacheRead;
          usage.cacheWrite += msg.usage.cacheWrite;
          usage.cost += msg.usage.cost.total;
        }
      }

      result = {
        output: finalOutput || "(no output)",
        usage,
        model: session.model
          ? `${session.model.provider}/${session.model.id}`
          : undefined,
        isError: !!session.agent.state.errorMessage,
        errorMessage: session.agent.state.errorMessage,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        output: `Sub-agent crashed: ${msg}`,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 0,
        },
        model: undefined,
        isError: true,
        errorMessage: msg,
      };
    } finally {
      if (activeToolTimer) {
        clearTimeout(activeToolTimer);
        activeToolTimer = undefined;
      }
      if (signal && handleAbort)
        signal.removeEventListener("abort", handleAbort);
      if (unsubscribe) unsubscribe();
      session?.dispose();
    }
    return result;
  })();

  return { jobId, jobPromise, session, liveStatus, modelLabel };
}
