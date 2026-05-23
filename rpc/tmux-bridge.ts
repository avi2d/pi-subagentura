import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { TmuxSessionConfig, TmuxExitEvent, SOCKET_DIR } from './types.js';

const execAsync = promisify(exec);

export class TmuxNotFoundError extends Error {
   constructor() {
      super(
         'tmux is not installed. Please install tmux:\n' +
         '  macOS: brew install tmux\n' +
         '  Ubuntu/Debian: sudo apt-get install tmux\n' +
         '  CentOS/RHEL: sudo yum install tmux'
      );
      this.name = 'TmuxNotFoundError';
   }
}

export class TmuxBridge {
   private socketDir: string;
   private tmuxHooksEnabled: boolean = false;
   private sessionExitHandlers: Map<string, (event: TmuxExitEvent) => void> = new Map();
   private orphanCleanupInterval: NodeJS.Timeout | null = null;

   constructor(socketDir: string = SOCKET_DIR) {
      this.socketDir = socketDir;
   }

   // System check - verify tmux is available
   async isTmuxAvailable(): Promise<boolean> {
      try {
         await execAsync('tmux -V');
         return true;
      } catch {
         return false;
      }
   }

   // Ensure tmux is available or throw
   async ensureTmuxAvailable(): Promise<void> {
      const available = await this.isTmuxAvailable();
      if (!available) {
         throw new TmuxNotFoundError();
      }
   }

   // Setup tmux hooks for session exit detection (C-2 - MANDATORY)
   async setupTmuxHooks(): Promise<void> {
      await this.ensureTmuxAvailable();

      // Set global hook for session close - this is CRITICAL for crash detection
      const hookCmd = `tmux set-hook -g session-closed 'if -F "#{session_name}" != "" { display-message "SESSION_CLOSED #{session_name} #{session_pid}" }'`;

      try {
         await execAsync(hookCmd);
         this.tmuxHooksEnabled = true;
      } catch (err) {
         console.warn('Failed to setup tmux hooks:', err);
         // Hooks failed but we can still use polling fallback
      }
   }

   // Create a new tmux session
   async createSession(config: TmuxSessionConfig): Promise<{ sessionId: string; processId: number }> {
      await this.ensureTmuxAvailable();

      // CRITICAL: Sanitize jobId to prevent command injection
      // jobId comes from internal UUID generation, but we validate anyway
      const safeJobId = config.jobId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safeJobId || safeJobId.length !== config.jobId.length) {
         throw new Error(`Invalid jobId: contains unsafe characters`);
      }

      const sessionName = `pi-subagentura-${safeJobId}`;
      const entryScript = config.entryScriptPath;
      const socketPath = path.join(this.socketDir, `${safeJobId}.sock`);

      // Build the tmux command - entryScript is internal path, no user input
      // TERM=xterm is needed when spawning from non-interactive contexts
      // Pass task/persona via env vars for auto-execution
      const taskEnv = config.task ? `PI_TASK='${config.task.replace(/'/g, "'\\''")}'` : '';
      const personaEnv = config.persona ? `PI_PERSONA='${config.persona.replace(/'/g, "'\\''")}'` : '';
      const envVars = [taskEnv, personaEnv].filter(Boolean).join(' ');
      const fullEnv = envVars ? `${envVars} ` : '';
      // Use nvm node v20 as a stable path (fnm paths are temporary)
      // Use bash -c with background sleep to keep session alive after command finishes
      const nodePath = '/Users/applesucks/.nvm/versions/node/v20.15.1/bin/node';
      const tmuxCmd = `tmux new-session -d -s "${sessionName}" -n pi-subagent 'bash -c "env TERM=xterm ${fullEnv.replace(/'/g, "'\\\\'\\\\''")}${nodePath} ${entryScript} --socket=${socketPath} --jobId=${safeJobId}; sleep 9999"'`;
      console.error(`[tmux-bridge] Creating session: ${sessionName}`);
      console.error(`[tmux-bridge] Command: ${tmuxCmd}`);
      try {
         await execAsync(tmuxCmd);
      } catch (err) {
         throw new Error(`Failed to create tmux session ${sessionName}: ${err}`);
      }

      // Get the pane PID
      const pid = await this.getSessionPid(sessionName);

