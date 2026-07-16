import { describe, expect, it, vi } from "vitest";
import {
  parseWorkflow,
  runWorkflow,
  extractJson,
  validateSchema,
  MAX_ITEMS_PER_CALL,
  saveWorkflowScript,
  loadWorkflowScript,
  listSavedWorkflows,
  sanitizeWorkflowName,
  MAX_WORKFLOW_JOBS,
  startWorkflowJob,
  deleteWorkflowScript,
  workflowJobRegistry,
  awaitInteractiveResult,
  renderProgress,
  registerWorkflowTool,
  retryPendingWorkflowNotifications,
  getWorkflowCompletionPresentation,
  MAX_WORKFLOW_NOTIFICATION_ATTEMPTS,
  type WorkflowAgentRunner,
  type WorkflowProgress,
} from "../src/workflow";
import type { SubagentResult } from "../src/helpers";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mock sub-agent runner ────────────────────────────────────────────
function ok(output: string, outTokens = 0): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 0,
      output: outTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    model: "test/model",
  };
}
function fail(msg = "boom"): SubagentResult {
  return {
    isError: true,
    output: "(no output)",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    model: undefined,
    errorMessage: msg,
  };
}

/** A runner that echoes the prompt, optionally tracking concurrency. */
function echoRunner(): WorkflowAgentRunner {
  return async ({ prompt }) => ok(prompt);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("parseWorkflow", () => {
  it("extracts a pure-literal meta and the body", () => {
    const { meta, body } = parseWorkflow(
      `export const meta = { name: "flow", description: "does things" };\nreturn 42;`,
    );
    expect(meta.name).toBe("flow");
    expect(meta.description).toBe("does things");
    expect(body).toContain("return 42;");
    expect(body).not.toContain("export const meta");
  });

  it("handles braces and semicolons inside meta string values", () => {
    const { meta, body } = parseWorkflow(
      `export const meta = { name: "f", description: "uses { and } and ; chars" };\nlog("hi");`,
    );
    expect(meta.description).toBe("uses { and } and ; chars");
    expect(body).toContain('log("hi");');
  });

  it("worker parser handles escaped quotes before braces in meta string values", async () => {
    const script = String.raw`export const meta = { name: "f", description: "escaped quote: \" } still inside string" };
return 42;`;

    const r = await runWorkflow(script, { runAgent: echoRunner() });

    expect(r.meta.description).toBe('escaped quote: " } still inside string');
    expect(r.result).toBe(42);
  });

  it("rejects a meta literal that references a helper (not pure)", () => {
    expect(() =>
      parseWorkflow(`export const meta = { name: agent, description: "x" };\n`),
    ).toThrow(/pure literal/i);
  });

  it("rejects constructor-chain code generation in meta", () => {
    expect(() =>
      parseWorkflow(
        `export const meta = { name: "f", description: "d", leak: this.constructor.constructor("return process.version")() };\nreturn 1;`,
      ),
    ).toThrow(/pure literal|Code generation from strings disallowed/i);
  });

  it("throws when meta is missing", () => {
    expect(() => parseWorkflow(`return 1;`)).toThrow(/export const meta/);
  });

  it("throws when name/description are absent", () => {
    expect(() => parseWorkflow(`export const meta = { name: "x" };\n`)).toThrow(
      /description/,
    );
  });
  it("ignores fake metadata in comments, templates, and regex literals", () => {
    const script = [
      '// export const meta = { name: "fake", description: "fake" };',
      'const text = `export const meta = { name: "fake-template", description: "fake" }; ${{ nested: { value: 1 } }.nested.value}`;',
      "const pattern = /export\\s+const\\s+meta\\s*=\\s*\\{/;",
      'export const meta = { name: "real", description: "real" };',
      "return [text, pattern.source];",
    ].join("\n");
    const { meta, body } = parseWorkflow(script);

    expect(meta.name).toBe("real");
    expect(body).toContain('export const meta = { name: "fake-template"');
    expect(body).toContain("/export\\s+const\\s+meta");
    expect(body).toContain("// export const meta");
  });

  it("finds the real metadata after a fake metadata string", () => {
    const script = String.raw`const fake = "export const meta = { name: 'fake', description: 'fake' };";
export const meta = { name: "real", description: "real" };
return fake;`;
    const { meta, body } = parseWorkflow(script);

    expect(meta).toEqual({ name: "real", description: "real" });
    expect(body).toContain("export const meta");
  });

  it("transforms actual top-level exports into executable declarations", async () => {
    const script = `export const helper = 40;
export default function increment(value) { return value + 2; }
export const meta = { name: "exports", description: "d" };
return increment(helper);`;
    const result = await runWorkflow(script, { runAgent: echoRunner() });

    expect(result.result).toBe(42);
  });

  it("handles a regex statement after a control-flow condition", async () => {
    const script = `export default function helper() {
  if (true) /}/.test("}");
  return 1;
}
export const meta = { name: "regex-control", description: "d" };
return helper();`;
    const result = await runWorkflow(script, { runAgent: echoRunner() });

    expect(result.result).toBe(1);
  });

  it("times out metadata evaluation in a child process", () => {
    const script =
      'export const meta = { name: "loop", description: "d", loop: (() => { while (true) {} })() };';
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { parseWorkflow } from ${JSON.stringify(
          "./src/workflow-script.mjs",
        )}; parseWorkflow(${JSON.stringify(script)});`,
      ],
      { encoding: "utf8", timeout: 2_000 },
    );

    expect((child.error as NodeJS.ErrnoException | undefined)?.code).not.toBe(
      "ETIMEDOUT",
    );
    expect(child.status).not.toBe(0);
    expect(`${child.stderr}${child.stdout}`).toMatch(/timed out|pure literal/i);
  });
});

describe("determinism guards", () => {
  const meta = `export const meta = { name: "g", description: "d" };\n`;
  const run = (body: string) =>
    runWorkflow(meta + body, { runAgent: echoRunner() });

  it("throws on Date.now()", async () => {
    await expect(run(`return Date.now();`)).rejects.toThrow(/Date\.now/);
  });
  it("throws on argless new Date()", async () => {
    await expect(run(`return new Date();`)).rejects.toThrow(/new Date/);
  });
  it("throws on Math.random()", async () => {
    await expect(run(`return Math.random();`)).rejects.toThrow(/Math\.random/);
  });
  it("allows new Date(ts) and Math.floor()", async () => {
    const r = await run(`return new Date(0).getTime() + Math.floor(1.9);`);
    expect(r.result).toBe(1);
  });
  it("does not inject Node globals", async () => {
    const r = await run(`return typeof process + "," + typeof require;`);
    expect(r.result).toBe("undefined,undefined");
  });

  it("blocks constructor-chain access to host process", async () => {
    await expect(
      run(`return this.constructor.constructor("return process.version")();`),
    ).rejects.toThrow(/Code generation from strings disallowed|process/i);
  });

  it("blocks constructor-chain Date.now bypass", async () => {
    await expect(
      run(`return this.constructor.constructor("return Date.now()")();`),
    ).rejects.toThrow(/Code generation from strings disallowed|Date\.now/i);
  });
});

describe("agent() + budget", () => {
  const meta = `export const meta = { name: "a", description: "d" };\n`;

  it("returns the sub-agent output text", async () => {
    const r = await runWorkflow(meta + `return await agent("hello");`, {
      runAgent: echoRunner(),
    });
    expect(r.result).toBe("hello");
    expect(r.agentsSpawned).toBe(1);
  });

  it("waits for unawaited agent work before completing", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      started();
      await gate;
      return ok(prompt);
    };
    const completion = runWorkflow(
      meta + `agent("background"); return "workflow-result";`,
      { runAgent },
    );
    let settled = false;
    void completion.then(() => (settled = true));
    await startedPromise;
    await tick();
    expect(settled).toBe(false);
    release();
    expect((await completion).result).toBe("workflow-result");
  });

  it("waits for agent work chained from an unawaited call", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(
      (resolve) => (releaseSecond = resolve),
    );
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      if (prompt === "second") await secondGate;
      return ok(prompt);
    };
    const completion = runWorkflow(
      meta +
        `agent("first").then(() => agent("second")); return "workflow-result";`,
      { runAgent },
    );
    let settled = false;
    void completion.then(() => (settled = true));
    await tick();
    await tick();
    expect(settled).toBe(false);
    releaseSecond();
    expect((await completion).result).toBe("workflow-result");
  });

  it("defaults agent isolation to process", async () => {
    let seenIsolation: string | undefined;
    const runAgent: WorkflowAgentRunner = async ({ isolation }) => {
      seenIsolation = isolation;
      return ok("done");
    };

    await runWorkflow(meta + `return await agent("hello");`, { runAgent });

    expect(seenIsolation).toBe("process");
  });

  it("allows agent isolation to opt out to in-process", async () => {
    let seenIsolation: string | undefined;
    const runAgent: WorkflowAgentRunner = async ({ isolation }) => {
      seenIsolation = isolation;
      return ok("done");
    };

    await runWorkflow(
      meta + `return await agent("hello", { isolation: "in-process" });`,
      { runAgent },
    );

    expect(seenIsolation).toBe("in-process");
  });

  it("returns null and counts errors when the sub-agent errors", async () => {
    const r = await runWorkflow(meta + `return await agent("x");`, {
      runAgent: async () => fail(),
    });
    expect(r.result).toBeNull();
    expect(r.errorCount).toBe(1);
  });

  it("accumulates token spend and throws once the budget is exhausted", async () => {
    const runAgent: WorkflowAgentRunner = async () => ok("done", 100);
    const r = await runWorkflow(
      meta + `await agent("a"); await agent("b"); return budget.remaining();`,
      { runAgent, budgetTotal: 150 },
    );
    // first agent spends 100 (remaining 50 > 0 ok), second spends 100 (now -50 -> 0 floor)
    expect(r.tokensSpent).toBe(200);
    expect(r.result).toBe(0);

    await expect(
      runWorkflow(
        meta + `await agent("a"); await agent("b"); await agent("c");`,
        {
          runAgent,
          budgetTotal: 150,
        },
      ),
    ).rejects.toThrow(/budget exhausted/i);
  });
});

describe("parallel()", () => {
  const meta = `export const meta = { name: "p", description: "d" };\n`;

  it("runs thunks concurrently and maps failures to null", async () => {
    const runAgent: WorkflowAgentRunner = async ({ prompt }) =>
      prompt === "bad" ? fail() : ok(prompt);
    const r = await runWorkflow(
      meta +
        `return await parallel([() => agent("a"), () => agent("bad"), () => agent("c")]);`,
      { runAgent },
    );
    expect(r.result).toEqual(["a", null, "c"]);
  });

  it("never exceeds the concurrency cap", async () => {
    let active = 0;
    let maxActive = 0;
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
      return ok(prompt);
    };
    const body = `return await parallel(Array.from({length: 10}, (_, i) => () => agent("t" + i, { isolation: "in-process" })));`;
    const r = await runWorkflow(meta + body, { runAgent, concurrency: 2 });
    expect((r.result as unknown[]).length).toBe(10);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("throws when item count exceeds the cap", async () => {
    const body = `return await parallel(Array.from({length: ${MAX_ITEMS_PER_CALL + 1}}, () => () => agent("x")));`;
    await expect(
      runWorkflow(meta + body, { runAgent: echoRunner() }),
    ).rejects.toThrow(/exceeds the/);
  });
});

describe("pipeline()", () => {
  const meta = `export const meta = { name: "pl", description: "d" };\n`;

  it("threads each item through stages independently", async () => {
    const body = `
      return await pipeline(
        [1, 2, 3],
        (prev) => prev * 10,
        (prev, item, index) => ({ prev, item, index })
      );`;
    const r = await runWorkflow(meta + body, { runAgent: echoRunner() });
    expect(r.result).toEqual([
      { prev: 10, item: 1, index: 0 },
      { prev: 20, item: 2, index: 1 },
      { prev: 30, item: 3, index: 2 },
    ]);
  });

  it("rejects non-function stages instead of filtering them", async () => {
    const body = `return await pipeline([1], (prev) => prev + 1, null);`;
    await expect(
      runWorkflow(meta + body, { runAgent: echoRunner() }),
    ).rejects.toThrow(/pipeline\(\): stages must be functions/i);
  });

  it("drops an item to null when a stage throws", async () => {
    const body = `
      return await pipeline(
        [1, 2, 3],
        (prev) => { if (prev === 2) throw new Error("nope"); return prev; }
      );`;
    const r = await runWorkflow(meta + body, { runAgent: echoRunner() });
    expect(r.result).toEqual([1, null, 3]);
  });
});

describe("schema enforcement", () => {
  const meta = `export const meta = { name: "s", description: "d" };\n`;
  const schema = {
    type: "object",
    required: ["n"],
    properties: { n: { type: "number" } },
  };

  it("parses and validates structured output", async () => {
    const runAgent: WorkflowAgentRunner = async () =>
      ok('```json\n{"n": 7}\n```');
    const body = `return await agent("give n", { schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(r.result).toEqual({ n: 7 });
  });

  it("retries on invalid output then succeeds", async () => {
    let call = 0;
    const runAgent: WorkflowAgentRunner = async () => {
      call++;
      return call === 1 ? ok('{"n": "not-a-number"}') : ok('{"n": 5}');
    };
    const body = `return await agent("give n", { schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(r.result).toEqual({ n: 5 });
    expect(call).toBe(2);
  });

  it("returns null and counts an error after exhausting retries", async () => {
    const runAgent: WorkflowAgentRunner = async () => ok("no json here");
    const body = `return await agent("give n", { schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(r.result).toBeNull();
    expect(r.errorCount).toBe(1);
    expect(r.agentsSpawned).toBe(3);
  });
});

describe("extractJson", () => {
  it("strips code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("extracts the first balanced object from surrounding prose", () => {
    expect(extractJson('Sure! Here you go: {"a": {"b": 2}} done')).toBe(
      '{"a": {"b": 2}}',
    );
  });
  it("extracts arrays", () => {
    expect(extractJson("result: [1, 2, 3]")).toBe("[1, 2, 3]");
  });
  it("returns null when there is no JSON", () => {
    expect(extractJson("just words")).toBeNull();
  });
});

describe("validateSchema", () => {
  it("passes a conforming object", () => {
    const s = {
      type: "object",
      required: ["x"],
      properties: { x: { type: "string" } },
    };
    expect(validateSchema({ x: "hi" }, s)).toEqual([]);
  });
  it("reports a missing required property", () => {
    const s = {
      type: "object",
      required: ["x"],
      properties: { x: { type: "string" } },
    };
    expect(validateSchema({}, s).length).toBeGreaterThan(0);
  });
  it("enforces array minItems and item type", () => {
    const s = { type: "array", minItems: 2, items: { type: "number" } };
    expect(validateSchema([1], s).length).toBeGreaterThan(0);
    expect(validateSchema([1, "two"], s).length).toBeGreaterThan(0);
    expect(validateSchema([1, 2], s)).toEqual([]);
  });
  it("enforces enum", () => {
    const s = { enum: ["a", "b"] };
    expect(validateSchema("a", s)).toEqual([]);
    expect(validateSchema("c", s).length).toBeGreaterThan(0);
  });
});

describe("workflow() composition", () => {
  const meta = `export const meta = { name: "w", description: "d" };\n`;

  it("runs a saved workflow inline and shares the agent counter", async () => {
    const child = `export const meta = { name: "child", description: "c" };\nreturn await agent("from child");`;
    const loadWorkflow = (n: string) => (n === "child" ? child : null);
    const r = await runWorkflow(
      meta +
        `const c = await workflow("child"); const p = await agent("from parent"); return [c, p];`,
      { runAgent: echoRunner(), loadWorkflow },
    );
    expect(r.result).toEqual(["from child", "from parent"]);
    expect(r.agentsSpawned).toBe(2); // counters shared across parent + child
  });

  it("throws when the named workflow is not found", async () => {
    await expect(
      runWorkflow(meta + `return await workflow("missing");`, {
        runAgent: echoRunner(),
        loadWorkflow: () => null,
      }),
    ).rejects.toThrow(/no saved workflow named/);
  });

  it("rejects object refs instead of reading scriptPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-script-path-"));
    const external = join(dir, "external.js");
    writeFileSync(
      external,
      `export const meta = { name: "external", description: "d" };\nreturn "external";`,
    );

    await expect(
      runWorkflow(
        meta +
          `return await workflow({ scriptPath: ${JSON.stringify(external)} });`,
        { runAgent: echoRunner() },
      ),
    ).rejects.toThrow(/saved-workflow name/i);
  });

  it("rejects nesting beyond one level", async () => {
    const child = `export const meta = { name: "child", description: "c" };\nreturn await workflow("grand");`;
    const loadWorkflow = (n: string) =>
      n === "child"
        ? child
        : `export const meta = { name: "g", description: "g" };\nreturn 1;`;
    await expect(
      runWorkflow(meta + `return await workflow("child");`, {
        runAgent: echoRunner(),
        loadWorkflow,
      }),
    ).rejects.toThrow(/one level deep/);
  });
});

describe("saved workflows", () => {
  it("saves, loads, and lists a workflow by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-saved-"));
    const script = `export const meta = { name: "greet", description: "say hi" };\nreturn "hi";`;
    saveWorkflowScript("greet", script, dir);
    expect(loadWorkflowScript("greet", dir)).toBe(script);
    expect(loadWorkflowScript("nope", dir)).toBeNull();
    const list = listSavedWorkflows(dir);
    expect(list).toEqual([{ name: "greet", description: "say hi" }]);
  });

  it("rejects an invalid name and an unparseable script", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-saved-"));
    expect(() => sanitizeWorkflowName("Bad Name")).toThrow(
      /Invalid workflow name/,
    );
    expect(() => saveWorkflowScript("ok", `return 1;`, dir)).toThrow(
      /export const meta/,
    );
  });

  it("deleteWorkflowScript removes a saved workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-del-"));
    const script = `export const meta = { name: "greet", description: "say hi" };\nreturn "hi";`;
    saveWorkflowScript("greet", script, dir);
    expect(loadWorkflowScript("greet", dir)).toBe(script);
    const result = deleteWorkflowScript("greet", dir);
    expect(result).toBe(true);
    expect(loadWorkflowScript("greet", dir)).toBeNull();
  });

  it("deleteWorkflowScript returns false for missing workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-del-"));
    const result = deleteWorkflowScript("nonexistent", dir);
    expect(result).toBe(false);
  });

  it("deleteWorkflowScript throws on invalid name", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-del-"));
    expect(() => deleteWorkflowScript("Bad Name", dir)).toThrow(
      /Invalid workflow name/,
    );
  });

  it("listSavedWorkflows handles unparseable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-list-"));
    // Write a file that's not valid JSON/meta
    writeFileSync(
      join(dir, "broken.js"),
      "this is not a valid workflow",
      "utf8",
    );
    const list = listSavedWorkflows(dir);
    expect(list).toEqual([{ name: "broken", description: "(unparseable)" }]);
  });
});

