export interface ParsedWorkflowMeta {
  name: string;
  description: string;
  [k: string]: unknown;
}

export function parseWorkflow(script: string): {
  meta: ParsedWorkflowMeta;
  body: string;
};

export function makeGuardedDate(): typeof Date;
export function makeGuardedMath(): Math;
export function workflowStringify(x: unknown): string;
