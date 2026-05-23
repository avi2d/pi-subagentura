import { Type } from 'typebox';
import { rpcRegistry } from '../rpc/registry.js';
import { rpcRouter } from '../rpc/router.js';
import { tmuxBridge } from '../rpc/tmux-bridge.js';

export const KillRpcParams = Type.Object({
  jobId: Type.String({ description: "Subagent job ID to terminate" }),
  force: Type.Optional(Type.Boolean({ description: "Force kill", default: false }))
});

export async function killRpcSubagent(params: {
  jobId: string;
  force?: boolean;
}): Promise<{ jobId: string; killed: boolean }> {
  // 1. Lookup session
  const entry = rpcRegistry.lookup(params.jobId);
  if (!entry) {
    throw new Error(`Session not found: ${params.jobId}`);
  }
  
  const sessionId = `pi-subagentura:${params.jobId}`;
  
  // 2. If not force, try graceful shutdown first
  if (!params.force) {
    try {
      // Send session.shutdown notification
      if (rpcRouter.hasConnection(params.jobId)) {
        await rpcRouter.call(params.jobId, 'session.shutdown', {
          correlationId: entry.correlationId
        }, 5000);
        
        // Wait for ack (max 5s)
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch {
      // Best effort graceful shutdown, fall through to force kill
    }
  }
  
  // 3. Stop heartbeat monitoring
  rpcRouter.stopHeartbeat(params.jobId);
  
  // 4. Disconnect router
  rpcRouter.disconnect(params.jobId);
  
  // 5. Kill tmux session
  await tmuxBridge.killSession(sessionId);
  
  // 6. Cleanup socket file
  try {
    const socketPath = entry.socketPath;
    await require('fs').promises.unlink(socketPath);
  } catch {
    // Socket might already be gone
  }
  
  // 7. Unregister from registry
  rpcRegistry.unregister(params.jobId);
  
  return { jobId: params.jobId, killed: true };
}