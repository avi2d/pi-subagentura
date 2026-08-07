import { describe, expect, it } from "vitest";
import {
  createDurableWorkflowController,
  createWorkflowOwnerIdentity,
  createWorkflowRunStore,
  durableWorkflowControllerForSession,
  workflowOwnerFromSessionContext,
} from "../src/workflow-owner";

describe("workflow owner identity", () => {
  it("constructs the complete durable fence", () => {
    expect(
      createWorkflowOwnerIdentity({
        projectKey: "project",
        cwd: "/repo",
        piSessionId: "session",
        ownerId: "owner",
        ownerGeneration: 2,
        leaseToken: "lease",
      }),
    ).toMatchObject({ projectKey: "project", ownerGeneration: 2 });
  });

  it("rejects incomplete or unsafe identity fields", () => {
    expect(() =>
      createWorkflowOwnerIdentity({
        projectKey: "",
        cwd: "/repo",
        piSessionId: "session",
        ownerId: "owner",
        ownerGeneration: 0,
        leaseToken: "lease",
      }),
    ).toThrow("projectKey");
    expect(() =>
      createWorkflowOwnerIdentity({
        projectKey: "project",
        cwd: "/repo",
        piSessionId: "session",
        ownerId: "owner",
        ownerGeneration: -1,
        leaseToken: "lease",
      }),
    ).toThrow("generation");
  });

  it("binds a run store to the validated owner", () => {
    const store = createWorkflowRunStore("/tmp/workflows", {
      projectKey: "project",
      cwd: "/repo",
      piSessionId: "session",
      ownerId: "owner",
      ownerGeneration: 0,
      leaseToken: "lease",
    });
    expect(store).toBeDefined();
  });

  it("maps lifecycle naming to the durable owner contract", () => {
    expect(
      workflowOwnerFromSessionContext({
        projectKey: "project",
        cwd: "/repo",
        sessionId: "session",
        ownerId: "owner",
        generation: 3,
        leaseToken: "lease",
      }),
    ).toMatchObject({ piSessionId: "session", ownerGeneration: 3 });
  });

  it("constructs an owner-scoped durable controller", () => {
    expect(
      createDurableWorkflowController("/tmp/workflows", {
        projectKey: "project",
        cwd: "/repo",
        piSessionId: "session",
        ownerId: "owner",
        ownerGeneration: 0,
        leaseToken: "lease",
      }),
    ).toBeDefined();
  });

  it("does not create a controller before a session has an owner", () => {
    expect(
      durableWorkflowControllerForSession("/tmp/workflows", {
        durableWorkflowOwner: undefined,
      } as any),
    ).toBeUndefined();
  });
});
