export type ParsedWorkflowMeta = {
  name: string;
  description: string;
  [k: string]: unknown;
};

export {
  parseWorkflow,
  makeGuardedDate,
  makeGuardedMath,
  workflowStringify,
} from "./workflow-script.mjs";
