/**
 * Shared helpers for pi-subagentura
 *
 * Exported so both subagent.ts and test files can import them.
 * Keeps helper logic in one place — single source of truth.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
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

// ── Debug Logging ─────────────────────────────────────────────────

const DEBUG_LOG_DIR = process.env.SUBAGENT_DEBUG_LOG_DIR
  ? resolve(process.env.SUBAGENT_DEBUG_LOG_DIR)
  : undefined;

export function debugLog(level: string, event: string, data: Record<string, unknown> = {}) {
  if (!DEBUG_LOG_DIR) return;
  try {
    if (!existsSync(DEBUG_LOG_DIR)) {
      mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    }
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...data,
    }) + "\n";
    const fileName = resolve(DEBUG_LOG_DIR, `debug-${new Date().toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(fileName, entry);
  } catch {
    // Silently fail to avoid polluting output
  }
}

export function extractTextFromContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && c.type === "text" && typeof c.text === "string"
      )
      .map((c) => c.text)
      .join("\n");
  }
  if (typeof content === "string") {
    return content;
  }
  debugLog("warn", "unexpected_content_type", {
    contentType: typeof content,
    content: String(String(content).slice(0, 200)),
  });
  return "";
}

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
  /** Session directory path for session persistence */
  sessionDir?: string;
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

  // Only exact matching — no fuzzy/substring guessing.
  // The AI should call list_available_models and pick from the list.
  if (parentModelRegistry) {
    if (modelId.includes("/")) {
      const [provider, id] = modelId.split("/", 2);
      const exact = parentModelRegistry.find(provider, id);
      if (exact) return exact as any;
    } else {
      // Bare id — search all models in parent registry
      for (const m of parentModelRegistry.getAll()) {
        if (m.id === modelId) return m as any;
      }
    }
  }

  // Fall back to global static registry (built-in models only)
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
  /** Directory for session storage. If provided, pi will save the session here. */
  sessionDir?: string;
}

