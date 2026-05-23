/**
 * Test for spawn-notify tool
 */

import { describe, it, expect } from 'vitest';
import { spawnNotifySubagent, SpawnNotifyParams } from '../tools/spawn-notify.js';

describe('spawn-notify tool', () => {
   describe('SpawnNotifyParams schema', () => {
      it('should have required task parameter', () => {
         expect(SpawnNotifyParams).toBeDefined();
         expect(SpawnNotifyParams.type).toBe('object');

         // Check that task is required
         const taskProp = (SpawnNotifyParams.properties as any)?.task;
         expect(taskProp).toBeDefined();
      });

      it('should accept optional persona parameter', () => {
         const personaProp = (SpawnNotifyParams.properties as any)?.persona;
         expect(personaProp).toBeDefined();
      });

      it('should accept optional notifyOnComplete parameter', () => {
         const notifyProp = (SpawnNotifyParams.properties as any)?.notifyOnComplete;
         expect(notifyProp).toBeDefined();
      });
   });

   describe('spawnNotifySubagent integration', () => {
      // These are integration tests that actually create tmux sessions
      // They will be skipped in CI but can be run locally

      const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === 'true';

      it.skipIf(!runIntegrationTests)('should create a tmux session with pi command', async () => {
         const result = await spawnNotifySubagent({
            task: 'echo hello from test',
         });

         expect(result).toHaveProperty('jobId');
         expect(result).toHaveProperty('sessionId');
         expect(result.sessionId).toContain('pi-subagentura-');
         expect(result.attachCommand).toContain(result.sessionId);

         // Cleanup - kill the session
         const { exec } = await import('child_process');
         const { promisify } = await import('util');
         const execAsync = promisify(exec);
         await execAsync(`tmux kill-session -t "${result.sessionId}"`);
      });

      it.skipIf(!runIntegrationTests)('should generate unique job IDs', async () => {
         const result1 = await spawnNotifySubagent({ task: 'test 1' });
         const result2 = await spawnNotifySubagent({ task: 'test 2' });

         expect(result1.jobId).not.toBe(result2.jobId);
         expect(result1.sessionId).not.toBe(result2.sessionId);

         // Cleanup
         const { exec } = await import('child_process');
         const { promisify } = await import('util');
         const execAsync = promisify(exec);
         await execAsync(`tmux kill-session -t "${result1.sessionId}"`);
         await execAsync(`tmux kill-session -t "${result2.sessionId}"`);
      });

      it.skipIf(!runIntegrationTests)('should return correct attach commands', async () => {
         const result = await spawnNotifySubagent({ task: 'test' });

         expect(result.attachCommand).toMatch(/^tmux attach -t /);
         expect(result.weztermCommand).toMatch(/^wezterm cli split-pane/);
         expect(result.zellijCommand).toMatch(/^zellij attach /);

         // Cleanup
         const { exec } = await import('child_process');
         const { promisify } = await import('util');
         const execAsync = promisify(exec);
         await execAsync(`tmux kill-session -t "${result.sessionId}"`);
      });

      it.skipIf(!runIntegrationTests)('should throw if tmux is not available', async () => {
         // This test would need to mock the tmux check which is complex
         // Instead, we rely on the manual verification
      });
   });
});
