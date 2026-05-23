import { RpcServiceEntry } from './types.js';

export class RpcServiceRegistry {
  private registry: Map<string, RpcServiceEntry> = new Map();
  private lock: Promise<void> = Promise.resolve();

  register(entry: RpcServiceEntry): void {
    this.registry.set(entry.jobId, entry);
  }

  unregister(jobId: string): void {
    this.registry.delete(jobId);
  }

  lookup(jobId: string): RpcServiceEntry | undefined {
    return this.registry.get(jobId);
  }

  list(filter?: string): RpcServiceEntry[] {
    const entries = Array.from(this.registry.values());
    if (!filter) return entries;
    
    const lowerFilter = filter.toLowerCase();
    return entries.filter(e => e.jobId.toLowerCase().includes(lowerFilter));
  }

  updateStatus(jobId: string, status: RpcServiceEntry['status'], exitCode?: number): void {
    const entry = this.registry.get(jobId);
    if (entry) {
      entry.status = status;
      if (exitCode !== undefined) {
        entry.exitCode = exitCode;
      }
    } else {
      console.warn(`[registry] updateStatus: jobId ${jobId} not found`);
    }
  }

  updateHeartbeat(jobId: string): void {
    const entry = this.registry.get(jobId);
    if (entry) {
      entry.lastHeartbeat = Date.now();
    } else {
      console.warn(`[registry] updateHeartbeat: jobId ${jobId} not found`);
    }
  }

  clear(): void {
    this.registry.clear();
  }

  size(): number {
    return this.registry.size;
  }
}

// Singleton instance
export const rpcRegistry = new RpcServiceRegistry();
