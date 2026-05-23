import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { TmuxSessionConfig, TmuxExitEvent, SOCKET_DIR } from './types.js';
import { debugLog } from '../helpers.js';

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

   async isTmuxAvailable(): Promise<boolean> {
      try {
         await execAsync('tmux -V');
         return true;
      } catch {
         return false;
      }
   }

   async ensureTmuxAvailable(): Promise<void> {
      const available = await this.isTmuxAvailable();
      if (!available) {
         throw new TmuxNotFoundError();
      }
   }

   async setupTmuxHooks(): Promise<void> {
      await this.ensureTmuxAvailable();
      const hookCmd = `tmux set-hook -g session-closed 'if -F "#{session_name}" != "" { display-message "SESSION_CLOSED #{session_name} #{session_pid}" }'`;

      try {
         await execAsync(hookCmd);
         this.tmuxHooksEnabled = true;
      } catch (err) {
         debugLog("warn", "tmux_hooks_setup_failed", { error: String(err) });
      }
   }

   async createSession(config: TmuxSessionConfig): Promise<{ sessionId: string; processId: number }> {
      await this.ensureTmuxAvailable();

      const safeJobId = config.jobId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safeJobId || safeJobId.length !== config.jobId.length) {
         throw new Error(`Invalid jobId: contains unsafe characters`);
      }

      const sessionName = `pi-subagentura-${safeJobId}`;
      const entryScript = config.entryScriptPath;
      const socketPath = path.join(this.socketDir, `${safeJobId}.sock`);

      const taskJson = config.task ? Buffer.from(JSON.stringify(config.task)).toString('base64') : '';
      const personaJson = config.persona ? Buffer.from(JSON.stringify(config.persona)).toString('base64') : '';
      const nodePath = '/Users/applesucks/.nvm/versions/node/v20.15.1/bin/node';
      const bashCmd = `env TERM=xterm PI_TASK_B64=${taskJson} PI_PERSONA_B64=${personaJson} ${nodePath} ${entryScript} --socket=${socketPath} --jobId=${safeJobId}; sleep 9999`;
      const tmuxArgs = ['new-session', '-d', '-s', sessionName, '-n', 'pi-subagent', 'bash', '-c', bashCmd];

      try {
         const proc = spawn('tmux', tmuxArgs);
         await new Promise<void>((resolve, reject) => {
            proc.on('close', (code) => {
               if (code === 0) resolve();
               else reject(new Error(`tmux exited with code ${code}`));
            });
            proc.on('error', reject);
         });
      } catch (err) {
         debugLog("error", "create_session_failed", { sessionName, error: String(err) });
         throw new Error(`Failed to create tmux session ${sessionName}: ${err}`);
      }

      const pid = await this.getSessionPid(sessionName);
      return { sessionId: sessionName, processId: pid };
   }

   async killSession(sessionId: string): Promise<void> {
      await this.ensureTmuxAvailable();

      try {
         await execAsync(`tmux kill-session -t "${sessionId}"`);
      } catch (err) {
         debugLog("warn", "kill_session_failed", { sessionId, error: String(err) });
      }
   }

   async attachToSession(sessionId: string): Promise<void> {
      await this.ensureTmuxAvailable();
      debugLog("info", "attach_session", { sessionId });
   }

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

   async sessionExists(sessionName: string): Promise<boolean> {
      try {
         await execAsync(`tmux list-sessions -F '#{session_name}' | grep -q "${sessionName}"`);
         return true;
      } catch {
         return false;
      }
   }

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

   async cleanupOrphans(registryJobIds: Set<string>): Promise<number> {
      const zombies = await this.detectZombieSessions(registryJobIds);
      let cleaned = 0;

      for (const session of zombies) {
         try {
            await this.killSession(session);
            cleaned++;
            debugLog("info", "orphan_cleaned", { session });
         } catch (err) {
            debugLog("warn", "orphan_cleanup_failed", { session, error: String(err) });
         }
      }

      return cleaned;
   }

   startOrphanCleanup(registryJobIdsFn: () => Set<string>): void {
      this.cleanupOrphans(registryJobIdsFn()).catch((err) => debugLog("error", "orphan_cleanup_err", { error: String(err) }));

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

   onSessionExit(sessionId: string, handler: (event: TmuxExitEvent) => void): void {
      this.sessionExitHandlers.set(sessionId, handler);
   }

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

export const tmuxBridge = new TmuxBridge();
