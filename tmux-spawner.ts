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
  writeExitSidecar,
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
  // Epoch ms of the last observed fs.watch event for this job. Used by the
  // watchdog to detect orphaned children that crash before writing the exit sidecar.
  lastActivity: number;
}

const tmuxJobRegistry = new Map<string, TmuxJobState>();

// Watchdog: poll running jobs for orphans that crashed before writing the
// exit sidecar. fs.watch only fires on file changes, so a stuck child
// produces no events and would otherwise stay 'running' forever.
const WATCHDOG_CHECK_MS = 30_000;
const WATCHDOG_TIMEOUT_MS = 5 * 60_000; // 5 minutes with no activity = orphan
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

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

  if (!watchdogTimer) {
    watchdogTimer = setInterval(checkWatchdog, WATCHDOG_CHECK_MS);
    // Don't keep the event loop alive just for the watchdog.
    watchdogTimer.unref?.();
  }
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
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function checkWatchdog(): void {
  const now = Date.now();
  for (const [, job] of tmuxJobRegistry) {
    // Skip 'attached' jobs - a human is supervising; the child is likely idle
    // waiting for input and not writing activity, but the user can still kill
    // manually if needed. Only orphaned 'running' jobs should be reaped.
    if (job.state === 'attached') continue;
    if (job.state !== 'running') continue;
    if (now - job.lastActivity < WATCHDOG_TIMEOUT_MS) continue;

    // Orphaned: no watcher event for too long. Mark killed so the job doesn't
    // stay 'running' forever. Best-effort sidecar so any concurrent reader
    // sees the result.
    console.warn(
      `[tmux-spawner] Watchdog: job ${job.id} inactive for ${Math.round(
        (now - job.lastActivity) / 1000
      )}s, marking as killed`
    );
    if (job.sessionDir) {
      writeExitSidecar(job.sessionDir, 'cancelled', {
        errorMessage: 'watchdog timeout: no activity',
      });
    }
    job.state = 'killed';
    job.completedAt = new Date();
    job.exitData = {
      type: 'cancelled',
      timestamp: new Date().toISOString(),
      errorMessage: 'watchdog timeout: no activity',
    };
    job.onComplete?.(job.exitData);
  }

  // If watchdog has nothing to watch, stop the interval to avoid burning CPU.
  const hasActive = [...tmuxJobRegistry.values()].some(
    (j) => j.state === 'running' || j.state === 'attached'
  );
  if (!hasActive && watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function checkAllSessionsForExit(): void {
  for (const [jobId, job] of tmuxJobRegistry) {
    if (job.state !== 'running' && job.state !== 'attached') continue;
    if (!job.sessionDir) continue;

    // The watcher fired for a file in this job's session dir - the child is alive.
    job.lastActivity = Date.now();

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

/**
 * Single-quote escape for embedding a string inside `'...'` in a shell command.
 * Correct for that context (closing quote, escaped quote, reopening quote), but
 * does NOT sanitize unquoted metacharacters. Callers must wrap the result in
 * single quotes.
 */
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
    lastActivity: Date.now(),
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

  // Strip TMUX from the child's env so it doesn't see itself as nested.
  // Setting `TMUX: undefined` is not contractually filtered by child_process
  // across all versions; explicitly omit the key.
  const { TMUX: _stripped, ...envWithoutTmux } = process.env;
  void _stripped;
  const env: NodeJS.ProcessEnv = {
    ...envWithoutTmux,
    PI_SUBAGENT: '1',
    PI_SUBAGENT_ID: id,
    PI_SUBAGENT_SESSION_DIR: session.sessionDir,
    PI_SUBAGENT_CONTEXT_MODE: contextMode,
  };

  return new Promise((resolve, reject) => {
    // Step 1: Create empty tmux session
    execFile('tmux', ['new-session', '-d', '-s', id, '-c', cwd], { env }, (err: Error | null) => {
      if (err) {
        console.error(`[tmux-spawner] tmux new-session failed: ${err.message}`);
        return reject(err);
      }

      // Step 2: Wait until the session is actually queryable. Polling is more
      // robust than a fixed 500ms sleep on slow systems / under load. 100ms
      // keeps worst-case child process count at ~50 (5s / 100ms), low enough
      // not to spike CPU on slow spawns.
      waitForTmuxSession(id, { timeoutMs: 5_000, intervalMs: 100 })
        .then(() => {
          const escapedTask = shellEscape(task);
          // Env vars must be exported inside the tmux session because tmux
          // new-session -e (env-flag) is not portable across all tmux versions.
          const cmd = `export PI_SUBAGENT='1' PI_SUBAGENT_ID='${id}' PI_SUBAGENT_SESSION_DIR='${session.sessionDir}' PI_SUBAGENT_CONTEXT_MODE='${contextMode}' && pi '${escapedTask}'`;
          const sendProc = spawn('tmux', ['send-keys', '-t', id, cmd], { env });

          sendProc.on('close', () => {
            // Step 3: Send Enter to execute. Fire-and-forget but with an
            // error handler so a failed send (tmux gone, pipe broken) is
            // visible instead of an unhandled error.
            const enterProc = spawn('tmux', ['send-keys', '-t', id, 'Enter'], { env });
            enterProc.on('error', (enterErr: Error) => {
              console.error(`[tmux-spawner] Enter send failed for ${id}:`, enterErr.message);
            });
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

          sendProc.on('error', (sendErr: Error) => {
            console.error(`[tmux-spawner] send-keys failed: ${sendErr.message}`);
            reject(sendErr);
          });
        })
        .catch((pollErr: Error) => {
          console.error(`[tmux-spawner] session ${id} did not become ready: ${pollErr.message}`);
          reject(pollErr);
        });
    });
  });
}


/**
 * Poll `tmux has-session` until the session is queryable, with a hard timeout.
 * Replaces the previous fixed 500ms setTimeout which was flaky on slow systems.
 */
function waitForTmuxSession(
  id: string,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      execFile('tmux', ['has-session', '-t', id], (err) => {
        if (!err) return resolve();
        if (Date.now() >= deadline) {
          return reject(new Error(`tmux session ${id} not ready after ${opts.timeoutMs}ms`));
        }
        setTimeout(tick, opts.intervalMs);
      });
    };
    tick();
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
  } catch (e) {
    console.error('[tmux-spawner] getTmuxActivityStatus failed:', (e as Error).message);
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
    // Kill tmux session. spawn() is async, so we attach an error handler -
    // any failure (tmux not found, session already dead, etc.) would otherwise
    // be a silent unhandled error.
    const killProc = spawn('tmux', ['kill-session', '-t', jobId]);
    killProc.on('error', (err) => {
      console.error(`[tmux-spawner] kill-session failed for ${jobId}:`, err.message);
    });

    // Update registry
    job.state = 'killed';
    job.completedAt = new Date();

    // Write cancelled exit so any concurrent reader sees the kill.
    if (job.sessionDir) {
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
