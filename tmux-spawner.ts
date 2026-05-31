/**
 * Tmux Spawner - Spawn subagents in tmux sessions with activity tracking
 *
 * Coordinates tmux session creation, activity tracking polling,
 * and exit sidecar detection for subagent lifecycle management.
 *
 * Uses a central fs.watch() on BASE_DIR for kernel-level notification
 * when any session's exit sidecar is written.
 */

import { spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  createTmuxSession,
  writeTmuxActivity,
  readTmuxActivity,
  peekExitSidecar,
  consumeExitSidecar,
  cleanupTmuxSession,
  type TmuxSessionInfo,
  type TmuxExitData,
  type TmuxActivityData,
} from './tmux-session';

export const TMUX_BASE_DIR = '/tmp/pi-subagents';

// ============================================================================
// Central Watcher for kernel-level exit notification
// ============================================================================

let centralWatcher: fs.FSWatcher | null = null;
let watcherDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const WATCHER_DEBOUNCE_MS = 100;

interface TmuxJobState {
  id: string;
  task: string;
  state: 'running' | 'attached' | 'completed' | 'killed';
  sessionDir?: string;
  createdAt: Date;
  completedAt?: Date;
  exitData?: TmuxExitData;
  onComplete?: (exitData: TmuxExitData) => void;
}

const tmuxJobRegistry = new Map<string, TmuxJobState>();

function startCentralWatcher(): void {
  if (centralWatcher) return;

  // Ensure base directory exists
  if (!fs.existsSync(TMUX_BASE_DIR)) {
    fs.mkdirSync(TMUX_BASE_DIR, { recursive: true });
  }

  centralWatcher = fs.watch(
    TMUX_BASE_DIR,
    { recursive: true },
    (eventType, filename) => {
      if (watcherDebounceTimer) {
        clearTimeout(watcherDebounceTimer);
      }
      watcherDebounceTimer = setTimeout(() => {
        checkAllSessionsForExit();
      }, WATCHER_DEBOUNCE_MS);
    }
  );

  centralWatcher.on('error', (err) => {
    console.error('[tmux-spawner] Central watcher error:', err.message);
  });
}

function stopCentralWatcher(): void {
  if (watcherDebounceTimer) {
    clearTimeout(watcherDebounceTimer);
    watcherDebounceTimer = null;
  }
  if (centralWatcher) {
    centralWatcher.close();
    centralWatcher = null;
  }
}

function checkAllSessionsForExit(): void {
  for (const [jobId, job] of tmuxJobRegistry) {
    if (job.state !== 'running' && job.state !== 'attached') continue;
    if (!job.sessionDir) continue;

    const exitData = peekExitSidecar(job.sessionDir);
    if (exitData) {
      consumeExitSidecar(job.sessionDir);
      handleTmuxJobCompletion(jobId, exitData);
    }
  }
}

function handleTmuxJobCompletion(jobId: string, exitData: TmuxExitData): void {
  const job = tmuxJobRegistry.get(jobId);
  if (!job) return;

  job.state = exitData.type === 'error' || exitData.type === 'cancelled' ? 'killed' : 'completed';
  job.completedAt = new Date();
  job.exitData = exitData;

  // Notify callback
  job.onComplete?.(exitData);

  // Stop watcher when no more running sessions
  const remaining = [...tmuxJobRegistry.values()].filter(
    (j) => j.state === 'running' || j.state === 'attached'
  );
  if (remaining.length === 0) {
    stopCentralWatcher();
  }
}

// ============================================================================
// Tmux Check
// ============================================================================

export async function checkTmux(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tmux', ['-V'], (error) => {
      resolve(error === null);
    });
  });
}

// ============================================================================
// Session Spawning
// ============================================================================

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/**
 * Spawn a subagent in a tmux session
 */
export async function spawnTmuxSubagent(
  task: string,
  contextMode: 'isolated' | 'with_context',
  cwd: string,
  onComplete?: (exitData: TmuxExitData) => void
): Promise<string> {
  const id = `tmux-${generateId()}`;

  // Create session directory and activity tracking
  const session = createTmuxSession(id, task, contextMode);

  // Register in local job registry
  tmuxJobRegistry.set(id, {
    id,
    task,
    state: 'running',
    sessionDir: session.sessionDir,
    createdAt: new Date(),
    onComplete,
  });

  // Start central watcher
  startCentralWatcher();

  // Spawn in tmux
  await spawnInTmux(session, task, contextMode, cwd);

  return id;
}

/**
 * Spawn in tmux window
 *
 * Sets PI_SUBAGENT=1 env var so the subagent pi process activates child-mode
 * automatically (no -e flag needed).
 */
