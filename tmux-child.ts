/**
 * Tmux Child Mode - Runs in subagent pi processes spawned via tmux
 *
 * When PI_SUBAGENT=1 is set, this module activates child-mode behavior:
 * - Writes activity updates to shared file (throttled)
 * - Writes exit sidecar on agent_end
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

  pi.on('agent_end', (event: any, ctx: ExtensionContext) => {
    const messages = event?.messages as any[] | undefined;

    // Check if this was an error
    let isError = false;
    if (messages) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === 'assistant') {
          isError = msg?.stopReason === 'error';
          break;
        }
      }
    }

    if (isError) {
      let errorMessage = 'Agent ended with error';
      if (messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg?.role === 'assistant' && msg?.errorMessage) {
            errorMessage = msg.errorMessage;
            break;
          }
        }
      }
      writeTmuxActivity(SESSION_DIR, {
        phase: 'error',
        activeScope: 'idle',
        latestEvent: `error: ${errorMessage}`,
      });
      writeExitSidecar(SESSION_DIR, 'error', { errorMessage });
    } else {
      // Clean completion - extract last assistant message as output
      let finalOutput = sessionOutput || '(no output)';
      if (messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg?.role === 'assistant') {
            const content = msg?.content;
            if (typeof content === 'string' && content) {
              finalOutput = content;
            } else if (Array.isArray(content)) {
              const textPart = content.find((c: any) => c?.type === 'text');
              if (textPart?.text) {
                finalOutput = textPart.text;
              }
            }
            break;
          }
        }
      }

      writeTmuxActivity(SESSION_DIR, {
        phase: 'done',
        activeScope: 'idle',
        latestEvent: 'agent_end',
        outputLength: finalOutput.length,
      });
      writeExitSidecar(SESSION_DIR, 'done', { output: finalOutput });
    }

    // Shutdown the session
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

  // Session shutdown handler
  pi.on('session_shutdown', () => {
    flushPendingActivity(SESSION_DIR);
    writeTmuxActivity(SESSION_DIR, {
      phase: 'done',
      activeScope: 'idle',
      latestEvent: 'session_shutdown',
    });
  });
}
