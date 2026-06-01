/**
 * Tmux Child Mode - Runs in subagent pi processes spawned via tmux
 *
 * When PI_SUBAGENT=1 is set, this module activates child-mode behavior:
 * - Writes a rich per-job activity snapshot (subagent-activity/<id>.json) so
 *   the parent can drive the widget status state machine (active/waiting/stalled).
 * - Writes the legacy exit sidecar on session_shutdown (not agent_end).
 * - Auto-exits when the agent ends.
 *
 * The activity file is written by `createSubagentActivityRecorder` (activity.ts).
 * The exit sidecar still uses `writeExitSidecar` from tmux-session.ts for the
 * parent's existing job-completion polling flow.
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { writeExitSidecar, getSubagentActivityFilePath } from './tmux-session';
import { createSubagentActivityRecorder, type SubagentActivityRecorder } from './activity';

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

// Accumulated assistant text for the final exit sidecar. We deliberately do NOT
// persist this to a file on every text_delta (would be sync I/O on the TUI hot path);
// the value is small and only read once at session_shutdown.
let sessionOutput = '';

/**
 * Activate tmux child mode - registers event handlers
 */
export function activateTmuxChildMode(pi: ExtensionAPI): void {
	if (!IS_CHILD) return;

	// Create the per-job activity recorder (atomic write, throttled, 3-failure
	// disable). All subsequent handlers use this instead of writeTmuxActivity.
	const recorder: SubagentActivityRecorder = createSubagentActivityRecorder({
		runningChildId: JOB_ID,
		activityFile: getSubagentActivityFilePath(SESSION_DIR, JOB_ID),
	});

	// Mark the session as started
	recorder.sessionStart();

	let agentStarted = false;

	// Session events - wire up activity tracking
	pi.on('session_start', () => {
		recorder.sessionStart();
	});

	pi.on('input', () => {
		recorder.input();
	});

	pi.on('before_agent_start', () => {
		recorder.beforeAgentStart();
	});

	pi.on('agent_start', () => {
		agentStarted = true;
		recorder.agentStart();
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
		// agent_end semantics:
		//   - If we never produced any output (turns === 0) → treat as done, recorder disabled
		//   - Otherwise → mark as "waiting" for further input (parent may continue us)
		// We use `agentStarted` as a proxy: if the agent never started, the turn never ran
		// and we're not in a state where anyone will send us more input.
		if (!agentStarted) {
			recorder.agentEndDone();
		} else {
			recorder.agentEndWaiting();
		}

		// Shutdown the session - this triggers session_shutdown where exit file is written
		ctx.shutdown();
	});

	pi.on('turn_start', (event: any) => {
		recorder.turnStart(event?.turnIndex);
	});

	pi.on('turn_end', (event: any) => {
		recorder.turnEnd(event?.turnIndex);
	});

	pi.on('message_update', (event: any) => {
		const msgEvent = event?.assistantMessageEvent;
		if (msgEvent?.type === 'text_delta') {
			sessionOutput += msgEvent.delta || '';
			recorder.messageUpdate('text_delta');
		} else if (msgEvent?.type === 'thinking_delta') {
			recorder.messageUpdate('thinking_delta');
		} else if (msgEvent?.type === 'toolcall_delta') {
			recorder.messageUpdate('toolcall_delta');
		} else if (msgEvent?.type === 'toolcall_end') {
			recorder.messageUpdate('toolcall_end');
		}
	});

	pi.on('tool_execution_start', (event: any) => {
		recorder.toolExecutionStart(event?.toolCallId, event?.toolName);
	});

	pi.on('tool_execution_update', (event: any) => {
		recorder.toolExecutionUpdate(event?.toolCallId, event?.toolName);
	});

	pi.on('tool_execution_end', (event: any) => {
		recorder.toolExecutionEnd(event?.toolCallId, event?.toolName);
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

		// Mark the activity recorder as done. session_shutdown with "quit" reason
		// is the natural completion path (vs "reload"/"new" which mean the runtime
		// is restarting and the recorder should be disabled, not marked done).
		recorder.sessionShutdown('quit');
	});
}
