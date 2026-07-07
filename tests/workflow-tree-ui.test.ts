import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  showWorkflowTree,
  WorkflowTreeComponent,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow";

function makeJob(overrides: Partial<WorkflowJobState> = {}): WorkflowJobState {
  return {
    id: "wf_test",
    name: "demo-flow",
    status: "running",
    startedAt: 123,
    promise: Promise.resolve({}) as any,
    abort: new AbortController(),
    snapshot: {
      agentsSpawned: 2,
      errorCount: 0,
      tokensSpent: 42,
      phases: ["Scan"],
      currentPhase: "Scan",
      lastMessage: "→ started scout",
      runningCount: 1,
    },
    ...overrides,
  };
}

describe("WorkflowTreeComponent", () => {
  beforeEach(() => {
    workflowJobRegistry.clear();
  });

  it("renders an empty state", () => {
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    const lines = component.render(80);

    expect(lines.join("\n")).toContain("No workflow jobs");
  });

  it("renders workflow summaries and expands details", () => {
    workflowJobRegistry.set("wf_test", makeJob());
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    expect(component.render(100).join("\n")).toContain(
      "demo-flow (wf_test) · [running] · 2 agents · 1 running",
    );

    component.handleInput("\r");
    const expanded = component.render(100).join("\n");
    expect(expanded).toContain("◆ phase: Scan");
    expect(expanded).toContain("→ started scout");
  });

  it("navigates, clamps, and collapses selected workflows", () => {
    workflowJobRegistry.set("wf_a", makeJob({ id: "wf_a", name: "alpha" }));
    workflowJobRegistry.set("wf_b", makeJob({ id: "wf_b", name: "beta" }));
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    component.handleInput("k");
    expect(component.render(100).join("\n")).toContain("▶ ▸ alpha");

    component.handleInput("j");
    expect(component.render(100).join("\n")).toContain("▶ ▸ beta");

    component.handleInput("j");
    expect(component.render(100).join("\n")).toContain("▶ ▸ beta");

    component.handleInput("\r");
    expect(component.render(100).join("\n")).toContain("◆ phase: Scan");

    component.handleInput("\x1b[D");
    expect(component.render(100).join("\n")).not.toContain("◆ phase: Scan");
  });

  it("closes on q or escape", () => {
    const done = vi.fn();
    const component = new WorkflowTreeComponent({ done });

    component.handleInput("q");
    component.handleInput("\x1b");

    expect(done).toHaveBeenCalledWith({ kind: "close" });
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("cancels the selected running workflow with c", () => {
    const job = makeJob();
    const abortSpy = vi.spyOn(job.abort, "abort");
    workflowJobRegistry.set(job.id, job);
    const done = vi.fn();
    const notify = vi.fn();
    const component = new WorkflowTreeComponent({ done, notify });

    component.handleInput("c");

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("cancelled");
    expect(notify).toHaveBeenCalledWith("Cancelled workflow wf_test.");
    expect(done).toHaveBeenCalledWith({
      kind: "cancel",
      workflowId: "wf_test",
    });
  });

  it("does not cancel a terminal workflow", () => {
    const job = makeJob({ status: "done" });
    const abortSpy = vi.spyOn(job.abort, "abort");
    workflowJobRegistry.set(job.id, job);
    const notify = vi.fn();
    const done = vi.fn();
    const component = new WorkflowTreeComponent({ done, notify });

    component.handleInput("c");

    expect(abortSpy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Workflow wf_test is done; nothing to cancel.",
    );
    expect(done).not.toHaveBeenCalled();
  });

  it("falls back when custom UI is unavailable", async () => {
    const notify = vi.fn();
    const result = await showWorkflowTree({ notify } as any);

    expect(result).toEqual({ kind: "close" });
    expect(notify).toHaveBeenCalledWith(
      "Workflow tree UI is not available in this Pi session.",
    );
  });
});
