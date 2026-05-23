import { Type } from 'typebox';
import { rpcRegistry } from '../rpc/registry.js';
import { rpcRouter } from '../rpc/router.js';
import { RpcErrorCode } from '../rpc/types.js';

export const CallRpcParams = Type.Object({
  jobId: Type.String({ description: "Target subagent job ID" }),
  method: Type.String({ description: "RPC method name" }),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  timeout: Type.Optional(Type.Number({ description: "Call timeout in ms", default: 30000 }))
});

export async function callSubagentRpc(params: {
  jobId: string;
  method: string;
  params?: Record<string, unknown>;
  timeout?: number;
}): Promise<{ result: unknown; correlationId?: string }> {
  // 1. Lookup socket path via registry
  const entry = rpcRegistry.lookup(params.jobId);
  if (!entry) {
    throw new Error(`Session not found: ${params.jobId}`);
  }
  
  if (entry.status === 'dead') {
    throw new Error(`Subagent ${params.jobId} is dead`);
  }
  
  // 2. Ensure connection
  if (!rpcRouter.hasConnection(params.jobId)) {
    await rpcRouter.connect(params.jobId, entry.socketPath);
  }
  
  // 3. Make the call with retry (3x exponential backoff)
  const maxRetries = 3;
  const backoffMs = [100, 500, 1000];
  
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await rpcRouter.call(
        params.jobId, 
        params.method, 
        params.params,
        params.timeout || 30000
      );
      
      return { 
        result, 
        correlationId: entry.correlationId 
      };
    } catch (err) {
      lastError = err as Error;
      
      if (err instanceof Error && err.message.includes('timeout')) {
        throw { 
          code: RpcErrorCode.Timeout, 
          message: `Call timeout: ${params.method}` 
        };
      }
      
      // Retry on connection refused
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, backoffMs[attempt]));
        // Try reconnecting
        try {
          await rpcRouter.connect(params.jobId, entry.socketPath);
        } catch {
          // Continue to retry
        }
      }
    }
  }
  
  throw lastError || new Error(`RPC call failed: ${params.method}`);
}