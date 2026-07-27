import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type TerminalHarness } from "./harness.mjs";
import { getScenario } from "./scenarios.mjs";

const timeout = 60_000;
const harnesses: TerminalHarness[] = [];
const failedHarnesses = new Set<TerminalHarness>();
let harness: TerminalHarness;

beforeEach(() => {
  harness = createHarness({ scenario: "terminal" });
  harnesses.push(harness);
});

afterEach((context) => {
  const failed = context.task.result?.state === "fail";
  if (!failed) return;
  failedHarnesses.add(harness);
  try {
    harness.diagnostics();
  } catch (error) {
    console.error(`terminal E2E diagnostics failed: ${error}`);
  }
});

afterAll(async () => {
  const results = await Promise.allSettled(
    harnesses.map((candidate) =>
      candidate.cleanup(failedHarnesses.has(candidate)),
    ),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0)
    throw new AggregateError(errors, "suite teardown failed");
}, timeout);

function hasStage(
  events: Array<Record<string, unknown>>,
  marker: string,
  stage: string,
): boolean {
  return events.some(
    (event) => event.marker === marker && event.afterStage === stage,
  );
}

async function startScenario(name: string): Promise<void> {
  const scenario = getScenario(name);
  harness.scenario = name;
  await harness.start();
  harness.sendText(scenario.prompt);
  harness.pressEnter();
}

async function waitForParentSettled(marker: string): Promise<void> {
  await harness.waitForProvider(
    (events) => hasStage(events, marker, "complete"),
    `${marker} parent completion`,
  );
  await harness.waitForScreen(
    (screen) => screen.includes(`Parent settled for ${marker}`),
    `${marker} settled screen`,
  );
}

async function sendMarker(marker: string): Promise<void> {
  harness.sendText(`${marker} Continue the deterministic fixture.`);
  harness.pressEnter();
  await waitForParentSettled(marker);
}

async function runGatedScenario(name: string): Promise<void> {
  const scenario = getScenario(name);
  const toolName = name.includes("workflow")
    ? "workflow"
    : name.includes("isolated")
      ? "subagent_isolated"
      : "subagent_with_context";
  await startScenario(name);
  await harness.waitForProvider(
    (events) => hasStage(events, scenario.child!, "gated"),
    `${name} child gate`,
  );
  expect(harness.currentScreen()).toContain(toolName);
  harness.release(scenario.gate!);
  await harness.waitForProvider(
    (events) => hasStage(events, scenario.child!, "complete"),
    `${name} child completion`,
  );
  await waitForParentSettled(scenario.marker);
  const screen = harness.currentScreen();
  expect(screen).toContain(`Parent settled for ${scenario.marker}`);
  expect(screen).toMatch(new RegExp(scenario.expected, "i"));
  await harness.assertNoNetwork();
}

function childPane() {
  return harness
    .panes()
    .find(
      (pane) =>
        pane.id !== harness.parentPane && pane.session.startsWith("e2e-"),
    );
}

async function openSupervisor(): Promise<void> {
  harness.sendText("/subagents");
  harness.pressEnter();
  await harness.waitForScreen(
    (screen) => screen.includes("Async Subagents"),
    "supervisor overlay",
  );
}

async function closeSupervisor(key = "q"): Promise<void> {
  harness.sendKey(key);
  await harness.waitForScreen(
    (screen) => !screen.includes("Async Subagents"),
    "supervisor close",
  );
}

