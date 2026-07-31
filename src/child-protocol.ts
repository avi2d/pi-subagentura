import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendCompletionEvent,
  appendEvent,
  artifactPath,
  newEventId,
  writeOutput,
  type SubagentEventV2,
} from "./artifact";
import { appendInteractiveDebugEvent } from "./interactive-debug";

interface ActiveTurn {
  turnId: string;
  startedAt: number;
  started: boolean;
  previousUserEntryId?: string;
}

let latestAgentMessages: unknown[] = [];

function getArtifact() {
  const dir = process.env.ARTIFACT_DIR;
  if (!dir) throw new Error("PI_SUBAGENTURA_CHILD requires ARTIFACT_DIR");
  return artifactPath(dirname(dir), basename(dir));
}

function activeTurnPath(art = getArtifact()): string {
  return join(art.dir, "active-turn.json");
}

function writeActiveTurn(turn: ActiveTurn, art = getArtifact()): void {
  const file = activeTurnPath(art);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(turn), { mode: 0o600 });
  renameSync(tmp, file);
}

export function readActiveTurn(art = getArtifact()): ActiveTurn | null {
  try {
    const value = JSON.parse(
      readFileSync(activeTurnPath(art), "utf8"),
    ) as ActiveTurn;
    return typeof value.turnId === "string" ? value : null;
  } catch {
    return null;
  }
}

function latestUserEntryId(ctx: any): string | undefined {
  const entries =
    ctx.sessionManager?.getEntries?.() ??
    ctx.sessionManager?.getBranch?.() ??
    [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      return String(entry.id);
    }
  }
  return undefined;
}

function outputBytes(art: ReturnType<typeof getArtifact>): number | undefined {
  try {
    return statSync(join(art.dir, "output.md")).size;
  } catch {
    // Missing output is itself useful diagnostic data; keep lifecycle safe.
    return undefined;
  }
}

function appendActivity(
  art: ReturnType<typeof getArtifact>,
  phase: "start" | "end",
  event: { toolName?: string; toolCallId?: string; isError?: boolean },
): void {
  const active = readActiveTurn(art);
  appendInteractiveDebugEvent(art.dir, "tool_activity", {
    phase,
    turnId: active?.turnId,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    isError: event.isError,
  });
  if (!active) return;
  const activity: SubagentEventV2 = {
    version: 2,
    eventId: newEventId(),
    turnId: active.turnId,
    ts: Date.now(),
    type: "tool_activity",
    status: "running",
    phase,
    tool: event.toolName,
    summary:
      phase === "end" && event.isError
        ? `${event.toolName ?? "tool"} failed`
        : event.toolName,
  };
  appendEvent(art, activity);
}

