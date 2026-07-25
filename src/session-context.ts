import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

const SESSION_CONTEXT_STACK_KEY = "__piSubagenturaSessionContextStack";
const SESSION_CONTEXT_ID_COUNTER_KEY = "__piSubagenturaSessionContextIdCounter";
export const ACTIVE_SESSION_CONTEXT_ID_KEY =
  "__piSubagenturaActiveSessionContextId";

export interface SessionContextRef {
  id: number;
  generation: number;
  pi: ExtensionAPI;
  ui?: ExtensionUIContext;
  sessionManager?: {
    getEntries?: () => unknown[];
    getSessionId?: () => string;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __piSubagenturaActiveSessionContextId: number | undefined;
  // eslint-disable-next-line no-var
  var __piSubagenturaActiveSessionContextGeneration: number | undefined;
}

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
}

export function getSessionContextStack(): SessionContextRef[] {
  const g = getGlobalState() as any;
  if (!Array.isArray(g[SESSION_CONTEXT_STACK_KEY])) {
    g[SESSION_CONTEXT_STACK_KEY] = [];
  }
  return g[SESSION_CONTEXT_STACK_KEY] as SessionContextRef[];
}

export function nextSessionContextId(): number {
  const g = getGlobalState() as any;
  const next =
    typeof g[SESSION_CONTEXT_ID_COUNTER_KEY] === "number"
      ? g[SESSION_CONTEXT_ID_COUNTER_KEY] + 1
      : 1;
  g[SESSION_CONTEXT_ID_COUNTER_KEY] = next;
  return next;
}

export function createSessionContextRef(pi: ExtensionAPI): SessionContextRef {
  return {
    id: nextSessionContextId(),
    generation: 0,
    pi,
  };
}

export function registerSessionContext(context: SessionContextRef): void {
  const stack = getSessionContextStack();

  // Keep the stack deduplicated when registerSessionHandlers is re-bound after
  // restore/reload cycles in tests and host startup paths.
  const existingIndex = stack.findIndex((entry) => entry.id === context.id);
  if (existingIndex >= 0) {
    stack.splice(existingIndex, 1);
  }
  stack.push(context);
}

export function removeSessionContext(
  contextId: number,
): SessionContextRef | undefined {
  const stack = getSessionContextStack();
  const index = stack.findIndex((entry) => entry.id === contextId);
  if (index < 0) return undefined;
  const [removed] = stack.splice(index, 1);
  return removed;
}

/** Advance a context generation so pending work cannot cross its lifecycle. */
export function advanceSessionContextGeneration(contextId: number): number {
  const context = getSessionContextStack().find(
    (entry) => entry.id === contextId,
  );
  if (!context) return 0;
  context.generation++;
  const g = getGlobalState() as any;
  if (g[ACTIVE_SESSION_CONTEXT_ID_KEY] === context.id) {
    g.__piSubagenturaActiveSessionContextGeneration = context.generation;
  }
  return context.generation;
}

export function setActiveSessionRefs(context?: SessionContextRef): void {
  const g = getGlobalState() as any;
  if (!context) {
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    g.__piSubagenturaSessionManager = undefined;
    g[ACTIVE_SESSION_CONTEXT_ID_KEY] = undefined;
    g.__piSubagenturaActiveSessionContextGeneration = undefined;
    return;
  }

  g.__piSubagenturaPiRef = context.pi;
  g.__piSubagenturaUi = context.ui;
  g.__piSubagenturaSessionManager = context.sessionManager;
  g[ACTIVE_SESSION_CONTEXT_ID_KEY] = context.id;
  g.__piSubagenturaActiveSessionContextGeneration = context.generation;
}

export interface ActiveSessionContextToken {
  id: number;
  generation: number;
}

export function getActiveSessionContextId(): number | undefined {
  const g = getGlobalState() as any;
  return g[ACTIVE_SESSION_CONTEXT_ID_KEY];
}

export function getActiveSessionContextToken():
  ActiveSessionContextToken | undefined {
  const g = getGlobalState() as any;
  const id = g[ACTIVE_SESSION_CONTEXT_ID_KEY];
  const generation = g.__piSubagenturaActiveSessionContextGeneration;
  if (typeof id !== "number" || typeof generation !== "number")
    return undefined;
  return { id, generation };
}

/** Resolve a captured context only while its original lifecycle is still live. */
export function resolveLiveSessionContext(
  token: ActiveSessionContextToken | undefined,
): SessionContextRef | undefined {
  if (!token) return undefined;
  const context = getSessionContextStack().find(
    (entry) => entry.id === token.id,
  );
  return context?.generation === token.generation ? context : undefined;
}

/** Whether a captured context still belongs to the same live lifecycle. */
export function isSessionContextTokenLive(
  token: ActiveSessionContextToken | undefined,
): boolean {
  return !token || resolveLiveSessionContext(token) !== undefined;
}

export function sessionIdForContextToken(
  token: ActiveSessionContextToken | undefined,
): string | undefined {
  if (!token) return undefined;
  try {
    return resolveLiveSessionContext(token)?.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

export function parentSessionBelongsToOwner(
  parentSessionId: string | undefined,
  owner: ActiveSessionContextToken | undefined,
): boolean {
  if (!owner) return true;
  const ownerSessionId = sessionIdForContextToken(owner);
  return ownerSessionId !== undefined && parentSessionId === ownerSessionId;
}