      return { sessionId: sessionName, processId: pid };
   }

   // Kill a tmux session
   async killSession(sessionId: string): Promise<void> {
      await this.ensureTmuxAvailable();

      try {
         await execAsync(`tmux kill-session -t "${sessionId}"`);
      } catch (err) {
         // Session might already be dead, which is fine
         console.warn(`Failed to kill session ${sessionId}:`, err);
      }
   }

   // Attach to a tmux session (for debugging)
   async attachToSession(sessionId: string): Promise<void> {
      await this.ensureTmuxAvailable();

      // This would need to be run interactively
      console.log(`To attach to session ${sessionId}, run: tmux attach -t ${sessionId}`);
   }

   // Get the pane PID for a session
   async getSessionPid(sessionName: string): Promise<number> {
      try {
         const { stdout } = await execAsync(
            `tmux list-panes -t "${sessionName}" -F '#{pane_pid}'`
         );
         return parseInt(stdout.trim(), 10);
      } catch {
         return -1;
      }
   }

   // Check if a session exists
   async sessionExists(sessionName: string): Promise<boolean> {
      try {
         await execAsync(`tmux list-sessions -F '#{session_name}' | grep -q "${sessionName}"`);
         return true;
      } catch {
         return false;
      }
   }

   // List all our sessions
   async listSessions(): Promise<string[]> {
      await this.ensureTmuxAvailable();

      try {
         const { stdout } = await execAsync('tmux list-sessions -F \'#{session_name}\'');
         const allSessions = stdout.trim().split('\n').filter(Boolean);
         return allSessions.filter(name => name.startsWith('pi-subagentura-'));
      } catch {
         return [];
      }
   }

   // Detect zombie sessions (sessions in tmux but not in our registry)
   async detectZombieSessions(registryJobIds: Set<string>): Promise<string[]> {
      const tmuxSessions = await this.listSessions();
      const zombies: string[] = [];

      for (const session of tmuxSessions) {
         const jobId = session.replace('pi-subagentura-', '');
         if (!registryJobIds.has(jobId)) {
            zombies.push(session);
         }
      }

      return zombies;
   }

   // Cleanup orphaned sessions (NFR-2.3, O-2)
   async cleanupOrphans(registryJobIds: Set<string>): Promise<number> {
      const zombies = await this.detectZombieSessions(registryJobIds);
      let cleaned = 0;

      for (const session of zombies) {
         try {
            await this.killSession(session);
            cleaned++;
            console.log(`Cleaned up orphan session: ${session}`);
         } catch (err) {
            console.warn(`Failed to cleanup orphan ${session}:`, err);
         }
      }

      return cleaned;
   }

   // Start periodic orphan cleanup (runs on startup and every 5 minutes)
   startOrphanCleanup(registryJobIdsFn: () => Set<string>): void {
      // Initial cleanup on startup
      this.cleanupOrphans(registryJobIdsFn()).catch(console.error);

      // Periodic cleanup every 5 minutes
      this.orphanCleanupInterval = setInterval(async () => {
         await this.cleanupOrphans(registryJobIdsFn());
      }, 5 * 60 * 1000);
   }

   stopOrphanCleanup(): void {
      if (this.orphanCleanupInterval) {
         clearInterval(this.orphanCleanupInterval);
         this.orphanCleanupInterval = null;
      }
   }

   // Register session exit handler
   onSessionExit(sessionId: string, handler: (event: TmuxExitEvent) => void): void {
      this.sessionExitHandlers.set(sessionId, handler);
   }

   // Handle session exit (called when we detect session closed)
   async handleSessionExit(sessionId: string, jobId: string, exitCode: number, reason: 'normal' | 'crash' | 'signal' | 'timeout'): Promise<void> {
      const handler = this.sessionExitHandlers.get(sessionId);
      if (handler) {
         const event: TmuxExitEvent = {
            sessionId,
            jobId,
            exitCode,
            reason
         };
         handler(event);
      }
   }

   // tmux server crash behavior (E-1)
   // When tmux server crashes, sessions become detached and hooks don't fire
   // Fallback: poll tmux list-sessions to detect missing sessions
   async detectDetachedSessions(registryJobIds: Set<string>): Promise<string[]> {
      const tmuxSessions = await this.listSessions();
      const detached: string[] = [];

      for (const jobId of registryJobIds) {
         const sessionName = `pi-subagentura-${jobId}`;
         if (!tmuxSessions.includes(sessionName)) {
            detached.push(jobId);
         }
      }

      return detached;
   }
}

// Singleton instance
export const tmuxBridge = new TmuxBridge();