import { describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { SCHEMA_RETRIES, validateSchema } from "../src/workflow-core";
import { runWorkflow, type WorkflowProgress } from "../src/workflow";

type Schema = Record<string, unknown>;

function ok(output: string): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    model: "test/model",
  };
}

describe("validateSchema additionalProperties", () => {
  it("rejects undeclared own enumerable string keys with qualified paths", () => {
    const schema: Schema = {
      type: "object",
      properties: { user: { type: "string" } },
      additionalProperties: false,
    };

    expect(validateSchema({ user: "Ada", role: "admin" }, schema)).toEqual([
      "$.role: additional property not allowed",
    ]);
  });

  it("allows extra keys when additionalProperties is absent or true", () => {
    const value = { known: 1, extra: 2 };

    expect(
      validateSchema(value, {
        type: "object",
        properties: { known: { type: "number" } },
      }),
    ).toEqual([]);
    expect(
      validateSchema(value, {
        type: "object",
        properties: { known: { type: "number" } },
        additionalProperties: true,
      }),
    ).toEqual([]);
  });

  it("treats a schema without properties as having an empty allowed set", () => {
    expect(
      validateSchema(
        { anything: true },
        { type: "object", additionalProperties: false },
      ),
    ).toEqual(["$.anything: additional property not allowed"]);
  });

  it("checks required own properties independently of properties", () => {
    const schema = { type: "object", required: ["id"] };

    expect(validateSchema({}, schema)).toEqual([
      "$.id: required property missing",
    ]);
    expect(validateSchema({ id: 7 }, schema)).toEqual([]);
  });

  it("ignores inherited keys for required and instance data", () => {
    const prototype = { inherited: "value" };
    const value = Object.create(prototype) as Record<string, unknown>;

    expect(
      validateSchema(value, {
        type: "object",
        required: ["inherited"],
        properties: { inherited: { type: "string" } },
        additionalProperties: false,
      }),
    ).toEqual(["$.inherited: required property missing"]);
  });

  it("recurses through nested objects and object array items", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          additionalProperties: false,
        },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "number" } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    };

    expect(
      validateSchema(
        { nested: { ok: true, extra: 1 }, items: [{ id: 1, extra: 2 }] },
        schema,
      ),
    ).toEqual([
      "$.nested.extra: additional property not allowed",
      "$.items[0].extra: additional property not allowed",
    ]);
  });

  it("keeps schema-valued additionalProperties permissive", () => {
    expect(
      validateSchema(
        { known: "ok", extra: 42 },
        {
          type: "object",
          properties: { known: { type: "string" } },
          additionalProperties: { type: "string" },
        },
      ),
    ).toEqual([]);
  });
});

describe("validateSchema array cardinality", () => {
  it("enforces minItems and maxItems without an items schema", () => {
    expect(validateSchema([], { type: "array", minItems: 1 })).toEqual([
      "$: expected >= 1 items, got 0",
    ]);
    expect(validateSchema([1, 2], { type: "array", maxItems: 1 })).toEqual([
      "$: expected <= 1 items, got 2",
    ]);
  });
});

describe("workflow schema retries", () => {
  it("retries after an additional property violation", async () => {
    let calls = 0;
    const script = `
      export const meta = { name: "schema", description: "test" };
      return await agent("return the value", {
        isolation: "in-process",
        schema: ${JSON.stringify({
          type: "object",
          properties: { value: { type: "number" } },
          additionalProperties: false,
        })},
      });
    `;
    const result = await runWorkflow(script, {
      runAgent: async () => {
        calls++;
        return calls === 1
          ? ok('{"value": 1, "extra": true}')
          : ok('{"value": 2}');
      },
    });

    expect(result.result).toEqual({ value: 2 });
    expect(calls).toBe(2);
  });
});

describe("workflow schema usage accounting", () => {
  it("sums usage from every schema attempt", async () => {
    let calls = 0;
    const script = `
      export const meta = { name: "schema-usage", description: "test" };
      return await agent("return the value", {
        isolation: "in-process",
        schema: { type: "object", properties: { value: { type: "number" } } },
      });
    `;
    const result = await runWorkflow(script, {
      runAgent: async () => {
        calls++;
        return {
          ...ok(calls === 1 ? '{"value": "wrong"}' : '{"value": 2}'),
          usage: {
            input: 10,
            output: 4,
            cacheRead: 2,
            cacheWrite: 1,
            cost: 0.05,
            turns: 1,
          },
        };
      },
    });

    expect(result.result).toEqual({ value: 2 });
    expect(calls).toBe(2);
    expect(result.tokensSpent).toBe(8);
    expect(result.usage).toEqual({
      input: 20,
      output: 8,
      cacheRead: 4,
      cacheWrite: 2,
      totalTokens: 34,
      costUsd: 0.1,
      turns: 2,
    });
  });
});

it("aggregates all failed schema attempts in result and progress", async () => {
  let calls = 0;
  const progress: WorkflowProgress[] = [];
  const script = `
      export const meta = { name: "schema-all-fail", description: "test" };
      return await agent("return the value", {
        isolation: "in-process",
        schema: { type: "object", properties: { value: { type: "number" } } },
      });
    `;
  const result = await runWorkflow(script, {
    runAgent: async () => {
      calls++;
      return {
        ...ok('{"value": "wrong"}'),
        usage: {
          input: 3,
          output: 2,
          cacheRead: 1,
          cacheWrite: 4,
          cost: 0.1,
          turns: 1,
        },
      };
    },
    onProgress: (event) => progress.push(event),
  });

  expect(calls).toBe(SCHEMA_RETRIES);
  expect(result.result).toBeNull();
  expect(result.errorCount).toBe(1);
  expect(result.usage).toEqual({
    input: 9,
    output: 6,
    cacheRead: 3,
    cacheWrite: 12,
    totalTokens: 30,
    costUsd: 0.1 * 3,
    turns: 3,
  });
  expect(progress.at(-1)?.usage).toEqual(result.usage);
});
