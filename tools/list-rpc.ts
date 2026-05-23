import { Type } from 'typebox';
import { rpcRegistry } from '../rpc/registry.js';

export const ListRpcParams = Type.Object({
  filter: Type.Optional(Type.String({ description: "Filter by jobId substring" }))
});

export function listRpcSubagents(params: {
  filter?: string;
}): {
  subagents: Array<{
    jobId: string;
    status: "running" | "done" | "error" | "dead";
    socketPath: string;
    exposedTools: string[];
    startedAt: number;
  }>;
} {
  const entries = rpcRegistry.list(params.filter);
  
  return {
    subagents: entries.map(e => ({
      jobId: e.jobId,
      status: e.status,
      socketPath: e.socketPath,
      exposedTools: e.exposedTools,
      startedAt: e.startedAt
    }))
  };
}