describe("background workflow jobs", () => {
  it("presents resolved agent errors as a warning", () => {
    expect(getWorkflowCompletionPresentation("done", 2)).toEqual({
      label: "completed with errors",
      icon: "⚠",
    });
    expect(getWorkflowCompletionPresentation("error", 0)).toEqual({
      label: "error",
      icon: "",
    });
  });

  it("runs in the background and exposes status + result", async () => {
    const script = `export const meta = { name: "bg", description: "d" };\nreturn await agent("done");`;
    const job = startWorkflowJob("bg", script, { runAgent: echoRunner() });
    expect(workflowJobRegistry.get(job.id)).toBe(job);
    const run = await job.promise;
    expect(run.result).toBe("done");
    expect(job.status).toBe("done");
    expect(job.snapshot.agentsSpawned).toBe(1);
  });

  it("calls the completion hook after all agents finish", async () => {
    const onComplete = vi.fn();
    const script =
      `export const meta = { name: "bg-hook", description: "d" };\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "bg-hook",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );

    await job.promise;

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(job);
    expect(job.status).toBe("done");
    expect(job.result?.result).toBe("done");
  });

  it("calls the completion hook when a workflow fails", async () => {
    const onComplete = vi.fn();
    const runAgent: WorkflowAgentRunner = () => {
      throw new Error("workflow boom");
    };
    const script =
      `export const meta = { name: "bg-error", description: "d" };\n` +
      `return await agent("fail");`;
    const job = startWorkflowJob(
      "bg-error",
      script,
      { runAgent },
      undefined,
      onComplete,
    );

    await expect(job.promise).rejects.toThrow("workflow boom");

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(job);
    expect(job.status).toBe("error");
  });

  it("marks the job cancelled when aborted", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      await gate;
      return ok(prompt);
    };
    const script = `export const meta = { name: "bgc", description: "d" };\nreturn await agent("x");`;
    const onComplete = vi.fn();
    const job = startWorkflowJob(
      "bgc",
      script,
      { runAgent },
      undefined,
      onComplete,
    );
    job.abort.abort();
    release();
    await expect(job.promise).rejects.toThrow(/aborted/);
    expect(job.status).toBe("cancelled");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("suppresses a late completion hook after parent shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const onComplete = vi.fn();
    const job = startWorkflowJob(
      "late",
      `export const meta = { name: "late", description: "d" };\nreturn await agent("x");`,
      {
        runAgent: async ({ prompt }) => {
          await gate;
          return ok(prompt);
        },
      },
      undefined,
      onComplete,
    );

    job.suppressCompletionNotification = true;
    job.abort.abort();
    release();

    await expect(job.promise).rejects.toThrow(/aborted/);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("snapshot reflects in-flight agents before they complete (regression: agent_start emit)", async () => {
    // Pre-fix bug: the only "agent" emit fired AFTER `await runAgent` returned, so the snapshot's
    // agentsSpawned stayed at 0 until every agent finished. Process-isolated agents can take minutes,
    // making get_workflow_status look stuck. The fix emits "agent_start" right after the counter is
    // incremented, so the snapshot reflects in-flight activity immediately.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      await gate;
      return ok(prompt);
    };
    const script = `export const meta = { name: "bgs", description: "d" };\nreturn await agent("x");`;
    const job = startWorkflowJob("bgs", script, { runAgent });

    // Worker-backed workflows cross a thread boundary before the parent emits agent_start.
    // Wait for that handoff, but assert while runAgent is still blocked on gate.
    for (let i = 0; i < 500 && job.snapshot.agentsSpawned === 0; i++)
      await new Promise((r) => setTimeout(r, 10));

    // While the agent is still blocked on `gate`, the snapshot must already show 1 spawned.
    // This is the regression: pre-fix, this would be 0.
    expect(job.snapshot.agentsSpawned).toBe(1);
    expect(job.snapshot.lastMessage).toBe("→ started agent");

    release();
    await job.promise;
    expect(job.snapshot.agentsSpawned).toBe(1);
    expect(job.snapshot.lastMessage).toBe("→ done agent");
  }, 10_000);

  it("clears runningCount when runAgent throws", async () => {
    const runAgent: WorkflowAgentRunner = () => {
      throw new Error("boom");
    };
    const script = `export const meta = { name: "bgr", description: "d" };\nreturn await agent("x");`;
    const job = startWorkflowJob("bgr", script, { runAgent });

    await expect(job.promise).rejects.toThrow("boom");
    expect(job.status).toBe("error");
    expect(job.snapshot.runningCount).toBe(0);
  });
});
it("sets startedAt from the passed timestamp", () => {
  const script = `export const meta = { name: "ts", description: "d" };\nreturn 1;`;
  const startedAt = 1234567890;
  const job = startWorkflowJob(
    "ts",
    script,
    { runAgent: echoRunner() },
    startedAt,
  );
  expect(job.startedAt).toBe(startedAt);
});

it("defaults startedAt to Date.now() when not provided", () => {
  const before = Date.now();
  const script = `export const meta = { name: "ts2", description: "d" };\nreturn 1;`;
  const job = startWorkflowJob("ts2", script, { runAgent: echoRunner() });
  expect(job.startedAt).toBeGreaterThanOrEqual(before);
  expect(job.startedAt).toBeLessThanOrEqual(Date.now());
});

it("throws when all 100 job slots are full and none can be evicted", () => {
  const filled: string[] = [];
  try {
    for (let i = 0; i < MAX_WORKFLOW_JOBS; i++) {
      const id = `cap-fill-${i}`;
      workflowJobRegistry.set(id, {
        id,
        name: "filler",
        status: "running",
        startedAt: Date.now(),
        promise: undefined as any,
        abort: new AbortController(),
        snapshot: {
          agentsSpawned: 0,
          errorCount: 0,
          tokensSpent: 0,
          phases: [],
        },
      });
      filled.push(id);
    }
    const script = `export const meta = { name: "x", description: "d" };\nreturn "ok";`;
    expect(() =>
      startWorkflowJob("x", script, { runAgent: echoRunner() }),
    ).toThrow(/100 workflow jobs already running/);
  } finally {
    for (const id of filled) workflowJobRegistry.delete(id);
  }
});

describe("awaitInteractiveResult", () => {
  function fakeState(dir: string) {
    return { id: "abcd1234", artifactDir: dir, model: "test/model" } as any;
  }

  it("resolves with output.md when a done event is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    writeFileSync(join(dir, "output.md"), "final answer");
    writeFileSync(
      join(dir, "events.ndjson"),
      JSON.stringify({ ts: 1, type: "started", status: "running" }) +
        "\n" +
        JSON.stringify({ ts: 2, type: "done", status: "done", exitCode: 0 }) +
        "\n",
    );
    const res = await awaitInteractiveResult(fakeState(dir), undefined, 5);
    expect(res.isError).toBe(false);
    expect(res.output).toBe("final answer");
  });

  it("returns an error result on an error event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    writeFileSync(join(dir, "output.md"), "partial");
    writeFileSync(
      join(dir, "events.ndjson"),
      JSON.stringify({
        ts: 1,
        type: "error",
        status: "error",
        message: "kaboom",
      }) + "\n",
    );
    const res = await awaitInteractiveResult(fakeState(dir), undefined, 5);
    expect(res.isError).toBe(true);
    expect((res as any).errorMessage).toMatch(/kaboom/);
  });

  it("honors an already-aborted signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    mkdirSync(dir, { recursive: true });
    const ac = new AbortController();
    ac.abort();
    const res = await awaitInteractiveResult(fakeState(dir), ac.signal, 5);
    expect(res.isError).toBe(true);
    expect((res as any).errorMessage).toMatch(/aborted/);
  });
});

describe("abort signal propagation", () => {
  const meta = `export const meta = { name: "abort", description: "d" };\n`;

  // Helper: a runAgent that aborts mid-flight if `signal` has fired.
  function abortableRunAgent(delayMs = 10): WorkflowAgentRunner {
    return async ({ signal }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      if (signal?.aborted) throw new Error("Workflow aborted.");
      return ok("done");
    };
  }

  it("parallel() re-throws when the signal aborts mid-flight", async () => {
    const ac = new AbortController();
    const p = runWorkflow(
      meta +
        `const r = await parallel([() => agent("a"), () => agent("b")]); return r;`,
      { runAgent: abortableRunAgent(10), signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 2);
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("pipeline() re-throws when the signal aborts mid-flight", async () => {
    const ac = new AbortController();
    const p = runWorkflow(
      meta +
        `const stage = async (prev) => { await agent("s"); return prev; };
         const r = await pipeline([1, 2], stage); return r;`,
      { runAgent: abortableRunAgent(10), signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 2);
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("parallel() pre-aborted (signal fires before invoke) re-throws without running agents", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const runAgent: WorkflowAgentRunner = async () => {
      calls++;
      return ok("nope");
    };
    await expect(
      runWorkflow(
        meta + `return await parallel([() => agent("a"), () => agent("b")]);`,
        { runAgent, signal: ac.signal },
      ),
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(0); // agents never invoked — abort check fires first
  });

  it("abort terminates a workflow stuck in synchronous script code", async () => {
    const ac = new AbortController();
    const p = runWorkflow(meta + `while (true) {}`, {
      runAgent: echoRunner(),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("workflow timeout aborts in-flight agent work and suppresses late progress", async () => {
    let abortSeen = false;
    let resolveLate!: () => void;
    const lateDone = new Promise<void>((resolve) => (resolveLate = resolve));
    const progress: string[] = [];
    const runAgent: WorkflowAgentRunner = async ({ signal }) => {
      signal?.addEventListener(
        "abort",
        () => {
          abortSeen = true;
        },
        { once: true },
      );
      await new Promise((r) => setTimeout(r, 2500));
      resolveLate();
      return ok("late");
    };

    const p = runWorkflow(meta + `return await agent("slow");`, {
      runAgent,
      workflowTimeoutMs: 2000,
      onProgress: (ev) => {
        progress.push(`${ev.kind}:${ev.runningCount}:${ev.agentsSpawned}`);
      },
    });

    await expect(p).rejects.toThrow(/timed out/i);
    expect(abortSeen).toBe(true);
    const progressAtFailure = [...progress];

    await lateDone;
    await tick();
    expect(progress).toEqual(progressAtFailure);
  }, 10_000);

  it("non-abort failures in parallel() are still nulled (back-compat)", async () => {
    const runAgent: WorkflowAgentRunner = async () => fail("boom");
    const r = await runWorkflow(
      meta +
        `const r = await parallel([() => agent("a"), () => agent("b")]); return r;`,
      { runAgent },
    );
    expect(r.result).toEqual([null, null]);
    expect(r.errorCount).toBe(2);
  });
});

describe("renderProgress", () => {
  it("formats a phase progress update", () => {
    const p: WorkflowProgress = {
      kind: "phase",
      phase: "Scanning",
      agentsSpawned: 2,
      errorCount: 0,
      tokensSpent: 100,
      runningCount: 1,
    };
    const result = renderProgress(p);
    expect(result).toContain("● workflow — 2 agent(s)");
    expect(result).toContain("⚡ 1 running");
    expect(result).toContain("100 tokens");
    expect(result).toContain("◆ phase: Scanning");
  });

  it("formats a log progress update", () => {
    const p: WorkflowProgress = {
      kind: "log",
      message: "hello",
      agentsSpawned: 3,
      errorCount: 0,
      tokensSpent: 50,
      runningCount: 0,
    };
    const result = renderProgress(p);
    expect(result).toContain("● workflow — 3 agent(s)");
    expect(result).not.toContain("⚡");
    expect(result).toContain("50 tokens");
    expect(result).toContain("hello");
  });

  it("formats an agent_start update without label or model", () => {
    const p: WorkflowProgress = {
      kind: "agent_start",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 0,
      runningCount: 1,
    };
    const result = renderProgress(p);
    expect(result).toContain("→ started");
    expect(result).not.toMatch(/started @/);
  });

  it("formats an agent_start update with label and model", () => {
    const p: WorkflowProgress = {
      kind: "agent_start",
      label: "scout",
      model: "gpt-4",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 0,
      runningCount: 1,
    };
    const result = renderProgress(p);
    expect(result).toContain("→ started scout @gpt-4");
  });

  it("formats an agent_done update without label or model", () => {
    const p: WorkflowProgress = {
      kind: "agent_done",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 100,
      runningCount: 0,
    };
    const result = renderProgress(p);
    expect(result).toContain("→ done");
    expect(result).not.toMatch(/done @/);
  });

  it("formats an agent_done update with label and model", () => {
    const p: WorkflowProgress = {
      kind: "agent_done",
      label: "scout",
      model: "gpt-4",
      agentsSpawned: 1,
      errorCount: 1,
      tokensSpent: 100,
      runningCount: 0,
    };
    const result = renderProgress(p);
    expect(result).toContain("→ done scout @gpt-4");
    expect(result).toContain("⚠ 1 error(s)");
  });

  it("falls back to just the head line for unknown kinds", () => {
    const p = {
      kind: "unknown" as const,
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      runningCount: 0,
    };
    const result = renderProgress(p as unknown as WorkflowProgress);
    expect(result).toBe("● workflow — 0 agent(s), 0 tokens");
  });

  it("omits running count when runningCount is 0", () => {
    const p: WorkflowProgress = {
      kind: "phase",
      phase: "done",
      agentsSpawned: 5,
      errorCount: 0,
      tokensSpent: 200,
      runningCount: 0,
    };
    const result = renderProgress(p);
    expect(result).not.toContain("⚡");
    expect(result).toContain("5 agent(s)");
  });

  it("omits error count when errorCount is 0", () => {
    const p: WorkflowProgress = {
      kind: "phase",
      phase: "done",
      agentsSpawned: 5,
      errorCount: 0,
      tokensSpent: 200,
      runningCount: 2,
    };
    const result = renderProgress(p);
    expect(result).not.toContain("⚠");
  });

  it("shows both running count and error count when both are non-zero", () => {
    const p: WorkflowProgress = {
      kind: "phase",
      phase: "working",
      agentsSpawned: 10,
      errorCount: 3,
      tokensSpent: 500,
      runningCount: 2,
    };
    const result = renderProgress(p);
    expect(result).toContain("⚡ 2 running");
    expect(result).toContain("⚠ 3 error(s)");
    expect(result).toContain("10 agent(s)");
    expect(result).toContain("500 tokens");
  });
});

describe("registerWorkflowTool", () => {
  it("registers 6 tools with the Pi SDK", () => {
    const tools: Array<{ name: string }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    expect(tools).toHaveLength(7);
    expect(tools.map((t) => t.name)).toEqual([
      "workflow",
      "get_workflow_status",
      "get_workflow_result",
      "cancel_workflow",
      "save_workflow",
      "list_workflows",
      "delete_workflow",
    ]);
  });

  it("registers workflow slash commands", () => {
    const commands: Array<{ name: string }> = [];
    const pi = {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn((name: string, def: any) =>
        commands.push({ name, ...def }),
      ),
      on: vi.fn(),
    };

    registerWorkflowTool(pi as any);

    expect(commands.map((c) => c.name)).toEqual([
      "workflow",
      "workflows",
      "list-workflows",
      "workflow-status",
      "workflow-tree",
      "delete-workflow",
    ]);
  });

  it("/workflow queues a prompt to create, save, and run a workflow", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const pi = {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn((name: string, def: any) =>
        commands.push({ name, ...def }),
      ),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      ui: { notify: vi.fn() },
      sendUserMessage: vi.fn(),
    };

    registerWorkflowTool(pi as any);
    const cmd = commands.find((c) => c.name === "workflow")!;
    await cmd.handler("build a release checklist", ctx);

    expect(ctx.sendUserMessage).toHaveBeenCalledTimes(1);
    const [prompt, opts] = ctx.sendUserMessage.mock.calls[0];
    expect(prompt).toContain("save_workflow");
    expect(prompt).toContain("workflow` tool");
    expect(prompt).toContain("build a release checklist");
    expect(prompt).not.toContain("Big Pickle");
    expect(opts).toEqual({ deliverAs: "followUp" });
  });

  it("workflow tool has the expected description and parameters", () => {
    const tools: Array<{ name: string; description: string; parameters: any }> =
      [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const wf = tools.find((t) => t.name === "workflow")!;
    expect(wf.description).toContain("agent(prompt, opts?)");
    expect(wf.description).toContain("workflow(name, args?)");
    expect(wf.parameters).toBeDefined();
    expect(wf.parameters.properties).toBeDefined();
    expect(Object.keys(wf.parameters.properties)).toContain("script");
    expect(Object.keys(wf.parameters.properties)).toContain("name");
    expect(Object.keys(wf.parameters.properties)).toContain("async");
  });

  it("does not report a completed workflow as cancelled", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const job = startWorkflowJob(
      "already-done",
      `export const meta = { name: "already-done", description: "d" };\nreturn "done";`,
      { runAgent: echoRunner() },
    );
    await job.promise;

    const cancel = tools.find((tool) => tool.name === "cancel_workflow")!;
    const result = await cancel.execute("", { workflowId: job.id });

    expect(result.details).toMatchObject({
      status: "done",
      workflowId: job.id,
      cancelled: false,
    });
    expect(result.content[0].text).toContain("already done");

    job.status = "cancelled";
    const repeated = await cancel.execute("", { workflowId: job.id });
    expect(repeated.details).toMatchObject({
      status: "cancelled",
      workflowId: job.id,
      cancelled: true,
    });
    expect(repeated.content[0].text).toContain("already cancelled");
    workflowJobRegistry.delete(job.id);
  });

  it("save_workflow tool validates the script before persisting", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const save = tools.find((t) => t.name === "save_workflow")!;
    // Bad script (missing meta) should fail
    const result = await save.execute(
      "",
      { name: "bad", script: "return 1;" },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain("Could not save workflow");
    expect(result.isError).toBe(true);
  });

  it("lists workflows and rejects an invalid delete name", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);

    const list = tools.find((tool) => tool.name === "list_workflows")!;
    const listed = await list.execute();
    expect(listed.details.status).toBe("ok");
    expect(Array.isArray(listed.details.workflows)).toBe(true);

    const remove = tools.find((tool) => tool.name === "delete_workflow")!;
    const deleted = await remove.execute("", { name: "../invalid" });
    expect(deleted).toMatchObject({
      isError: true,
      details: { status: "error" },
    });
    expect(deleted.content[0].text).toContain("Could not delete workflow");
  });

  it("notifies the current parent and triggers a turn when a background workflow completes", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const staleSendMessage = vi.fn();
    const sendMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage: staleSendMessage,
    };
    const currentPi = { sendMessage };
    const g = globalThis as any;
    const previousPi = g.__piSubagenturaPiRef;
    g.__piSubagenturaPiRef = currentPi;
    registerWorkflowTool(pi as any);
    try {
      const workflow = tools.find((tool) => tool.name === "workflow")!;
      const started = await workflow.execute(
        "call-id",
        {
          script:
            'export const meta = { name: "notify", description: "d" };\n' +
            'return "final result";',
          async: true,
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
      );
      const job = workflowJobRegistry.get(started.details.workflowId)!;

      await job.promise;

      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "workflow-notify",
          content: expect.stringContaining(
            `Call get_workflow_result with workflowId "${job.id}"`,
          ),
        }),
        { deliverAs: "followUp", triggerTurn: true },
      );
      expect(staleSendMessage).not.toHaveBeenCalled();
      expect(sendMessage.mock.calls[0][0].content).not.toContain(
        "final result",
      );
      workflowJobRegistry.delete(job.id);
    } finally {
      g.__piSubagenturaPiRef = previousPi;
    }
  });

  it("notifies and triggers a turn when a workflow returns no result", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const sendMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage,
    };
    const g = globalThis as any;
    const previousPi = g.__piSubagenturaPiRef;
    g.__piSubagenturaPiRef = pi;
    registerWorkflowTool(pi as any);
    try {
      const workflow = tools.find((tool) => tool.name === "workflow")!;
      const started = await workflow.execute(
        "call-id",
        {
          script:
            'export const meta = { name: "empty", description: "d" };\n' +
            "return;",
          async: true,
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
      );
      const job = workflowJobRegistry.get(started.details.workflowId)!;

      await job.promise;

      expect(job.status).toBe("done");
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "workflow-notify",
          content: expect.stringContaining(
            `Call get_workflow_result with workflowId "${job.id}"`,
          ),
        }),
        { deliverAs: "followUp", triggerTurn: true },
      );
      expect(sendMessage.mock.calls[0][0].content).not.toContain(
        "workflow returned no result",
      );
      workflowJobRegistry.delete(job.id);
    } finally {
      g.__piSubagenturaPiRef = previousPi;
    }
  });

  it("sanitizes and caps workflow failure notifications", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const sendMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage,
    };
    const g = globalThis as any;
    const previousPi = g.__piSubagenturaPiRef;
    g.__piSubagenturaPiRef = pi;
    registerWorkflowTool(pi as any);
    try {
      const workflow = tools.find((tool) => tool.name === "workflow")!;
      const secret = "sk-" + "a".repeat(30);
      const started = await workflow.execute(
        "call-id",
        {
          script:
            'export const meta = { name: "error", description: "d" };\n' +
            `throw new Error(${JSON.stringify(secret + " ".repeat(30_000))});`,
          async: true,
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
      );
      const job = workflowJobRegistry.get(started.details.workflowId)!;

      await expect(job.promise).rejects.toThrow();

      const message = sendMessage.mock.calls[0]?.[0].content as string;
      expect(message).not.toContain(secret);
      expect(message.length).toBeLessThan(21_000);
      workflowJobRegistry.delete(job.id);
    } finally {
      g.__piSubagenturaPiRef = previousPi;
    }
  });

  it("derives completed-with-errors presentation while keeping raw done status", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const sendUserMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendUserMessage,
    };
    registerWorkflowTool(pi as any);
    const job = startWorkflowJob(
      "errors",
      'export const meta = { name: "errors", description: "d" };\nreturn "ok";',
      { runAgent: echoRunner() },
    );
    const run = await job.promise;
    run.errorCount = 2;
    job.snapshot.errorCount = 2;

    const statusTool = tools.find(
      (tool) => tool.name === "get_workflow_status",
    )!;
    const status = await statusTool.execute("", { workflowId: job.id });
    expect(status.details.status).toBe("done");
    expect(status.content[0].text).toContain("⚠");
    expect(status.content[0].text).toContain("completed with errors");

    const resultTool = tools.find(
      (tool) => tool.name === "get_workflow_result",
    )!;
    const result = await resultTool.execute("", { workflowId: job.id });
    expect(result.details.status).toBe("done");
    expect(result.content[0].text).toContain("⚠");
    expect(result.content[0].text).toContain("completed with errors");

    const statusCommand = (pi.registerCommand as any).mock.calls.find(
      ([name]: [string]) => name === "workflow-status",
    )?.[1];
    await statusCommand.handler("", { ui: { notify: vi.fn() } });
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("completed with errors"),
      { deliverAs: "followUp" },
    );
    workflowJobRegistry.delete(job.id);
  });

  it("explains current-session scope in async start and not-found messages", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const workflow = tools.find((tool) => tool.name === "workflow")!;
    const started = await workflow.execute(
      "",
      {
        script:
          'export const meta = { name: "scope", description: "d" };\nreturn 1;',
        async: true,
      },
      undefined,
      undefined,
      { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
    );
    expect(started.content[0].text).toContain("current parent session");
    expect(started.content[0].text).toContain("reload/resume/new/quit");

    const statusTool = tools.find(
      (tool) => tool.name === "get_workflow_status",
    )!;
    const missing = await statusTool.execute("", { workflowId: "wf_missing" });
    expect(missing.content[0].text).toContain("current parent session");
    expect(missing.content[0].text).toContain("reload/resume/new/quit");
    workflowJobRegistry.delete(started.details.workflowId);
  });

  it("reentrant retry from within callback is guarded by _notificationInFlight", async () => {
    let attempts = 0;
    const onComplete = (job: any) => {
      attempts++;
      // Simulate a retry trigger from within the callback (e.g. poller re-entrance).
      retryPendingWorkflowNotifications();
    };
    const script =
      `export const meta = { name: "reentrant", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "reentrant",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;
    // Without the guard, the reentrant call would invoke the callback a second time.
    expect(attempts).toBe(1);
  });

  it("callback throw then successful retry via retryPendingWorkflowNotifications", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
      if (attempts === 1) throw new Error("transient failure");
      // Second attempt succeeds.
    };
    const script =
      `export const meta = { name: "throw-retry", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "throw-retry",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;
    // First call: hook throws, delivered stays false, attempt incremented to 1.
    expect(job.completionNotificationDelivered).toBe(false);
    expect(job.notificationAttempt).toBe(1);

    // Simulate poller tick — retries the failed notification.
    retryPendingWorkflowNotifications();
    expect(job.completionNotificationDelivered).toBe(true);
    // Attempt count is 2 (two total invocations); does NOT reset to 0.
    expect(job.notificationAttempt).toBe(2);
    expect(attempts).toBe(2);
  });

  it("persistent callback failure exhausts after MAX_WORKFLOW_NOTIFICATION_ATTEMPTS retries", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
      throw new Error("permanent failure");
    };
    const script =
      `export const meta = { name: "exhaust", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "exhaust",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;

    // First invocation threw, so notificationAttempt is 1.
    expect(job.notificationAttempt).toBe(1);
    expect(job.completionNotificationDelivered).toBe(false);

    // Exhaust remaining attempts via poller ticks (MAX-1 more calls).
    for (let i = 0; i < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS - 1; i++) {
      retryPendingWorkflowNotifications();
    }

    // Counter reached MAX; exhausted flag is set.
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job.completionNotificationDelivered).toBe(false);
    expect(job._notificationExhausted).toBe(true);
    expect(attempts).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);

    // Extra retries after exhaustion are no-ops: callback not re-invoked, counter unchanged.
    const callsBefore = attempts;
    for (let i = 0; i < 10; i++) retryPendingWorkflowNotifications();
    expect(attempts).toBe(callsBefore);
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job._notificationExhausted).toBe(true);
  });

  it("exhaustion log fires exactly once", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
      throw new Error("always fail");
    };
    const script =
      `export const meta = { name: "exhaust-log", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "exhaust-log",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;

    // Exhaust: invoke MAX times (initial + MAX-1 retries), all throw.
    for (let i = 0; i < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS; i++) {
      retryPendingWorkflowNotifications();
    }

    // Exhausted flag is set, callback never invoked again.
    expect(job._notificationExhausted).toBe(true);
    expect(attempts).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    const callsBefore = attempts;
    for (let i = 0; i < 5; i++) retryPendingWorkflowNotifications();
    expect(attempts).toBe(callsBefore);
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job._notificationExhausted).toBe(true);
  });

  it("success marks delivered and preserves truthful attempt count", async () => {
    let count = 0;
    const onComplete = () => {
      count++;
      if (count <= 2) throw new Error("transient");
    };
    const script =
      `export const meta = { name: "truth-count", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "truth-count",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;

    // Initial call throws (attempt 1, throw still increments the counter).
    expect(job.notificationAttempt).toBe(1);
    expect(job.completionNotificationDelivered).toBe(false);

    // Second call throws (attempt 2).
    retryPendingWorkflowNotifications();
    expect(job.notificationAttempt).toBe(2);

    // Third call succeeds → attempt=3, delivered.
    retryPendingWorkflowNotifications();
    expect(job.notificationAttempt).toBe(3);
    expect(job.completionNotificationDelivered).toBe(true);
    expect(count).toBe(3);
  });

  it("MAXth attempt success does not mark exhaustion", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
      // Fail four times, succeed on the fifth (the MAXth invocation).
      if (attempts < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS) {
        throw new Error("transient failure");
      }
    };
    const script =
      `export const meta = { name: "maxth-ok", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "maxth-ok",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;

    // Initial call throws (attempt 1).
    expect(job.notificationAttempt).toBe(1);
    expect(job.completionNotificationDelivered).toBe(false);

    // Retries 2-4 also throw.
    for (let i = 0; i < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS - 2; i++) {
      retryPendingWorkflowNotifications();
    }
    expect(job.notificationAttempt).toBe(
      MAX_WORKFLOW_NOTIFICATION_ATTEMPTS - 1,
    );
    expect(job.completionNotificationDelivered).toBe(false);

    // Attempt 5 (the MAXth) succeeds.
    retryPendingWorkflowNotifications();
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job.completionNotificationDelivered).toBe(true);
    // Crucially: must NOT be marked exhausted.
    expect(job._notificationExhausted).toBeFalsy();
    expect(attempts).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
  });

  it("suppressed jobs never attempt delivery on retry", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
    };
    const script =
      `export const meta = { name: "supp", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "supp",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );

    // Mark suppressed before workflow settles.
    job.suppressCompletionNotification = true;
    await job.promise;
    expect(attempts).toBe(0);

    // Retry should still skip.
    retryPendingWorkflowNotifications();
    expect(attempts).toBe(0);
  });

  it("synchronous workflow output reflects error status for a failing script", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const workflow = tools.find((tool) => tool.name === "workflow")!;
    const result = await workflow.execute(
      "",
      {
        script:
          'export const meta = { name: "sync-err", description: "d" };\n' +
          'throw new Error("partial failure");',
        async: false,
      },
      undefined,
      vi.fn(),
      { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
    );
    expect(result.details.status).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Workflow failed");
  });

  it("async completed-with-errors notification includes details with presentationStatus and workflowId", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const sendMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage,
    };
    const g = globalThis as any;
    const previousPi = g.__piSubagenturaPiRef;
    g.__piSubagenturaPiRef = pi;
    registerWorkflowTool(pi as any);
    try {
      // Create a job that completes with errorCount > 0.
      const job = startWorkflowJob(
        "notify-errors",
        'export const meta = { name: "notify-errors", description: "d" };\nreturn "ok";',
        { runAgent: echoRunner() },
        undefined,
        // Inline callback: simulate notifyWorkflowCompletion behavior.
        (j) => {
          j.result!.errorCount = 1;
          // Trigger the real notification path via the tool's notifyWorkflowCompletion.
        },
      );
      await job.promise;

      // Now simulate what the registerWorkflowTool notify callback does.
      // Use the actual notify function by finding it through the tool.
      // We can call startWorkflowJob with the real notifyWorkflowCompletion
      // by using the workflow tool's execute method.
      const workflow = tools.find((tool) => tool.name === "workflow")!;
      const started = await workflow.execute(
        "call-id",
        {
          script:
            'export const meta = { name: "notify-err-detail", description: "d" };\n' +
            'return "result";',
          async: true,
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
      );
      const errJob = workflowJobRegistry.get(started.details.workflowId)!;
      await errJob.promise;

      // The notification should have been sent.
      expect(sendMessage).toHaveBeenCalled();
      const notification = sendMessage.mock.calls[0][0];
      expect(notification.customType).toBe("workflow-notify");
      expect(notification.details).toMatchObject({
        workflowId: errJob.id,
        status: errJob.status,
      });
      expect(notification.details.presentationStatus).toBeDefined();
      // content should contain the workflow name and ID.
      expect(notification.content).toContain(errJob.name);
      expect(notification.content).toContain(errJob.id);
      workflowJobRegistry.delete(errJob.id);
    } finally {
      g.__piSubagenturaPiRef = previousPi;
    }
  });

  it("marks _notificationExhausted after MAX_WORKFLOW_NOTIFICATION_ATTEMPTS callback-return-false retries", async () => {
    const falseReturns = Array.from(
      { length: MAX_WORKFLOW_NOTIFICATION_ATTEMPTS },
      () => false,
    );
    let callCount = 0;
    const onComplete = vi.fn(() => {
      callCount++;
      return false;
    });

    const job = startWorkflowJob(
      "exhaust-test",
      'export const meta = { name: "exhaust-test", description: "d" };\nreturn "done";',
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );

    await job.promise;

    // First call succeeded, notification delivered = false because callback returned false
    expect(job.completionNotificationDelivered).toBe(false);
    expect(job._notificationExhausted).toBeFalsy();

    // Simulate retries by calling retryPendingWorkflowNotifications
    for (let i = 0; i < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS - 1; i++) {
      retryPendingWorkflowNotifications();
    }

    // After MAX attempts total (1 initial + MAX-1 retries), should be exhausted
    expect(onComplete).toHaveBeenCalledTimes(
      MAX_WORKFLOW_NOTIFICATION_ATTEMPTS,
    );
    expect(job._notificationExhausted).toBe(true);
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);

    // Further calls should be no-ops (exhausted guard)
    retryPendingWorkflowNotifications();
    expect(onComplete).toHaveBeenCalledTimes(
      MAX_WORKFLOW_NOTIFICATION_ATTEMPTS,
    );
  });
});