function assertCompletionSnapshot(
  event: Record<string, unknown>,
  marker: string,
  expectedSource?: string,
) {
  const output = event.output as Record<string, unknown> | undefined;
  const eventsPath = String(event.path);
  expect(output).toBeDefined();
  const snapshotPath = resolve(dirname(eventsPath), String(output?.path));
  const content = readFileSync(snapshotPath, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  expect(content).toContain(marker);
  expect(output?.sha256).toBe(sha256);
  if (expectedSource) expect(event.source).toBe(expectedSource);
}

describe("real Pi terminal E2E", () => {
  it(
    "starts a real Pi editor in the isolated PTY",
    async () => {
      await harness.start();
      expect(harness.currentScreen()).toMatch(/›|>|Pi|pi/i);
      expect(harness.panes()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ session: expect.stringMatching(/^e2e-/) }),
        ]),
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "renders a synchronous context sub-agent through a gated child",
    async () => {
      await runGatedScenario("sync-context");
      const childEvent = harness
        .providerEvents()
        .find((event) => event.marker === "[E2E:CHILD_SYNC_CONTEXT]");
      expect(childEvent?.contextMarkers).toContain("[E2E:SYNC_CONTEXT]");
      expect(childEvent?.contextHasParentSentinel).toBe(true);
      expect(childEvent?.contextRoles).toContain("user");
      expect(childEvent?.contextMessageCount).toBe(1);
      expect(childEvent?.contextToolNames).toEqual([
        "read",
        "bash",
        "edit",
        "write",
      ]);
    },
    timeout,
  );

  it(
    "renders a synchronous isolated sub-agent without parent context",
    async () => {
      await runGatedScenario("sync-isolated");
      const childEvent = harness
        .providerEvents()
        .find((event) => event.marker === "[E2E:CHILD_SYNC_ISOLATED]");
      expect(childEvent?.contextMarkers).not.toContain("[E2E:SYNC_ISOLATED]");
      expect(childEvent?.contextHasParentSentinel).toBe(false);
      expect(childEvent?.contextRoles).toEqual(["user"]);
      expect(childEvent?.contextMessageCount).toBe(1);
      expect(childEvent?.contextToolNames).toEqual([
        "read",
        "bash",
        "edit",
        "write",
      ]);
    },
    timeout,
  );

  it(
    "inspects and retrieves an async isolated child without a triggering turn",
    async () => {
      const scenario = getScenario("async-isolated");
      await startScenario("async-isolated");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "async child gate",
      );
      await waitForParentSettled(scenario.marker);
      expect(harness.currentScreen()).toMatch(/started|working|subagent/i);

      await sendMarker("[E2E:ASYNC_STATUS]");
      expect(harness.currentScreen()).toMatch(/running|status|Parent settled/i);
      const parentCallsBeforeRelease = harness
        .providerEvents()
        .filter((event) => event.marker === scenario.marker).length;

      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "complete"),
        "async completion",
      );
      await harness.waitForScreen(
        (screen) => /completion|completed|sub-agent/i.test(screen),
        "async completion notification",
      );
      expect(
        harness
          .providerEvents()
          .filter((event) => event.marker === scenario.marker),
      ).toHaveLength(parentCallsBeforeRelease);

      await sendMarker("[E2E:ASYNC_RESULT]");
      expect(harness.currentScreen()).toMatch(/result|Parent settled/i);
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "renders an in-process workflow phase and completion",
    async () => {
      await runGatedScenario("workflow");
      expect(harness.currentScreen()).toMatch(/Workflow|phase|done/i);
    },
    timeout,
  );

  it(
    "runs a background workflow with status, result, and one trigger follow-up",
    async () => {
      const scenario = getScenario("background-workflow");
      await startScenario("background-workflow");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "background workflow child gate",
      );
      await waitForParentSettled(scenario.marker);
      await sendMarker("[E2E:WORKFLOW_STATUS]");

      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "complete"),
        "background workflow child completion",
      );
      await harness.waitForProvider(
        (events) =>
          events.filter(
            (event) =>
              event.marker === scenario.marker &&
              event.route === "trigger-followup",
          ).length === 1,
        "background workflow trigger follow-up",
        20_000,
      );
      await harness.waitForScreen(
        (screen) => screen.includes("Workflow follow-up settled"),
        "background workflow settled screen",
      );
      await sendMarker("[E2E:WORKFLOW_RESULT]");
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "runs a process-isolated workflow in a retained tmux pane",
    async () => {
      await runGatedScenario("process-workflow");
      const pane = childPane();
      expect(pane).toBeDefined();
      expect(
        harness
          .currentScreen(pane?.id)
          .includes("Child result for [E2E:CHILD_WORKFLOW_PROCESS]"),
      ).toBe(true);
      expect(
        harness.panes().some((candidate) => candidate.id === pane?.id),
      ).toBe(true);
      expect(
        harness
          .providerEvents()
          .some(
            (event) =>
              event.marker === "[E2E:CHILD_WORKFLOW_PROCESS]" &&
              event.afterStage === "complete",
          ),
      ).toBe(true);
    },
    timeout,
  );

  it(
    "renders a workflow partial failure without losing successful progress",
    async () => {
      const scenario = getScenario("workflow-partial");
      await startScenario("workflow-partial");
      await harness.waitForProvider(
        (events) => hasStage(events, "[E2E:CHILD_WORKFLOW_OK]", "gated"),
        "partial workflow success gate",
      );
      await harness.waitForProvider(
        (events) => hasStage(events, "[E2E:CHILD_WORKFLOW_ERROR]", "failed"),
        "partial workflow deterministic failure",
      );
      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, "[E2E:CHILD_WORKFLOW_OK]", "complete"),
        "partial workflow successful child",
      );
      await waitForParentSettled(scenario.marker);
      expect(harness.currentScreen()).toMatch(/Workflow|error|partial/i);
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "keeps one interactive child pane for a distinct follow-up turn",
    async () => {
      const scenario = getScenario("interactive");
      await startScenario("interactive");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "interactive child gate",
      );
      await waitForParentSettled(scenario.marker);
      const pane = childPane();
      expect(pane).toBeDefined();

      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "complete"),
        "interactive completion",
      );
      await harness.waitFor(
        () =>
          harness
            .currentScreen(pane?.id)
            .includes("Interactive child complete"),
        "interactive child idle pane",
      );
      await harness.waitForScreen(
        (screen) => screen.includes("Completion output was not injected"),
        "interactive parent notification",
        20_000,
      );

      const firstCompletions = harness
        .artifactEvents()
        .filter((event) => event.type === "completion");
      expect(firstCompletions).toHaveLength(1);

      harness.sendText(
        "[E2E:INTERACTIVE_FOLLOWUP_PARENT] Send the deterministic follow-up.",
      );
      harness.pressEnter();
      await harness.waitForProvider(
        (events) =>
          hasStage(events, "[E2E:CHILD_INTERACTIVE_FOLLOWUP]", "gated"),
        "interactive follow-up gate",
      );
      harness.release("release-interactive-followup");
      await harness.waitForProvider(
        (events) =>
          hasStage(events, "[E2E:CHILD_INTERACTIVE_FOLLOWUP]", "complete"),
        "interactive follow-up completion",
      );
      await harness.waitFor(
        () =>
          harness
            .currentScreen(pane?.id)
            .includes("[E2E:INTERACTIVE_OUTPUT_2]"),
        "interactive follow-up pane output",
      );

      const completions = harness
        .artifactEvents()
        .filter((event) => event.type === "completion");
      expect(completions).toHaveLength(2);
      expect(new Set(completions.map((event) => event.turnId)).size).toBe(2);
      assertCompletionSnapshot(
        completions[0],
        "[E2E:INTERACTIVE_OUTPUT_1]",
        "explicit",
      );
      assertCompletionSnapshot(
        completions[1],
        "[E2E:INTERACTIVE_OUTPUT_2]",
        "explicit",
      );
      const artifactDir = dirname(String(completions[0].path));
      const sessionRoot = resolve(artifactDir, "../..");
      expect(existsSync(resolve(artifactDir, "output.md"))).toBe(true);
      expect(
        readdirSync(sessionRoot).some((name) => name.endsWith(".jsonl")),
      ).toBe(true);
      expect(
        harness.panes().some((candidate) => candidate.id === pane?.id),
      ).toBe(true);
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "retains an interactive artifact after a child provider failure",
    async () => {
      const scenario = getScenario("interactive-error");
      await startScenario("interactive-error");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "failed"),
        "interactive child provider failure",
      );
      await waitForParentSettled(scenario.marker);
      const pane = childPane();
      expect(pane).toBeDefined();
      await harness.waitFor(
        () =>
          harness
            .artifactEvents()
            .some(
              (event) =>
                event.type === "completion" && event.outcome === "error",
            ),
        "interactive error artifact",
        20_000,
      );
      const completion = harness
        .artifactEvents()
        .find(
          (event) => event.type === "completion" && event.outcome === "error",
        );
      expect(completion?.source).toBe("agent_settled");
      const output = completion?.output as Record<string, unknown> | undefined;
      expect(output?.bytes).toBe(0);
      expect(existsSync(resolve(String(output?.path)))).toBe(true);
      expect(harness.currentScreen(pane?.id)).toMatch(/error|failed/i);
      expect(
        harness.panes().some((candidate) => candidate.id === pane?.id),
      ).toBe(true);
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "cancels an interactive pane while retaining its artifact completion",
    async () => {
      const scenario = getScenario("interactive");
      await startScenario("interactive");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "interactive cancellation gate",
      );
      await waitForParentSettled(scenario.marker);
      const pane = childPane();
      expect(pane).toBeDefined();

      harness.sendText(
        "[E2E:INTERACTIVE_CANCEL_PARENT] Cancel the interactive fixture.",
      );
      harness.pressEnter();
      await waitForParentSettled("[E2E:INTERACTIVE_CANCEL_PARENT]");
      await harness.waitFor(
        () => !harness.panes().some((candidate) => candidate.id === pane?.id),
        "interactive pane cancellation",
      );
      await harness.waitFor(
        () =>
          harness
            .artifactEvents()
            .some(
              (event) =>
                event.type === "completion" && event.outcome === "cancelled",
            ),
        "retained interactive cancellation artifact",
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "navigates the supervisor and cancels its selected async child",
    async () => {
      const scenario = getScenario("async-isolated");
      await startScenario("async-isolated");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "supervisor fixture gate",
      );
      await waitForParentSettled(scenario.marker);

      await openSupervisor();
      expect(harness.currentScreen()).toMatch(/\[in-process\].*running/i);
      await closeSupervisor();

      if (
        harness.version.major > 3 ||
        (harness.version.major === 3 && harness.version.minor >= 5)
      ) {
        harness.sendKey("C-M-a");
        await harness.waitForScreen(
          (screen) => screen.includes("Async Subagents"),
          "supervisor shortcut overlay",
        );
        await closeSupervisor();
      }

      const workflow = getScenario("background-workflow");
      harness.sendText(workflow.prompt);
      harness.pressEnter();
      await harness.waitForProvider(
        (events) => hasStage(events, workflow.child!, "gated"),
        "supervisor workflow gate",
      );
      await waitForParentSettled(workflow.marker);

      await openSupervisor();
      expect(harness.currentScreen()).toMatch(/\[workflow\].*running/i);
      harness.sendKey("Enter");
      await harness.waitForScreen(
        (screen) => screen.includes("Model: subagentura-e2e/mock"),
        "expanded in-process details",
      );
      harness.sendKey("j");
      harness.sendKey("Enter");
      await harness.waitForScreen(
        (screen) =>
          screen.includes("Workflow: e2e-workflow") &&
          screen.includes("Agents:"),
        "expanded workflow details after navigation",
      );
      harness.sendKey("k");
      harness.sendKey("x");
      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.child &&
              event.afterStage === "failed" &&
              event.abort === true,
          ),
        "supervisor cancellation",
      );
      await closeSupervisor("Escape");
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "cancels a synchronous child through the real TUI escape path",
    async () => {
      const scenario = getScenario("sync-context");
      await startScenario("sync-context");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "synchronous cancellation gate",
      );
      harness.sendKey("Escape");
      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.child &&
              event.afterStage === "failed" &&
              event.abort === true,
          ),
        "synchronous child abort",
      );
      await harness.waitForScreen(
        (screen) => screen.includes("Parent settled for [E2E:SYNC_CONTEXT]"),
        "parent idle after synchronous cancellation",
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "renders a provider error as a terminal screen state",
    async () => {
      await startScenario("error");
      await harness.waitForProvider(
        (events) => hasStage(events, "[E2E:ERROR]", "failed"),
        "provider error",
      );
      expect(harness.currentScreen()).toMatch(/error|failed|❌/i);
      await harness.assertNoNetwork();
    },
    timeout,
  );
});
