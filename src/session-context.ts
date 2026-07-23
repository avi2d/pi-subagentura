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

export function setActiveSessionRefs(context?: SessionContextRef): void {
  const g = getGlobalState() as any;
  if (!context) {
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    g.__piSubagenturaSessionManager = undefined;
    g[ACTIVE_SESSION_CONTEXT_ID_KEY] = undefined;
    return;
  }

  g.__piSubagenturaPiRef = context.pi;
  g.__piSubagenturaUi = context.ui;
  g.__piSubagenturaSessionManager = context.sessionManager;
  g[ACTIVE_SESSION_CONTEXT_ID_KEY] = context.id;
}

export function getActiveSessionContextId(): number | undefined {
  const g = getGlobalState() as any;
  return g[ACTIVE_SESSION_CONTEXT_ID_KEY];
}
