import { MAX_TOTAL_AGENTS } from "./workflow-core";
import { toDurableValue, type DurableValue } from "./workflow-durable-value";

export const WORKFLOW_PLAN_VERSION = 1 as const;
export type WorkflowPhaseMode = "sequential";
export type WorkflowTaskStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface WorkflowPlanTask {
  id: string;
  prompt: string;
  label?: string;
  isolation?: "in-process";
  input?: DurableValue;
}

export interface WorkflowPlanPhase {
  id: string;
  mode: WorkflowPhaseMode;
  tasks: WorkflowPlanTask[];
}

export interface WorkflowPlan {
  schemaVersion: typeof WORKFLOW_PLAN_VERSION;
  name: string;
  phases: WorkflowPlanPhase[];
}

const ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MAX_PHASES = 64;
const MAX_TASKS = MAX_TOTAL_AGENTS;
const PLAN_FIELDS: Record<string, true> = {
  schemaVersion: true,
  name: true,
  phases: true,
};
const PHASE_FIELDS: Record<string, true> = {
  id: true,
  mode: true,
  tasks: true,
};
const TASK_FIELDS: Record<string, true> = {
  id: true,
  prompt: true,
  label: true,
  isolation: true,
  input: true,
};

type DurableRecord = { [key: string]: DurableValue };

/** Validate an exact, bounded plan before any job or child can be created. */
export function validateWorkflowPlan(
  plan: unknown,
): asserts plan is WorkflowPlan {
  // This also proves every property is an enumerable data property without
  // invoking accessors, and bounds all strings, input values, nodes, and bytes.
  const root = expectRecord(toDurableValue(plan), "plan");
  assertExactFields(
    root,
    PLAN_FIELDS,
    ["schemaVersion", "name", "phases"],
    "plan",
  );

  if (root.schemaVersion !== WORKFLOW_PLAN_VERSION) {
    throw new Error(`plan.schemaVersion must be ${WORKFLOW_PLAN_VERSION}`);
  }
  if (typeof root.name !== "string" || !ID.test(root.name)) {
    throw new Error("plan.name must be a valid workflow identifier");
  }
  if (!Array.isArray(root.phases)) {
    throw new Error("plan.phases must be an array");
  }
  if (root.phases.length === 0 || root.phases.length > MAX_PHASES) {
    throw new Error("Workflow plan must contain 1-64 phases");
  }

  const ids = new Set<string>();
  let taskCount = 0;
  for (let phaseIndex = 0; phaseIndex < root.phases.length; phaseIndex++) {
    const phasePath = `plan.phases[${phaseIndex}]`;
    const phase = expectRecord(root.phases[phaseIndex], phasePath);
    assertExactFields(phase, PHASE_FIELDS, ["id", "mode", "tasks"], phasePath);
    if (typeof phase.id !== "string" || !ID.test(phase.id)) {
      throw new Error(`${phasePath}.id must be a valid workflow identifier`);
    }
    if (ids.has(phase.id)) {
      throw new Error(`Duplicate workflow id: ${phase.id}`);
    }
    if (phase.mode !== "sequential") {
      throw new Error(`${phasePath}.mode must be "sequential"`);
    }
    if (!Array.isArray(phase.tasks)) {
      throw new Error(`${phasePath}.tasks must be an array`);
    }
    if (phase.tasks.length === 0) {
      throw new Error(`${phasePath}.tasks must contain at least one task`);
    }
    taskCount += phase.tasks.length;
    if (taskCount > MAX_TASKS) {
      throw new Error(`Workflow plan exceeds ${MAX_TASKS} tasks`);
    }
    ids.add(phase.id);

    for (let taskIndex = 0; taskIndex < phase.tasks.length; taskIndex++) {
      const taskPath = `${phasePath}.tasks[${taskIndex}]`;
      const task = expectRecord(phase.tasks[taskIndex], taskPath);
      assertExactFields(task, TASK_FIELDS, ["id", "prompt"], taskPath);
      if (typeof task.id !== "string" || !ID.test(task.id)) {
        throw new Error(`${taskPath}.id must be a valid workflow identifier`);
      }
      if (ids.has(task.id)) {
        throw new Error(`Duplicate workflow id: ${task.id}`);
      }
      if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) {
        throw new Error(`${taskPath}.prompt must be a nonempty string`);
      }
      if (Object.hasOwn(task, "label") && typeof task.label !== "string") {
        throw new Error(`${taskPath}.label must be a string`);
      }
      if (Object.hasOwn(task, "isolation") && task.isolation !== "in-process") {
        throw new Error(
          `${taskPath}.isolation must be omitted or "in-process"`,
        );
      }
      ids.add(task.id);
    }
  }
}

function expectRecord(value: DurableValue, path: string): DurableRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function assertExactFields(
  value: DurableRecord,
  allowed: Record<string, true>,
  required: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(allowed, key)) {
      throw new Error(`${path} contains unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${path}.${key} is required`);
    }
  }
}
