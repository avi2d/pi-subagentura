import { describe, expect, it, vi } from "vitest";
import registerExtension from "./subagent";

describe("extension registration", () => {
  it("registers all tools without throwing", () => {
    const api = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    expect(() => registerExtension(api as any)).not.toThrow();
    expect(api.registerTool).toHaveBeenCalledTimes(7);
  });
});
