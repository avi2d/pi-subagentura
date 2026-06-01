/**
 * Tmux Child Mode - Runs in subagent pi processes spawned via tmux
 *
 * When PI_SUBAGENT=1 is set, this module activates child-mode behavior:
 * - Writes activity updates to shared file (throttled)
 * - Writes exit sidecar on session_shutdown (not agent_end)
 * - Auto-exits when agent ends
 *
 * This is integrated into the main extension and activates based on
 * environment variables.
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { writeTmuxActivity, flushPendingActivity, writeExitSidecar } from './tmux-session';

interface TmuxChildConfig {
  sessionDir: string;
  jobId: string;
  contextMode: 'isolated' | 'with_context';
}

// Environment variables (set by parent spawner)
const IS_CHILD = process.env.PI_SUBAGENT === '1';
const SESSION_DIR = process.env.PI_SUBAGENT_SESSION_DIR || '/tmp/pi-subagents';
const JOB_ID = process.env.PI_SUBAGENT_ID || 'unknown';
const CONTEXT_MODE = (process.env.PI_SUBAGENT_CONTEXT_MODE || 'isolated') as 'isolated' | 'with_context';

/**
 * Check if we're running in tmux child mode
 */
export function isTmuxChildMode(): boolean {
  return IS_CHILD;
}

/**
 * Get child mode config from environment
 */
export function getTmuxChildConfig(): TmuxChildConfig | null {
  if (!IS_CHILD) return null;
  return {
    sessionDir: SESSION_DIR,
    jobId: JOB_ID,
    contextMode: CONTEXT_MODE,
  };
}

let sessionOutput = '';

/**
 * Record output for final extraction
 */
function recordOutput(text: string): void {
  sessionOutput += text;
  // Also write to output file for legacy support
  try {
    const outputFile = `${SESSION_DIR}/output.txt`;
    require('node:fs').writeFileSync(outputFile, sessionOutput);
  } catch {
    // Ignore
  }
}

/**
 * Activate tmux child mode - registers event handlers
 */
export function activateTmuxChildMode(pi: ExtensionAPI): void {
  if (!IS_CHILD) return;

  // Initial activity
  writeTmuxActivity(SESSION_DIR, {
    runningChildId: JOB_ID,
    phase: 'starting',
    activeScope: 'idle',
    latestEvent: 'extension_loaded',
  });

  let agentStarted = false;

  // Session events - wire up activity tracking
  pi.on('session_start', () => {
    writeTmuxActivity(SESSION_DIR, {
      phase: 'starting',
      activeScope: 'idle',
      latestEvent: 'session_start',
    });
  });

  pi.on('input', () => {
    writeTmuxActivity(SESSION_DIR, {
      latestEvent: 'input',
      activeScope: 'prompt',
    });
  });

  pi.on('before_agent_start', () => {
    writeTmuxActivity(SESSION_DIR, {
      phase: 'active',
      activeScope: 'prompt',
      latestEvent: 'before_agent_start',
    });
  });

  pi.on('agent_start', () => {
    agentStarted = true;
    writeTmuxActivity(SESSION_DIR, {
      phase: 'active',
      activeScope: 'prompt',
      latestEvent: 'agent_start',
    });
  });

  /**
   * Option 2: Write exit file at session_shutdown, NOT at agent_end
   * 
   * agent_end fires after each turn (toolUse, stop, error, etc.)
   * session_shutdown fires when ctx.shutdown() is called - the true end
   * 
   * This handles the edge case:
   * - Subagent aborted (ctx.abort()) → agent_end fires (stopReason = "aborted")
   * - Parent injects continue message
   * - Subagent continues...
   * - Eventually natural completion → ctx.shutdown() called
   * - session_shutdown fires → exit file written with final result ✓
   */
  pi.on('agent_end', (event: any, ctx: ExtensionContext) => {
    // Track activity only - DO NOT write exit file here
    writeTmuxActivity(SESSION_DIR, {
      phase: 'active',
      activeScope: 'idle',
      latestEvent: 'agent_end',
    });

    // Shutdown the session - this triggers session_shutdown where exit file is written
    ctx.shutdown();
  });

  pi.on('turn_start', (event: any) => {
    writeTmuxActivity(SESSION_DIR, {
      phase: 'active',
      activeScope: 'prompt',
      latestEvent: 'turn_start',
      turn: event?.turnIndex,
    });
  });

  pi.on('turn_end', (event: any) => {
    writeTmuxActivity(SESSION_DIR, {
      phase: 'active',
      activeScope: 'idle',
      latestEvent: 'turn_end',
      turn: event?.turnIndex,
    });
  });

  pi.on('message_update', (event: any) => {
    const msgEvent = event?.assistantMessageEvent;
    if (msgEvent?.type === 'text_delta') {
      recordOutput(msgEvent.delta || '');
      writeTmuxActivity(SESSION_DIR, {
        phase: 'active',
        activeScope: 'output',
        latestEvent: 'text_delta',
      });
    } else if (msgEvent?.type === 'thinking_delta') {
      writeTmuxActivity(SESSION_DIR, {
        phase: 'active',
        activeScope: 'thinking',
        latestEvent: 'thinking_delta',
      });
    }
  });

  pi.on('tool_execution_start', (event: any) => {
    writeTmuxActivity(SESSION_DIR, {
      phase: 'active',
      activeScope: 'tool',
      toolName: event?.toolName,
      latestEvent: 'tool_execution_start',
    });
  });

  pi.on('tool_execution_end', (event: any) => {
    writeTmuxActivity(SESSION_DIR, {
      phase: 'active',
      activeScope: 'idle',
      latestEvent: 'tool_execution_end',
    });
  });

  /**
   * Session shutdown handler - THIS is where we write the exit file
   * 
   * This is the TRUE end of the session, called after ctx.shutdown()
   * Exit file is written here, not at agent_end
   */
  pi.on('session_shutdown', () => {
    // Extract final output from sessionOutput
    const finalOutput = sessionOutput || '(no output)';

    // Write exit sidecar with final result
    writeExitSidecar(SESSION_DIR, 'done', { output: finalOutput });

    // Flush pending activity
    flushPendingActivity(SESSION_DIR);
    writeTmuxActivity(SESSION_DIR, {
      phase: 'done',
      activeScope: 'idle',
      latestEvent: 'session_shutdown',
    });
  });
}
