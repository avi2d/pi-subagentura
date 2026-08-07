import { describe, expect, it } from "vitest";
import { createWorkflowOwnerIdentity } from "../src/workflow-owner";

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
});