export function registerChildProtocol(pi: ExtensionAPI): void {
  const art = getArtifact();
  const startPersistedTurn = (
    turnId: string,
    timestamp: number,
    previousUserEntryId?: string,
    reason = "persisted_user_entry",
  ): ActiveTurn => {
    const turn: ActiveTurn = {
      turnId,
      startedAt: timestamp,
      started: true,
      previousUserEntryId,
    };
    latestAgentMessages = [];
    writeOutput(art, "");
    writeActiveTurn(turn, art);
    appendEvent(art, {
      version: 2,
      eventId: newEventId(),
      turnId: turn.turnId,
      ts: turn.startedAt,
      type: "turn_started",
      status: "running",
    });
    appendInteractiveDebugEvent(art.dir, "turn_started", {
      turnId,
      previousUserEntryId,
      reason,
    });
    return turn;
  };
  const bindPersistedTurn = (
    ctx: any,
    timestamp: number,
    source: string,
  ): ActiveTurn | null => {
    const active = readActiveTurn(art);
    const persistedId = latestUserEntryId(ctx);
    appendInteractiveDebugEvent(art.dir, "turn_bind", {
      source,
      activeTurnId: active?.turnId,
      activeStarted: active?.started,
      persistedUserEntryId: persistedId,
      previousUserEntryId: active?.previousUserEntryId,
    });
    if (!active) return null;
    if (active.started) {
      if (!persistedId || persistedId === active.turnId) return active;
      // Pi handles Enter during streaming as a steering message inside the
      // existing agent run, so it emits no before_agent_start. The persisted
      // user entry is the authoritative boundary for that new child turn.
      return startPersistedTurn(
        persistedId,
        timestamp,
        active.turnId,
        "user_entry_changed",
      );
    }
    if (!persistedId || persistedId === active.previousUserEntryId) {
      return active;
    }
    return startPersistedTurn(
      persistedId,
      timestamp,
      active.previousUserEntryId,
      "initial_user_entry_bound",
    );
  };
  pi.on("before_agent_start", (_event, ctx) => {
    const previousUserEntryId = latestUserEntryId(ctx);
    const turn: ActiveTurn = {
      turnId: `turn-${newEventId()}`,
      startedAt: Date.now(),
      started: false,
      previousUserEntryId,
    };
    latestAgentMessages = [];
    writeOutput(art, "");
    writeActiveTurn(turn, art);
    appendInteractiveDebugEvent(art.dir, "before_agent_start", {
      provisionalTurnId: turn.turnId,
      previousUserEntryId,
    });
  });

  pi.on("turn_start", (event, ctx) => {
    bindPersistedTurn(ctx, event.timestamp, "turn_start");
    const deferredBind = setTimeout(
      () => bindPersistedTurn(ctx, event.timestamp, "turn_start_deferred"),
      0,
    );
    deferredBind.unref();
  });
  // In createAgentSession 0.80.6, the first turn_start can precede persistence
  // of the user message. This is the earliest guaranteed pre-model fallback.
  pi.on("before_provider_request", (_event, ctx) => {
    bindPersistedTurn(ctx, Date.now(), "before_provider_request");
  });

  pi.on("tool_execution_start", (event, ctx) => {
    bindPersistedTurn(ctx, Date.now(), "tool_execution_start");
    appendActivity(art, "start", event);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    bindPersistedTurn(ctx, Date.now(), "tool_execution_end");
    appendActivity(art, "end", event);
  });
  pi.on("agent_end", (event, ctx) => {
    bindPersistedTurn(ctx, Date.now(), "agent_end");
    latestAgentMessages = [...event.messages];
    appendInteractiveDebugEvent(art.dir, "agent_end", {
      messageCount: latestAgentMessages.length,
      outputBytes: outputBytes(art),
    });
  });
  pi.on("agent_settled", (_event, ctx) => {
    const active = bindPersistedTurn(ctx, Date.now(), "agent_settled");
    if (!active) {
      appendInteractiveDebugEvent(art.dir, "agent_settled_without_active");
      return;
    }
    const assistant = [...latestAgentMessages]
      .reverse()
      .find((message: any) => message?.role === "assistant") as any;
    const errorMessage =
      typeof assistant?.errorMessage === "string"
        ? assistant.errorMessage
        : undefined;
    const failed =
      Boolean(errorMessage) ||
      assistant?.stopReason === "error" ||
      assistant?.stopReason === "aborted";
    appendInteractiveDebugEvent(art.dir, "agent_settled_decision", {
      turnId: active.turnId,
      messageCount: latestAgentMessages.length,
      stopReason: assistant?.stopReason,
      hasErrorMessage: Boolean(errorMessage),
      outputBytes: outputBytes(art),
      outcome: failed ? "error" : "done",
    });
    const completion = appendCompletionEvent(art, {
      turnId: active.turnId,
      outcome: failed ? "error" : "done",
      source: "agent_settled",
      exitCode: failed ? 1 : 0,
      errorMessage,
      message: errorMessage,
    });
    appendInteractiveDebugEvent(art.dir, "completion_emitted", {
      turnId: active.turnId,
      source: "agent_settled",
      emitted: completion !== null,
      eventId: completion?.eventId,
    });
  });
}
