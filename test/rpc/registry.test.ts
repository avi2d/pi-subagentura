import { describe, it, expect, beforeEach } from 'vitest';
import { RpcServiceRegistry, rpcRegistry } from '../../rpc/registry.js';
import { RpcServiceEntry } from '../../rpc/types.js';

describe('RpcServiceRegistry', () => {
  let registry: RpcServiceRegistry;

  const createEntry = (jobId: string, overrides: Partial<RpcServiceEntry> = {}): RpcServiceEntry => ({
    jobId,
    socketPath: `/tmp/${jobId}.sock`,
    exposedTools: ['agent.prompt'],
    status: 'running',
    startedAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    registry = new RpcServiceRegistry();
  });

  describe('register', () => {
    it('should register an entry', () => {
      const entry = createEntry('test-1');
      registry.register(entry);

      expect(registry.lookup('test-1')).toBeDefined();
      expect(registry.lookup('test-1')?.socketPath).toBe('/tmp/test-1.sock');
    });

    it('should store all registered entries', () => {
      registry.register(createEntry('job-a'));
      registry.register(createEntry('job-b'));
      registry.register(createEntry('job-c'));

      expect(registry.size()).toBe(3);
    });

    it('should overwrite existing entry with same jobId', () => {
      registry.register(createEntry('test-1', { status: 'running' }));
      registry.register(createEntry('test-1', { status: 'done', exitCode: 0 }));

      expect(registry.lookup('test-1')?.status).toBe('done');
      expect(registry.lookup('test-1')?.exitCode).toBe(0);
    });

    it('should store exposed tools', () => {
      const entry = createEntry('test-tools', {
        exposedTools: ['agent.prompt', 'tools.execute', 'tools.list'],
      });
      registry.register(entry);

      expect(registry.lookup('test-tools')?.exposedTools).toHaveLength(3);
      expect(registry.lookup('test-tools')?.exposedTools).toContain('tools.execute');
    });
  });

  describe('unregister', () => {
    it('should remove entry by jobId', () => {
      registry.register(createEntry('test-1'));
      expect(registry.lookup('test-1')).toBeDefined();

      registry.unregister('test-1');
      expect(registry.lookup('test-1')).toBeUndefined();
    });

    it('should not throw when unregistering non-existent entry', () => {
      expect(() => registry.unregister('nonexistent')).not.toThrow();
    });

    it('should update size after unregister', () => {
      registry.register(createEntry('job-a'));
      registry.register(createEntry('job-b'));
      expect(registry.size()).toBe(2);

      registry.unregister('job-a');
      expect(registry.size()).toBe(1);

      registry.unregister('job-b');
      expect(registry.size()).toBe(0);
    });
  });

  describe('lookup', () => {
    it('should return entry for existing jobId', () => {
      const entry = createEntry('lookup-test', { socketPath: '/tmp/lookup.sock' });
      registry.register(entry);

      const found = registry.lookup('lookup-test');
      expect(found?.socketPath).toBe('/tmp/lookup.sock');
    });

    it('should return undefined for non-existent jobId', () => {
      expect(registry.lookup('nonexistent')).toBeUndefined();
    });

    it('should return undefined for empty registry', () => {
      expect(registry.lookup('any')).toBeUndefined();
    });
  });

  describe('list', () => {
    beforeEach(() => {
      registry.register(createEntry('abc-123', { status: 'running' }));
      registry.register(createEntry('abc-456', { status: 'done' }));
      registry.register(createEntry('xyz-789', { status: 'error' }));
      registry.register(createEntry('def-000', { status: 'running' }));
    });

    it('should return all entries without filter', () => {
      const entries = registry.list();
      expect(entries).toHaveLength(4);
    });

    it('should filter by jobId substring (case-insensitive)', () => {
      const filtered = registry.list('abc');
      expect(filtered).toHaveLength(2);
      expect(filtered.map(e => e.jobId).sort()).toEqual(['abc-123', 'abc-456']);
    });

    it('should return empty array when no matches', () => {
      const filtered = registry.list('nonexistent');
      expect(filtered).toHaveLength(0);
    });

    it('should be case-insensitive', () => {
      const filtered = registry.list('ABC');
      expect(filtered).toHaveLength(2);
    });

    it('should find partial matches', () => {
      const filtered = registry.list('1');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].jobId).toBe('abc-123');
    });

    it('should find matches across all jobIds', () => {
      const filtered = registry.list('-');
      expect(filtered).toHaveLength(4); // All have dashes
    });
  });

  describe('updateStatus', () => {
    it('should update status of existing entry', () => {
      registry.register(createEntry('test-1', { status: 'running' }));
      registry.updateStatus('test-1', 'done', 0);

      expect(registry.lookup('test-1')?.status).toBe('done');
      expect(registry.lookup('test-1')?.exitCode).toBe(0);
    });

    it('should update status without exit code', () => {
      registry.register(createEntry('test-1', { status: 'running' }));
      registry.updateStatus('test-1', 'dead');

      expect(registry.lookup('test-1')?.status).toBe('dead');
      expect(registry.lookup('test-1')?.exitCode).toBeUndefined();
    });

    it('should not throw for non-existent entry', () => {
      expect(() => registry.updateStatus('nonexistent', 'dead')).not.toThrow();
    });

    it('should update through all status values', () => {
      registry.register(createEntry('status-test', { status: 'running' }));

      const statuses: RpcServiceEntry['status'][] = ['running', 'done', 'error', 'dead'];
      for (const status of statuses) {
        registry.updateStatus('status-test', status, status === 'done' ? 0 : 1);
        expect(registry.lookup('status-test')?.status).toBe(status);
      }
    });
  });

  describe('updateHeartbeat', () => {
    it('should update lastHeartbeat timestamp', () => {
      registry.register(createEntry('heartbeat-test'));
      const beforeUpdate = Date.now();

      registry.updateHeartbeat('heartbeat-test');

      const entry = registry.lookup('heartbeat-test');
      expect(entry?.lastHeartbeat).toBeDefined();
      expect(entry!.lastHeartbeat!).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('should not throw for non-existent entry', () => {
      expect(() => registry.updateHeartbeat('nonexistent')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      registry.register(createEntry('job-1'));
      registry.register(createEntry('job-2'));
      registry.register(createEntry('job-3'));

      expect(registry.size()).toBe(3);
      registry.clear();
      expect(registry.size()).toBe(0);
    });

    it('should work on empty registry', () => {
      expect(() => registry.clear()).not.toThrow();
      expect(registry.size()).toBe(0);
    });
  });

  describe('size', () => {
    it('should return 0 for empty registry', () => {
      expect(registry.size()).toBe(0);
    });

    it('should return correct count', () => {
      registry.register(createEntry('a'));
      expect(registry.size()).toBe(1);

      registry.register(createEntry('b'));
      expect(registry.size()).toBe(2);

      registry.register(createEntry('c'));
      expect(registry.size()).toBe(3);

      registry.unregister('b');
      expect(registry.size()).toBe(2);
    });
  });

  describe('concurrency behavior', () => {
    it('should handle rapid register/unregister', async () => {
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 100; i++) {
        const jobId = `job-${i}`;
        promises.push(
          Promise.resolve().then(() => registry.register(createEntry(jobId)))
        );
      }

      await Promise.all(promises);
      expect(registry.size()).toBe(100);
    });

    it('should handle interleaved operations', () => {
      for (let i = 0; i < 50; i++) {
        registry.register(createEntry(`job-${i}`));
        if (i % 2 === 0) {
          registry.unregister(`job-${i}`);
        }
      }

      // Even indices were unregistered
      expect(registry.size()).toBe(25);
    });
  });

  describe('entry preservation', () => {
    it('should preserve all entry fields', () => {
      const entry: RpcServiceEntry = {
        jobId: 'full-entry',
        socketPath: '/tmp/full.sock',
        exposedTools: ['a', 'b', 'c'],
        status: 'running',
        startedAt: 1234567890,
        exitCode: undefined,
        correlationId: 'corr-123',
        lastHeartbeat: 1234567900,
      };

      registry.register(entry);
      const retrieved = registry.lookup('full-entry');

      expect(retrieved?.jobId).toBe(entry.jobId);
      expect(retrieved?.socketPath).toBe(entry.socketPath);
      expect(retrieved?.exposedTools).toEqual(entry.exposedTools);
      expect(retrieved?.status).toBe(entry.status);
      expect(retrieved?.startedAt).toBe(entry.startedAt);
      expect(retrieved?.correlationId).toBe(entry.correlationId);
      expect(retrieved?.lastHeartbeat).toBe(entry.lastHeartbeat);
    });

    it('should update individual fields without affecting others', () => {
      registry.register(createEntry('partial-test', {
        status: 'running',
        lastHeartbeat: 1000,
      }));

      registry.updateStatus('partial-test', 'done', 0);
      registry.updateHeartbeat('partial-test');

      const entry = registry.lookup('partial-test');
      expect(entry?.status).toBe('done');
      expect(entry?.exitCode).toBe(0);
      expect(entry?.lastHeartbeat).toBeGreaterThan(1000);
    });
  });
});

