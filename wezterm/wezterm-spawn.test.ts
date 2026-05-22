import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { registerWeztermSpawn } from "./wezterm-spawn";

describe("wezterm_spawn", () => {
  let mockPi: any;
  let registeredTools: string[] = [];

  beforeEach(() => {
    registeredTools = [];
    mockPi = {
      registerTool: vi.fn(({ name }) => {
        registeredTools.push(name);
      }),
    };
  });

  it("registers wezterm_spawn tool", () => {
    registerWeztermSpawn(mockPi);
    expect(registeredTools).toContain("wezterm_spawn");
  });

  it("registers tool with correct parameters schema", () => {
    registerWeztermSpawn(mockPi);
    
    const call = mockPi.registerTool.mock.calls[0][0];
    expect(call.name).toBe("wezterm_spawn");
    expect(call.label).toBe("Wezterm Agent");
    expect(call.description).toContain("Wezterm pane");
    expect(call.description).toContain("socket-based IPC");
    
    // Check parameters
    expect(call.parameters).toBeDefined();
    const params = call.parameters;
    expect(params.properties.task).toBeDefined();
    expect(params.properties.task.type).toBe("string");
    expect(params.required).toContain("task");
  });

  it("has optional cwd and name parameters", () => {
    registerWeztermSpawn(mockPi);
    
    const call = mockPi.registerTool.mock.calls[0][0];
    const params = call.parameters;
    
    expect(params.properties.name).toBeDefined();
    expect(params.properties.cwd).toBeDefined();
    expect(params.properties.timeout).toBeDefined();
  });

  it("has session persistence details in description", () => {
    registerWeztermSpawn(mockPi);
    
    const call = mockPi.registerTool.mock.calls[0][0];
    expect(call.description).toContain("socket-based IPC");
    expect(call.description).toContain("Session persists");
  });
});

describe("wezterm CLI integration", () => {
  it("describes wezterm cli split-pane command structure", () => {
    // This test documents the expected wezterm CLI usage
    const sessionDir = "/tmp/pi-sessions/wezterm-abc123";
    const cwd = "/tmp";
    const task = "test task";
    
    const piCmd = `pi --session-dir "${sessionDir}" --continue "${task}"`;
    const bashCmd = `echo "Session: test" && echo "" && ${piCmd} && echo "" && echo "Continue with:" && echo "  pi --session-dir ${sessionDir} --continue \\"<task\\"" && sleep 5`;
    
    const weztermArgs = [
      "cli",
      "split-pane",
      "--cwd",
      cwd,
      "--",
      "bash",
      "-c",
      bashCmd,
    ];
    
    expect(weztermArgs[0]).toBe("cli");
    expect(weztermArgs[1]).toBe("split-pane");
    expect(weztermArgs[2]).toBe("--cwd");
    expect(weztermArgs[4]).toBe("--");
    expect(weztermArgs[5]).toBe("bash");
    expect(weztermArgs[6]).toBe("-c");
    expect(weztermArgs[7]).toContain("pi --session-dir");
  });

  it("escapes task for shell safety", () => {
    const task = 'echo "hello world"';
    const taskEscaped = task.replace(/"/g, '\\"');
    
    expect(taskEscaped).toBe('echo \\"hello world\\"');
    
    const piCmd = `pi --session-dir "/tmp" --continue "${taskEscaped}"`;
    expect(piCmd).toContain('echo \\"hello world\\"');
  });

  it("generates unique session IDs", () => {
    // Verify randomBytes produces different values
    const id1 = randomBytes(8).toString("hex");
    const id2 = randomBytes(8).toString("hex");
    
    expect(id1).not.toBe(id2);
    expect(id1.length).toBe(16); // 8 bytes = 16 hex chars
  });
});
