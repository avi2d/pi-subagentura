export interface TerminalScenario {
  name: string;
  marker: string;
  gate: string | null;
  prompt: string;
  child?: string;
  expected: string;
}
export const scenarios: Record<string, TerminalScenario>;
export function getScenario(name?: string): TerminalScenario;
export function scenarioNames(): string[];
