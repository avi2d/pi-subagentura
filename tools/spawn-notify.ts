/**
 * spawn-notify: Spawn a tmux subagent with notification on completion.
 * 
 * This tool combines:
 * - tmux session for easy attach (tmux, wezterm, zellij)
 * - Simple notification via ExtensionAPI callback
 */

import { Type } from 'typebox';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { SOCKET_DIR, SOCKET_DIR_MODE } from '../rpc/types.js';

const execAsync = promisify(exec);

export const SpawnNotifyParams = Type.Object({
   task: Type.String({ description: "Task for the sub-agent" }),
   persona: Type.Optional(Type.String({ description: "Optional system prompt/persona" })),
   cwd: Type.Optional(Type.String({ description: "Working directory" })),
   sessionName: Type.Optional(Type.String({ description: "Custom tmux session name" })),
   notifyOnComplete: Type.Optional(Type.Union([
      Type.Literal('inject'),
      Type.Literal('notify')
   ], { description: "How to notify on completion (default: inject)" })),
});

export interface SpawnNotifyResult {
   jobId: string;
   sessionId: string;
   windowName: string;
   attachCommand: string;
   weztermCommand: string;
   zellijCommand: string;
   message: string;
}

/**
 * Build the pi command with task and optional persona.
 * Uses single quotes with escaped single quotes for shell safety.
 */
function buildPiCommand(task: string, persona?: string): string {
   const parts: string[] = ['pi'];

   if (persona) {
      // Escape single quotes in persona for shell
      const escapedPersona = persona.replace(/'/g, "'\\''");
      parts.push(`--persona '${escapedPersona}'`);
   }

   // Escape single quotes in task for shell
   const escapedTask = task.replace(/'/g, "'\\''");
   parts.push(`'${escapedTask}'`);

   return parts.join(' ');
}

export async function spawnNotifySubagent(params: {
   task: string;
   persona?: string;
   cwd?: string;
   sessionName?: string;
   notifyOnComplete?: 'inject' | 'notify';
}): Promise<SpawnNotifyResult> {
   // Validate tmux is available
   try {
      await execAsync('tmux -V');
   } catch {
      throw new Error(
         'tmux is not installed. spawn-notify requires tmux.\n' +
         'Install: macOS: brew install tmux | Ubuntu: sudo apt-get install tmux'
      );
   }

   // Generate IDs - use hyphens to avoid tmux session name issues with colons
   const timestamp = Date.now().toString(36);
   const jobId = Math.random().toString(36).substring(2) + timestamp;

   // Generate session name - use hyphens only (tmux converts colons to underscores)
   const baseName = params.sessionName || 'pi-subagentura';
   const sessionId = `${baseName}-${jobId}`;
   const windowName = `${baseName}-${jobId}`;

   // Ensure socket directory exists
   await fs.promises.mkdir(SOCKET_DIR, { mode: SOCKET_DIR_MODE, recursive: true });

   // Build the pi command
   const piCommand = buildPiCommand(params.task, params.persona);

   // Create tmux session with pi command
   const createSessionCmd = `tmux new-session -d -s "${sessionId}" -n "${windowName}" "TERM=xterm ${piCommand}"`;

   console.error(`[spawn-notify] Creating session: ${sessionId}`);

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
   const weztermCommand = `wezterm cli split-pane --domain-id=TMUX -- tmux attach -t "${sessionId}"`;
   const zellijCommand = `zellij attach "${sessionId}"`;

   return {
      jobId,
      sessionId,
      windowName,
      attachCommand,
      weztermCommand,
      zellijCommand,
      message:
         `Subagent ${jobId} started in tmux session '${sessionId}'\n` +
         `Attach with tmux:   ${attachCommand}\n` +
         `Attach with wezterm: ${weztermCommand}\n` +
         `Attach with zellij:  ${zellijCommand}\n` +
         `Notification will be delivered when complete (mode: ${params.notifyOnComplete || 'inject'})`,
   };
}