export interface StartSubagentJobResult {
  jobId: string;
  jobPromise: Promise<SubagentResult>;
  session: AgentSession;
  liveStatus: SubagentLiveStatus;
  modelLabel?: string;
  /** Warning when modelOverride was specified but not found — lists available models */
  modelWarning?: string;
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
    sessionDir,
  } = params;

  // Enforce registry size cap before adding a new job
  while (jobRegistry.size >= MAX_REGISTRY_SIZE) {
    if (!pruneOldestJob()) break; // no old jobs to evict, allow slight overcap
  }

  const jobId = generateJobId();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // Resolve model early (needed for sessionDir case too)
  const targetModel = resolveModel(modelOverride, defaultModel, parentModelRegistry);
  const modelLabel = targetModel
    ? `${targetModel.provider}/${targetModel.id}`
    : undefined;

  // Build model warning when override was specified (helps AI discover valid models)
  let modelWarning: string | undefined;
  if (modelOverride && parentModelRegistry) {
    const available = parentModelRegistry.getAvailable();
    const modelList = available
      .map((m) => `  ${m.provider}/${m.id}${m.name ? ` (${m.name})` : ""}`)
      .join("\n");
    modelWarning =
      `Requested model "${modelOverride}" resolved to ${modelLabel ?? "none"}. ` +
      `Available models:\n${modelList || "  (none)"}\n` +
      `Use list_available_models to discover more.`;
  }

  // ── Session Directory Path: spawn pi subprocess ─────────────────────
  if (sessionDir) {
    // Ensure session directory exists
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    // Build the prompt
    const personaPrefix = persona ? `${persona}\n\n` : "";
    const finalPrompt = contextText
      ? `${personaPrefix}You are a SEPARATE background sub-agent. Your ONLY job is the task below.\nThe conversation history above is CONTEXT ONLY — do NOT comment on it, do NOT role-play as the main assistant, do NOT describe the spawning process. Execute ONLY the task and return ONLY the result.\n\n## Conversation History (context only — do not respond to this)\n${contextText}\n\n## Your Task (respond ONLY to this)\n${task}`
      : `${personaPrefix}Task: ${task}`;

    // Build the pi command
    const piCmd = ["pi", `--session-dir`, sessionDir, "--continue", finalPrompt];

    debugLog("info", "session_spawning", {
      jobId,
      sessionDir,
      command: piCmd.join(" "),
    });

    // Spawn pi subprocess
    let proc: ReturnType<typeof spawn>;
    let procClosed = false;
    let stdoutData = "";
    let stderrData = "";

    const procPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      proc = spawn(piCmd[0], piCmd.slice(1), {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (data: Buffer) => {
        stdoutData += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderrData += data.toString();
      });

      proc.on("close", (code, sig) => {
        procClosed = true;
        resolve({ code, signal: sig });
      });

      proc.on("error", (err) => {
        debugLog("error", "session_spawn_error", { jobId, error: err.message });
        if (!procClosed) {
          procClosed = true;
          resolve({ code: 1, signal: null });
        }
      });
    });

    // Abort handler for sessionDir case
    let handleAbort: (() => void) | undefined;
    if (signal) {
      handleAbort = () => {
        debugLog("warn", "job_abort", { jobId });
        if (proc && !procClosed) {
          proc.kill("SIGTERM");
        }
      };
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort);
      }
    }

    // Build jobPromise for sessionDir case
    const jobPromise = (async (): Promise<SubagentResult> => {
      let result: SubagentResult;
      try {
        const { code, signal: sig } = await procPromise;
        debugLog("info", "session_complete", { jobId, code, signal: sig });

        if (code === 0 || sig === null) {
          result = {
            output: stdoutData || "(no output)",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            model: modelLabel,
            isError: false,
          };
        } else {
          result = {
            output: `Sub-agent exited with code ${code}: ${stderrData || stdoutData}`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            model: modelLabel,
            isError: true,
            errorMessage: `Exited with code ${code}`,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          output: `Sub-agent crashed: ${msg}`,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          model: modelLabel,
          isError: true,
          errorMessage: msg,
        };
      } finally {
        if (signal && handleAbort) {
          signal.removeEventListener("abort", handleAbort);
        }
        debugLog("info", "session_dir_job_complete", { jobId });
      }
      return result;
    })();

    // Return early with sessionDir case
    // @ts-expect-error — session is AgentSession | null for sessionDir case
    return { jobId, jobPromise, session: null, liveStatus, modelLabel, modelWarning };
  }

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
  debugLog("info", "session_creating", {
    jobId,
    model: modelLabel ?? "default",
    cwd,
  });
  const session = (
    await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      model: targetModel,
      cwd,
    })
  ).session;
  debugLog("info", "session_created", {
    jobId,
    sessionModel: session.model ? `${session.model.provider}/${session.model.id}` : null,
  });

  // Wire abort signal
  if (signal) {
    handleAbort = () => {
      debugLog("warn", "job_abort", { jobId });
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
        debugLog("info", "turn_start", { jobId, turn: liveStatus.turn });
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
        break;
      }
      case "tool_execution_start": {
        debugLog("info", "tool_start", {
          jobId,
          toolName: event.toolName,
          args: event.args as Record<string, unknown>,
        });
        setActiveToolDebounced({
          name: event.toolName,
          args: event.args as Record<string, unknown>,
        });
        break;
      }
      case "tool_execution_end": {
        debugLog("info", "tool_end", { jobId, toolName: liveStatus.activeTool?.name });
        setActiveToolDebounced(undefined);
        break;
      }
      case "turn_end": {
        debugLog("info", "turn_end", {
          jobId,
          turn: liveStatus.turn,
          outputLength: liveStatus.output.length,
          activeTool: liveStatus.activeTool?.name ?? null,
        });
        if (activeToolTimer) {
          clearTimeout(activeToolTimer);
          activeToolTimer = undefined;
        }
        liveStatus.activeTool = undefined;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
        break;
      }
      case "message_update": {
        const evt = event.assistantMessageEvent;
        debugLog("info", "message_update", {
          jobId,
          updateType: evt.type,
          ...(evt.type === "text_delta" && {
            delta: evt.delta.slice(0, 200),
            outputLength: liveStatus.output.length,
          }),
          ...(evt.type === "thinking_delta" && { delta: evt.delta.slice(0, 200) }),
          ...(evt.type === "toolcall_delta" && { partial: String(evt.partial).slice(0, 200) }),
          ...(evt.type === "toolcall_end" && { toolCallId: evt.toolCall?.id }),
        });
        if (evt.type === "text_delta") {
          liveStatus.output += evt.delta;
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

  debugLog("info", "prompt_built", {
    jobId,
    hasContext: !!contextText,
    contextLength: contextText?.length ?? 0,
    taskLength: task.length,
    persona: persona ?? null,
    promptPreview: finalPrompt.slice(0, 500),
  });

  // Launch the prompt in a promise chain (NOT awaited — returns immediately).
  // The jobPromise represents the full lifecycle: prompt → extraction → cleanup.
  const jobPromise = (async (): Promise<SubagentResult> => {
    let result: SubagentResult;
    try {
      debugLog("info", "prompt_start", { jobId });
      await session.prompt(finalPrompt);
      debugLog("info", "prompt_complete", { jobId });

      // Extract final assistant output
      const messages = session.agent.state.messages;
      debugLog("info", "messages_extracted", {
        jobId,
        messageCount: messages.length,
        messageRoles: messages.map((m) => m.role),
        lastMessageContentType: typeof (messages[messages.length - 1] as any)?.content,
        lastMessageContentIsArray: Array.isArray((messages[messages.length - 1] as any)?.content),
      });

      let finalOutput = liveStatus.output;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        debugLog("info", "message_check", {
          jobId,
          index: i,
          role: msg.role,
          contentType: typeof (msg as any).content,
          contentIsArray: Array.isArray((msg as any).content),
        });
        if (msg.role === "assistant") {
          const textParts = extractTextFromContent(msg.content);
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
      const stack = err instanceof Error ? err.stack : undefined;
      debugLog("error", "subagent_error", {
        jobId,
        error: msg,
        stack: stack ?? null,
        errorName: err instanceof Error ? err.name : typeof err,
      });
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
      debugLog("info", "job_complete", {
        jobId,
        outputLength: result.output.length,
        output: result.output.slice(0, 200),
        isError: result.isError,
        errorMessage: result.errorMessage ?? null,
        usage: result.usage,
      });
      if (activeToolTimer) {
        clearTimeout(activeToolTimer);
        activeToolTimer = undefined;
      }
      if (signal && handleAbort)
        signal.removeEventListener("abort", handleAbort);
      if (unsubscribe) unsubscribe();
      session?.dispose();
      debugLog("info", "session_disposed", { jobId });
    }
    return result;
  })();

  return { jobId, jobPromise, session, liveStatus, modelLabel, modelWarning };
}
