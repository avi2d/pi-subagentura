import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowProcessLaunchIntent,
  persistWorkflowProcessLaunchIntent,
  persistWorkflowProcessLaunchDispatch,
  readWorkflowProcessLaunchIntent,
  validateWorkflowProcessChildStarted,
} from "../src/workflow-process-handshake";

describe("workflow process launch intents", () => {
  it("persists before dispatch with durable identity fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-launch-"));
    const intent = createWorkflowProcessLaunchIntent({
      runId: "run-1",
      operationId: "op-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      epoch: 3,
    });
    const path = await persistWorkflowProcessLaunchIntent(root, intent);
    const loaded = await readWorkflowProcessLaunchIntent(path);
    expect(loaded).toEqual(intent);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain(intent.launchMarker);
  });

  it("rejects duplicate persistence for one attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-launch-"));
    const intent = createWorkflowProcessLaunchIntent({
      runId: "run-1",
      operationId: "op-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      epoch: 1,
    });
    await persistWorkflowProcessLaunchIntent(root, intent);
    await expect(
      persistWorkflowProcessLaunchIntent(root, intent),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects invalid identity and epoch inputs", () => {
    expect(() =>
      createWorkflowProcessLaunchIntent({
        runId: "../escape",
        operationId: "op-1",
        attemptId: "attempt-1",
        attemptNumber: 1,
        epoch: 1,
      }),
    ).toThrow("Invalid workflow process runId");
    expect(() =>
      createWorkflowProcessLaunchIntent({
        runId: "run-1",
        operationId: "op-1",
        attemptId: "attempt-1",
        attemptNumber: 0,
        epoch: 1,
      }),
    ).toThrow("attempt number");
  });

  it("persists dispatch and fences stale child evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-launch-"));
    const intent = createWorkflowProcessLaunchIntent({
      runId: "run-1",
      operationId: "op-1",
      attemptId: "attempt-1",
      attemptNumber: 1,
      epoch: 4,
    });
    const dispatchPath = await persistWorkflowProcessLaunchDispatch(
      root,
      intent,
    );
    expect(await readFile(dispatchPath, "utf8")).toContain(intent.nonce);
    validateWorkflowProcessChildStarted(intent, {
      schemaVersion: 1,
      launchMarker: intent.launchMarker,
      nonce: intent.nonce,
      attemptId: intent.attemptId,
      epoch: intent.epoch,
    });
    expect(() =>
      validateWorkflowProcessChildStarted(intent, {
        schemaVersion: 1,
        launchMarker: intent.launchMarker,
        nonce: "stale-nonce",
        attemptId: intent.attemptId,
        epoch: intent.epoch,
      }),
    ).toThrow("Stale workflow process child evidence");
  });
});