describe('rpcRegistry singleton', () => {
  it('should export singleton instance', () => {
    expect(rpcRegistry).toBeDefined();
    expect(rpcRegistry).toBeInstanceOf(RpcServiceRegistry);
  });

  it('should be usable as default registry', () => {
    // The singleton should be usable without instantiation
    const size = rpcRegistry.size();
    expect(typeof size).toBe('number');
  });
});

describe('RpcServiceRegistry - Edge Cases', () => {
  let registry: RpcServiceRegistry;

  const createEntry = (jobId: string, overrides: Partial<RpcServiceEntry> = {}): RpcServiceEntry => ({
    jobId,
    socketPath: `/tmp/${jobId}.sock`,
    exposedTools: ['agent.prompt'],
    status: 'running',
    startedAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    registry = new RpcServiceRegistry();
  });

  it('should handle jobId with special characters', () => {
    const specialIds = ['job/with/slashes', 'job.with.dots', 'job_with_underscores', 'job-with-hyphens'];
    for (const id of specialIds) {
      registry.register(createEntry(id));
      expect(registry.lookup(id)?.jobId).toBe(id);
    }
  });

  it('should handle long jobId', () => {
    const longId = 'a'.repeat(500);
    registry.register(createEntry(longId));
    expect(registry.lookup(longId)?.jobId).toBe(longId);
  });

  it('should handle empty filter string', () => {
    registry.register(createEntry('test'));
    // Empty string filter should still return all (treated as falsy)
    const results = registry.list('');
    expect(results.length).toBeGreaterThan(0);
  });

  it('should handle filter that matches all entries', () => {
    registry.register(createEntry('abc'));
    registry.register(createEntry('xyz'));
    registry.register(createEntry('123'));

    const results = registry.list('x'); // Only matches xyz
    expect(results).toHaveLength(1);
  });
});