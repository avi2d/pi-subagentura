import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeDurableValue,
  encodeDurableValue,
} from "../src/workflow-durable-value";
import {
  createWorkflowPlanState,
  reduceWorkflowPlanState,
} from "../src/workflow-plan-state";
import { validateWorkflowPlan, type WorkflowPlan } from "../src/workflow-plan";

const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "review",
  phases: [
    {
      id: "phase-a",
      mode: "sequential",
      tasks: [{ id: "task-a", prompt: "inspect" }],
    },
    {
      id: "phase-b",
      mode: "sequential",
      tasks: [{ id: "task-b", prompt: "report" }],
    },
  ],
};

function directImports(relativePath: string): string[] {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

describe("workflow contract foundation", () => {
  it("validates globally unique sequential task ids", () => {
    expect(() => validateWorkflowPlan(plan)).not.toThrow();
    expect(() =>
      validateWorkflowPlan({
        ...plan,
        phases: [
          plan.phases[0],
          {
            ...plan.phases[1],
            tasks: [{ id: "task-a", prompt: "bad" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects malformed plan structures and unknown fields synchronously", () => {
    const invalidPlans: unknown[] = [
      null,
      {},
      { ...plan, extra: true },
      { ...plan, phases: [] },
      {
        ...plan,
        phases: [{ id: "empty", mode: "sequential", tasks: [] }],
      },
      {
        ...plan,
        phases: [{ id: "missing", mode: "sequential" }],
      },
      {
        ...plan,
        phases: [
          {
            id: "wrong-task",
            mode: "sequential",
            tasks: [null],
          },
        ],
      },
      {
        ...plan,
        phases: [
          {
            id: "wrong-label",
            mode: "sequential",
            tasks: [{ id: "task", prompt: "work", label: 7 }],
          },
        ],
      },
      {
        ...plan,
        phases: [
          {
            id: "unknown-task-field",
            mode: "sequential",
            tasks: [{ id: "task", prompt: "work", model: "unknown" }],
          },
        ],
      },
    ];

    for (const invalid of invalidPlans) {
      expect(() => validateWorkflowPlan(invalid)).toThrow();
    }
  });

  it("allows only absent or in-process task isolation", () => {
    expect(() =>
      validateWorkflowPlan({
        ...plan,
        phases: [
          {
            id: "valid",
            mode: "sequential",
            tasks: [
              {
                id: "task",
                prompt: "work",
                isolation: "in-process",
              },
            ],
          },
        ],
      }),
    ).not.toThrow();

    for (const isolation of ["process", "container", null, 1]) {
      expect(() =>
        validateWorkflowPlan({
          ...plan,
          phases: [
            {
              id: "invalid",
              mode: "sequential",
              tasks: [{ id: "task", prompt: "work", isolation }],
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("validates plan accessors and inputs without invoking caller code", () => {
    let getterCalls = 0;
    const task = { id: "task", prompt: "work" } as Record<string, unknown>;
    Object.defineProperty(task, "label", {
      enumerable: true,
      get() {
        getterCalls++;
        return "unsafe";
      },
    });

    expect(() =>
      validateWorkflowPlan({
        ...plan,
        phases: [{ id: "phase", mode: "sequential", tasks: [task] }],
      }),
    ).toThrow(/accessor/i);
    expect(getterCalls).toBe(0);

    class RuntimeValue {
      value = 1;
    }
    expect(() =>
      validateWorkflowPlan({
        ...plan,
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [{ id: "task", prompt: "work", input: new RuntimeValue() }],
          },
        ],
      }),
    ).toThrow(/plain object/i);
  });

  it("keeps terminal task state immutable", () => {
    let state = createWorkflowPlanState(plan);
    state = reduceWorkflowPlanState(state, {
      type: "start",
      taskId: "task-a",
      phaseId: "phase-a",
    });
    state = reduceWorkflowPlanState(state, {
      type: "succeed",
      taskId: "task-a",
    });
    expect(() =>
      reduceWorkflowPlanState(state, {
        type: "start",
        taskId: "task-a",
        phaseId: "phase-a",
      }),
    ).toThrow();
  });

  it("cancels undispatched tasks and keeps failure terminal", () => {
    let state = createWorkflowPlanState(plan);
    state = reduceWorkflowPlanState(state, {
      type: "start",
      taskId: "task-a",
      phaseId: "phase-a",
    });
    state = reduceWorkflowPlanState(state, {
      type: "fail",
      taskId: "task-a",
    });

    expect(state.tasks).toEqual({
      "task-a": "failed",
      "task-b": "cancelled",
    });
    expect(() =>
      reduceWorkflowPlanState(state, {
        type: "start",
        taskId: "task-b",
        phaseId: "phase-b",
      }),
    ).toThrow();
  });

  it("cancels every active or pending task", () => {
    let state = createWorkflowPlanState(plan);
    state = reduceWorkflowPlanState(state, {
      type: "start",
      taskId: "task-a",
      phaseId: "phase-a",
    });
    state = reduceWorkflowPlanState(state, { type: "cancel" });

    expect(state.status).toBe("cancelled");
    expect(state.tasks).toEqual({
      "task-a": "cancelled",
      "task-b": "cancelled",
    });
    expect(Object.values(state.tasks)).not.toContain("running");
    expect(Object.values(state.tasks)).not.toContain("pending");
  });
  it("round-trips bounded durable values and rejects unsafe numbers", () => {
    expect(
      decodeDurableValue(
        encodeDurableValue({ answer: 42, nested: [true, null] }),
      ),
    ).toEqual({ answer: 42, nested: [true, null] });
    expect(encodeDurableValue({ z: 1, a: 2 })).toBe(
      encodeDurableValue({ a: 2, z: 1 }),
    );
    expect(() => encodeDurableValue({ answer: 1.5 })).toThrow();
    expect(() =>
      encodeDurableValue({ answer: Number.POSITIVE_INFINITY }),
    ).toThrow();
    expect(() =>
      encodeDurableValue({ answer: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
  });

  it("rejects accessors, classes, cycles, and unsafe durable keys", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        getterCalls++;
        return 1;
      },
    });
    expect(() => encodeDurableValue(accessor)).toThrow(/accessor/i);
    expect(getterCalls).toBe(0);

    class RuntimeValue {
      value = 1;
    }
    expect(() => encodeDurableValue(new RuntimeValue())).toThrow(
      /plain object/i,
    );

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => encodeDurableValue(cyclic)).toThrow(/cyclic/i);
    expect(() => encodeDurableValue(JSON.parse('{"__proto__":1}'))).toThrow(
      /key/i,
    );
    expect(() => encodeDurableValue({ "unsafe key": 1 })).toThrow(/key/i);
  });

  it("enforces durable depth, node, string, and aggregate byte bounds", () => {
    let deeplyNested: unknown = null;
    for (let depth = 0; depth < 65; depth++) deeplyNested = [deeplyNested];
    expect(() => encodeDurableValue(deeplyNested)).toThrow(/depth/i);

    expect(() => encodeDurableValue(new Array(100_000).fill(null))).toThrow(
      /nodes/i,
    );
    expect(() => encodeDurableValue("x".repeat(256 * 1024 + 1))).toThrow(
      /string/i,
    );
    expect(() =>
      encodeDurableValue(["x".repeat(128 * 1024), "y".repeat(128 * 1024)]),
    ).toThrow(/bytes/i);
    expect(() => decodeDurableValue(" ".repeat(256 * 1024 + 1))).toThrow(
      /bytes/i,
    );
  });

  it("keeps plan state and plan runner dependencies pointed inward", () => {
    const stateImports = directImports("../src/workflow-plan-state.ts");
    const runnerImports = directImports("../src/workflow-plan-runner.ts");
    const stateAllowlist = ["./workflow-plan", "./workflow-run-types"];
    const runnerAllowlist = [
      "./workflow-core",
      "./workflow-plan-state",
      "./workflow-plan",
    ];

    expect(
      stateImports.filter((specifier) => !stateAllowlist.includes(specifier)),
    ).toEqual([]);
    expect(
      runnerImports.filter((specifier) => !runnerAllowlist.includes(specifier)),
    ).toEqual([]);
  });
});
