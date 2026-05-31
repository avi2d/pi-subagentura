/**
 * Tmux Commands - pi command extensions for tmux subagent management
 *
 * Registers command handlers for:
 * - list-subagents: List all tmux subagent sessions
 * - attach: Attach to a subagent's tmux session
 * - kill-subagent: Kill a tmux subagent
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { listTmuxJobs, getTmuxAttachInstructions, killTmuxJob } from './tmux-spawner';

export function registerTmuxCommands(pi: ExtensionAPI): void {
  // list-subagents command
  pi.registerCommand('list-subagents', {
    description: 'List all active subagent sessions',
    // @ts-expect-error - command handler signature differs from type definition
    async handler() {
      const jobs = listTmuxJobs();

      if (jobs.length === 0) {
        return { content: [{ type: 'text', text: 'No active tmux subagents' }] };
      }

      const lines = ['Active Subagents:', ''];
      for (const job of jobs) {
        const status =
          job.state === 'running'
            ? '🟢 running'
            : job.state === 'attached'
              ? '🔵 attached'
              : job.state === 'completed'
                ? '✅ completed'
                : job.state === 'killed'
                  ? '❌ killed'
                  : '⚪ unknown';

        lines.push(`${status} ${job.id}`);
        lines.push(`   Task: ${job.task.substring(0, 60)}${job.task.length > 60 ? '...' : ''}`);
        lines.push(`   Attach: tmux attach -t ${job.id}`);
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  });

  // attach command
  pi.registerCommand('attach', {
    description: 'Attach to a tmux subagent session',
    parameters: [
      {
        name: 'id',
        description: 'Subagent session ID to attach to',
        required: true,
      },
    ],
    // @ts-expect-error - command handler signature differs from type definition
    async handler(params: { id: string }) {
      const instructions = getTmuxAttachInstructions(params.id);
      if (!instructions) {
        return {
          content: [{ type: 'text', text: `Subagent ${params.id} not found` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: instructions,
          },
        ],
      };
    },
  });

  // kill-subagent command
  pi.registerCommand('kill-subagent', {
    description: 'Kill a tmux subagent session',
    parameters: [
      {
        name: 'id',
        description: 'Subagent session ID to kill',
        required: true,
      },
    ],
    // @ts-expect-error - command handler signature differs from type definition
    async handler(params: { id: string }) {
      const success = killTmuxJob(params.id);
      if (!success) {
        return {
          content: [{ type: 'text', text: `Subagent ${params.id} not found` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: `Subagent ${params.id} killed` }],
      };
    },
  });
}
