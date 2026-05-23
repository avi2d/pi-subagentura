import { Type } from 'typebox';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { SOCKET_DIR, SOCKET_DIR_MODE } from '../rpc/types.js';

const execAsync = promisify(exec);

export const SpawnTmuxParams = Type.Object({
  task: Type.String({ description: "Task for the sub-agent" }),
  persona: Type.Optional(Type.String({ description: "Optional system prompt/persona" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  sessionName: Type.Optional(Type.String({ description: "Custom tmux session name" })),
});

export async function spawnTmuxSubagent(params: {
  task: string;
  persona?: string;
  cwd?: string;
  sessionName?: string;
}): Promise<{
  sessionId: string;
  windowName: string;
  attachCommand: string;
  message: string;
}> {
  // Validate tmux is available
  try {
    await execAsync('tmux -V');
  } catch {
    throw new Error('tmux is not installed. Install: macOS: brew install tmux | Ubuntu: sudo apt-get install tmux');
  }

  // Generate session name
  const baseName = params.sessionName || 'pi-tabs';
  const timestamp = Date.now().toString(36);
  const sessionId = `${baseName}:${timestamp}`;
  const windowName = `${baseName}:${timestamp}`;

  // Ensure socket directory exists (for potential future RPC use)
  await fs.promises.mkdir(SOCKET_DIR, { mode: SOCKET_DIR_MODE, recursive: true });

  // Build the pi command with task and optional persona
  const cwd = params.cwd || process.cwd();
  const piCommand = buildPiCommand(params.task, params.persona);

  // Create tmux session - TERM=xterm is needed in non-interactive contexts
  const createSessionCmd = `tmux new-session -d -s "${sessionId}" -n "${windowName}" "TERM=xterm ${piCommand}"`;

  console.error(`[spawn-tmux] Creating session: ${sessionId}`);
  console.error(`[spawn-tmux] Command: ${createSessionCmd}`);

  try {
    await execAsync(createSessionCmd);
  } catch (err) {
    throw new Error(`Failed to create tmux session: ${err}`);
  }

  // Verify session exists
  try {
    await execAsync(`tmux has-session -t "${sessionId}"`);
  } catch {
    throw new Error(`Session ${sessionId} was not created`);
  }

  const attachCommand = `tmux attach -t "${sessionId}"`;
  const killCommand = `tmux kill-session -t "${sessionId}"`;

  return {
    sessionId,
    windowName,
    attachCommand,
    message: `Subagent started in tmux session '${sessionId}'\n` +
             `Attach to interact: ${attachCommand}\n` +
             `Kill when done: ${killCommand}`,
  };
}

function buildPiCommand(task: string, persona?: string): string {
  const parts: string[] = ['pi'];

  if (persona) {
    // Escape the persona string for shell
    const escapedPersona = persona.replace(/'/g, "'\\''");
    parts.push(`--persona '${escapedPersona}'`);
  }

  // Escape task for shell
  const escapedTask = task.replace(/'/g, "'\\''");
  parts.push(`'${escapedTask}'`);

  return parts.join(' ');
}

// Kill a tmux subagent by session name
export const KillTmuxParams = Type.Object({
  sessionId: Type.String({ description: "The tmux session ID to kill (e.g., 'pi-subagent:abc123')" }),
});

export async function killTmuxSubagent(params: {
  sessionId: string;
}): Promise<{ killed: boolean; sessionId: string }> {
  try {
    await execAsync(`tmux kill-session -t "${params.sessionId}"`);
    return { killed: true, sessionId: params.sessionId };
  } catch {
    return { killed: false, sessionId: params.sessionId };
  }
}

// List running tmux subagents
export function listTmuxSubagents(): {
  sessions: Array<{
    sessionId: string;
    windows: number;
    created: string;
  }>;
} {
  // Get list of all tmux sessions
  // This is a simplified implementation
  return { sessions: [] };
}
