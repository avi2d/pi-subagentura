import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "deadbeef" })),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

describe("tmux-spawn", () => {
  let registerTmuxSpawn: (pi: any) => void;
  let mockPi: any;
  let toolDef: any;

  beforeEach(async () => {
    vi.resetModules();

    // Create a mock socket server
    const mockSocketServer = {
      socketPath: "/tmp/pi-1000/agent-test.sock",
      readyFilePath: "/tmp/pi-1000/.ready",
      close: vi.fn().mockResolvedValue(undefined),
      onMessage: null as any,
    };

    vi.mock("./tmux-agent", () => ({
      createSocketServer: vi.fn().mockResolvedValue(mockSocketServer),
    }));

    // Import registerTmuxSpawn
    const mod = await import("./tmux-spawn");
    registerTmuxSpawn = mod.registerTmuxSpawn;

    // Create mock pi API
    mockPi = {
      registerTool: vi.fn(),
    };

    // Register the tool
    registerTmuxSpawn(mockPi);
    toolDef = mockPi.registerTool.mock.calls[0][0];
  });

  describe("tool registration", () => {
    it("registers tmux_spawn tool with name 'tmux_spawn'", () => {
      expect(mockPi.registerTool).toHaveBeenCalledTimes(1);
      expect(toolDef.name).toBe("tmux_spawn");
    });

    it("registers tmux_spawn tool with label 'Tmux Agent'", () => {
      expect(toolDef.label).toBe("Tmux Agent");
    });

    it("has description mentioning tmux window", () => {
      expect(toolDef.description).toContain("Spawn an agent in a dedicated tmux window");
    });

    it("has parameters with task property", () => {
      const params = toolDef.parameters;
      expect(params.properties.task).toBeDefined();
      expect(params.properties.task.description).toBe("Task for the tmux agent");
    });

    it("has parameters with name, timeout, cwd properties", () => {
      const params = toolDef.parameters;
      expect(params.properties.name).toBeDefined();
      expect(params.properties.timeout).toBeDefined();
      expect(params.properties.cwd).toBeDefined();
    });

    it("has an execute function", () => {
      expect(typeof toolDef.execute).toBe("function");
    });
  });
});

describe("SocketServer onMessage", () => {
  it("createSocketServer is a function", async () => {
    vi.resetModules();
    vi.mock("./tmux-agent", () => ({
      createSocketServer: vi.fn(),
    }));

    const { createSocketServer } = await import("./tmux-agent");
    expect(typeof createSocketServer).toBe("function");
  });
});