async function spawnInTmux(
  session: TmuxSessionInfo,
  task: string,
  contextMode: 'isolated' | 'with_context',
  cwd: string
): Promise<void> {
  const { id } = session;

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      TMUX: undefined,
      // Child mode env vars
      PI_SUBAGENT: '1',
      PI_SUBAGENT_ID: id,
      PI_SUBAGENT_SESSION_DIR: session.sessionDir,
      PI_SUBAGENT_CONTEXT_MODE: contextMode,
    };

    // Step 1: Create empty tmux session
    execFile('tmux', ['new-session', '-d', '-s', id, '-c', cwd], { env },
      (error: Error | null) => {
        if (error) {
          console.error(`[tmux-spawner] tmux new-session failed: ${error.message}`);
          reject(error);
          return;
        }

        // Step 2: Wait for session to initialize, then send command
        setTimeout(() => {
          const escapedTask = shellEscape(task);
          // Export env vars and run pi - env vars must be set in the tmux session
          const cmd = `export PI_SUBAGENT='1' PI_SUBAGENT_ID='${id}' PI_SUBAGENT_SESSION_DIR='${session.sessionDir}' PI_SUBAGENT_CONTEXT_MODE='${contextMode}' && pi '${escapedTask}'`;
          const sendProc = spawn('tmux', ['send-keys', '-t', id, cmd], { env });

          sendProc.on('close', () => {
            // Step 3: Send Enter to execute
            spawn('tmux', ['send-keys', '-t', id, 'Enter'], { env });
            console.log(`[tmux-spawner] Command sent to session ${id}`);

            // Update activity to active
            writeTmuxActivity(session.sessionDir, {
              runningChildId: id,
              phase: 'active',
              activeScope: 'prompt',
              latestEvent: 'agent_start',
            });

            resolve();
          });

          sendProc.on('error', (err: Error) => {
            console.error(`[tmux-spawner] send-keys failed: ${err.message}`);
            reject(err);
          });
        }, 500);
      }
    );
  });
}

/**
 * Get current activity status for a tmux session
 */
export function getTmuxActivityStatus(
  jobId: string
): { phase: string; scope: string; event: string } | null {
  const job = tmuxJobRegistry.get(jobId);
  if (!job || !job.sessionDir) return null;

  const sessionDir = job.sessionDir;
  const activityPath = path.join(sessionDir, 'activity.json');

  try {
    if (fs.existsSync(activityPath)) {
      const activity = JSON.parse(fs.readFileSync(activityPath, 'utf-8')) as TmuxActivityData;
      return {
        phase: activity.phase,
        scope: activity.activeScope,
        event: activity.latestEvent,
      };
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Get a tmux job by ID
 */
export function getTmuxJob(jobId: string): TmuxJobState | undefined {
  return tmuxJobRegistry.get(jobId);
}

/**
 * List all tmux jobs
 */
export function listTmuxJobs(): TmuxJobState[] {
  return Array.from(tmuxJobRegistry.values());
}

/**
 * List tmux jobs by state
 */
export function listTmuxJobsByState(
  state: 'running' | 'attached' | 'completed' | 'killed'
): TmuxJobState[] {
  return listTmuxJobs().filter((j) => j.state === state);
}

/**
 * Attach to a tmux session (returns instructions)
 */
export function getTmuxAttachInstructions(jobId: string): string | null {
  const job = tmuxJobRegistry.get(jobId);
  if (!job) return null;

  return `To attach manually:
  tmux attach -t ${jobId}

To detach and leave running:
  Ctrl-b d

To kill this subagent:
  tmux kill-session -t ${jobId}`;
}

/**
 * Kill a tmux session
 */
export function killTmuxJob(jobId: string): boolean {
  const job = tmuxJobRegistry.get(jobId);
  if (!job) return false;

  try {
    // Kill tmux session
    spawn('tmux', ['kill-session', '-t', jobId]);

    // Update registry
    job.state = 'killed';
    job.completedAt = new Date();

    // Write cancelled exit
    if (job.sessionDir) {
      const { writeExitSidecar } = require('./tmux-session');
      writeExitSidecar(job.sessionDir, 'cancelled');
    }

    return true;
  } catch (e) {
    console.error(`[tmux-spawner] Failed to kill job ${jobId}:`, e);
    return false;
  }
}

/**
 * Update job state to attached
 */
export function attachTmuxJob(jobId: string): boolean {
  const job = tmuxJobRegistry.get(jobId);
  if (!job) return false;
  job.state = 'attached';
  return true;
}

/**
 * Shutdown all tmux sessions
 */
export function shutdownAllTmux(): void {
  stopCentralWatcher();
  for (const job of tmuxJobRegistry.values()) {
    if (job.state === 'running' || job.state === 'attached') {
      killTmuxJob(job.id);
    }
  }
}
