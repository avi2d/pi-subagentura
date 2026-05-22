/**
 * Agent Registry for pi-subagentura RPC mode
 *
 * Provides named agent registration and discovery.
 * Agents register with a session factory, allowing them to be invoked by name.
 *
 * NOTE: capabilities is discovery metadata only - no access control enforcement.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

export interface AgentRegistration {
  name: string;
  description?: string;
  /** Discovery metadata only - not enforced */
  capabilities?: string[];
  _sessionFactory: () => Promise<AgentSession>;
}

// ── Registry (global to survive module reloads) ────────────────────────

const g = typeof global !== "undefined" ? global : globalThis;

if (!g.__piSubagenturaAgentRegistry) {
  g.__piSubagenturaAgentRegistry = new Map<string, AgentRegistration>();
}

const registry = g.__piSubagenturaAgentRegistry as Map<string, AgentRegistration>;

/**
 * Register a named agent.
 *
 * Uses Map.set atomic semantics - race condition window exists between
 * check and set but is acceptable for single-user CLI tool.
 */
export function registerAgent(
  reg: AgentRegistration,
): { success: boolean; error?: string } {
  if (registry.has(reg.name)) {
    return {
      success: false,
      error: `Agent '${reg.name}' already registered`,
    };
  }
  registry.set(reg.name, reg);
  return { success: true };
}

/** Get a registered agent by name */
export function getAgent(name: string): AgentRegistration | undefined {
  return registry.get(name);
}

/** List all registered agents */
export function listAgents(): AgentRegistration[] {
  return Array.from(registry.values());
}

/** Unregister an agent by name. Returns true if it existed. */
export function unregisterAgent(name: string): boolean {
  return registry.delete(name);
}

/** Check if an agent is registered */
export function hasAgent(name: string): boolean {
  return registry.has(name);
}

/** Clear all registered agents (useful for testing) */
export function clearRegistry(): void {
  registry.clear();
}