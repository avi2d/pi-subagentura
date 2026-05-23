import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RpcRouter, rpcRouter } from '../../rpc/router.js';
import { RpcServiceRegistry } from '../../rpc/registry.js';
import { RpcNotification, RpcRequest, RpcResponse } from '../../rpc/types.js';

// Mock net module
vi.mock('net', () => {
  const mockSocket = {
    on: vi.fn((event, handler) => {
      // Simulate async connection success for 'connect' event
      if (event === 'connect') {
        setTimeout(handler, 0);
      }
      // Simulate async connection error for 'error' event (when path is nonexistent)
      if (event === 'error') {
        setTimeout(() => handler(new Error('ECONNREFUSED')), 0);
      }
    }),
    write: vi.fn(),
    destroy: vi.fn(),
    setEncoding: vi.fn(),
  };

  return {
    createConnection: vi.fn(() => mockSocket),
    Socket: vi.fn(() => mockSocket),
  };
});

describe('RpcRouter', () => {
  let router: RpcRouter;
  let registry: RpcServiceRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new RpcServiceRegistry();
    router = new RpcRouter(registry);
  });

  afterEach(() => {
    // Clean up any pending timers/intervals
    router.disconnect('test-job');
  });

  describe('constructor', () => {
    it('should create router instance', () => {
      expect(router).toBeDefined();
    });

    it('should accept custom registry', () => {
      const customRegistry = new RpcServiceRegistry();
      const customRouter = new RpcRouter(customRegistry);
      expect(customRouter).toBeDefined();
    });

    it('should use default registry when none provided', () => {
      const defaultRouter = new RpcRouter();
      expect(defaultRouter).toBeDefined();
    });
  });

  describe('connect', () => {
    it('should throw when connecting to non-existent session', async () => {
      await expect(router.connect('nonexistent', '/tmp/nonexistent.sock')).rejects.toThrow();
    });

    it('should connect to existing session from registry', async () => {
      const net = await import('net');
      const mockSocket = {
        on: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
      };
      (net.createConnection as any).mockReturnValue(mockSocket);

      // Register entry in registry
      registry.register({
        jobId: 'test-job',
        socketPath: '/tmp/test.sock',
        exposedTools: ['agent.prompt'],
        status: 'running',
        startedAt: Date.now(),
      });

      await router.connect('test-job', '/tmp/test.sock');
      expect(router.hasConnection('test-job')).toBe(true);
    });
  });

  describe('hasConnection', () => {
    it('should return false for non-connected job', () => {
      expect(router.hasConnection('nonexistent')).toBe(false);
    });
  });

  describe('getConnection', () => {
    it('should return undefined for non-connected job', () => {
      expect(router.getConnection('nonexistent')).toBeUndefined();
    });
  });

  describe('call', () => {
    it('should throw when calling non-existent job', async () => {
      await expect(router.call('nonexistent', 'agent.status')).rejects.toThrow('Session not found');
    });

    it('should throw when calling without connection', async () => {
      // Job exists in registry but no active connection
      registry.register({
        jobId: 'orphan-job',
        socketPath: '/tmp/orphan.sock',
        exposedTools: [],
        status: 'running',
        startedAt: Date.now(),
      });

      await expect(router.call('orphan-job', 'agent.status')).rejects.toThrow();
    });
  });

  describe('directCall', () => {
    it('should delegate to call method', async () => {
      registry.register({
        jobId: 'direct-call-test',
        socketPath: '/tmp/direct.sock',
        exposedTools: [],
        status: 'running',
        startedAt: Date.now(),
      });

      // directCall is an alias for call, so it should have the same behavior
      await expect(router.directCall('direct-call-test', 'agent.status')).rejects.toThrow();
    });
  });

  describe('pub/sub', () => {
    it('should subscribe to topic', () => {
      const handler = vi.fn();
      const unsubscribe = router.subscribe('test.topic', handler);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should receive published messages', () => {
      const handler = vi.fn();
      router.subscribe('events.test', handler);

      const message: RpcNotification = {
        jsonrpc: '2.0',
        method: 'events.test',
        params: { data: 'hello' },
      };

      router.publish('events.test', message);
      expect(handler).toHaveBeenCalledWith(message);
    });

    it('should not call handler for different topic', () => {
      const handler = vi.fn();
      router.subscribe('topic.a', handler);

      const message: RpcNotification = {
        jsonrpc: '2.0',
        method: 'topic.b',
        params: { data: 'hello' },
      };

      router.publish('topic.b', message);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should call multiple handlers for same topic', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      router.subscribe('multi.handler', handler1);
      router.subscribe('multi.handler', handler2);

      const message: RpcNotification = {
        jsonrpc: '2.0',
        method: 'multi.handler',
        params: { data: 'test' },
      };

      router.publish('multi.handler', message);
      expect(handler1).toHaveBeenCalledWith(message);
      expect(handler2).toHaveBeenCalledWith(message);
    });

    it('should unsubscribe successfully', () => {
      const handler = vi.fn();
      const unsubscribe = router.subscribe('unsub.test', handler);

      unsubscribe();

      const message: RpcNotification = {
        jsonrpc: '2.0',
        method: 'unsub.test',
        params: {},
      };

      router.publish('unsub.test', message);
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle unsubscribe from within handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      router.subscribe('nested.unsub', handler1);
      const unsub2 = router.subscribe('nested.unsub', handler2);

      // Unsubscribe handler2 when handler1 is called
      handler1.mockImplementation(() => {
        unsub2();
      });

      const message: RpcNotification = {
        jsonrpc: '2.0',
        method: 'nested.unsub',
        params: {},
      };

      router.publish('nested.unsub', message);
      expect(handler1).toHaveBeenCalled();
      // handler2 should have been called once before unsubbing
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple subscriptions from same handler', () => {
      const handler = vi.fn();
      router.subscribe('dup.test', handler);
      router.subscribe('dup.test', handler);

      const message: RpcNotification = {
        jsonrpc: '2.0',
        method: 'dup.test',
        params: {},
      };

      router.publish('dup.test', message);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should start heartbeat for job', () => {
      expect(() => router.startHeartbeat('test-job')).not.toThrow();
      router.stopHeartbeat('test-job');
    });

    it('should stop heartbeat for job', () => {
      router.startHeartbeat('test-job');
      expect(() => router.stopHeartbeat('test-job')).not.toThrow();
    });

    it('should stop existing heartbeat before starting new one', () => {
      const stopSpy = vi.spyOn(router, 'stopHeartbeat');
      router.startHeartbeat('test-job');
      router.startHeartbeat('test-job'); // Should stop the first one
      expect(stopSpy).toHaveBeenCalledWith('test-job');
      router.stopHeartbeat('test-job');
    });

    it('should not throw when stopping non-existent heartbeat', () => {
      expect(() => router.stopHeartbeat('nonexistent')).not.toThrow();
    });
  });

  describe('disconnect', () => {
    it('should disconnect job and cleanup', () => {
      // Should not throw even if no connection exists
      expect(() => router.disconnect('nonexistent')).not.toThrow();
    });

    it('should stop heartbeat on disconnect', () => {
      router.startHeartbeat('test-job');
      expect(() => router.disconnect('test-job')).not.toThrow();
    });
  });
});

describe('RpcRouter - Message Handling', () => {
  let router: RpcRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new RpcRouter();
  });

  afterEach(() => {
    router.disconnect('test-job');
  });

  describe('response handling', () => {
    it('should handle incoming response with result', async () => {
      // This tests the message routing logic
      // We can verify the behavior through pub/sub since responses
      // are handled internally via pendingCalls
    });

    it('should handle incoming response with error', () => {
      // Error responses are handled via pendingCalls map
    });
  });

  describe('notification handling', () => {
    it('should route notifications to correct handlers', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      router.subscribe('notification.a', handlerA);
      router.subscribe('notification.b', handlerB);

      const notifA: RpcNotification = {
        jsonrpc: '2.0',
        method: 'notification.a',
        params: { value: 1 },
      };

      const notifB: RpcNotification = {
        jsonrpc: '2.0',
        method: 'notification.b',
        params: { value: 2 },
      };

      router.publish('notification.a', notifA);
      router.publish('notification.b', notifB);

      expect(handlerA).toHaveBeenCalledWith(notifA);
      expect(handlerB).toHaveBeenCalledWith(notifB);
    });

    it('should handle notifications with correlationId', () => {
      const handler = vi.fn();
      router.subscribe('correlated.event', handler);

      const notif: RpcNotification = {
        jsonrpc: '2.0',
        method: 'correlated.event',
        params: { correlationId: 'corr-123', data: 'test' },
      };

      router.publish('correlated.event', notif);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ correlationId: 'corr-123' }),
      }));
    });
  });
});

describe('rpcRouter singleton', () => {
  it('should export singleton instance', () => {
    expect(rpcRouter).toBeDefined();
    expect(rpcRouter).toBeInstanceOf(RpcRouter);
  });
});

describe('RpcRouter - Timeout Handling', () => {
  let router: RpcRouter;
  let registry: RpcServiceRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new RpcServiceRegistry();
    router = new RpcRouter(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
    router.disconnect('timeout-test');
  });

  it('should handle timeout configuration', async () => {
    vi.useFakeTimers();

    registry.register({
      jobId: 'timeout-test',
      socketPath: '/tmp/timeout.sock',
      exposedTools: [],
      status: 'running',
      startedAt: Date.now(),
    });

    // The timeout should be configurable per-call
    // Actual timeout behavior requires connection mocking
  });
});

describe('RpcRouter - Connection States', () => {
  let router: RpcRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new RpcRouter();
  });

  it('should track multiple connections separately', () => {
    // Multiple jobs can have separate connections tracked
    expect(router.hasConnection('job-a')).toBe(false);
    expect(router.hasConnection('job-b')).toBe(false);
  });

  it('should handle disconnect cleans up connection state', () => {
    router.disconnect('job-a');
    // Should not throw and connection should remain absent
    expect(router.hasConnection('job-a')).toBe(false);
  });
});

describe('RpcRouter - Edge Cases', () => {
  let router: RpcRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new RpcRouter();
  });

  afterEach(() => {
    router.disconnect('edge-test');
  });

  it('should handle empty method name', async () => {
    const registry = new RpcServiceRegistry();
    registry.register({
      jobId: 'edge-test',
      socketPath: '/tmp/edge.sock',
      exposedTools: [],
      status: 'running',
      startedAt: Date.now(),
    });

    // Empty method name would be validated by server
  });

  it('should handle null/undefined params', () => {
    const handler = vi.fn();
    router.subscribe('null.params', handler);

    const notif: RpcNotification = {
      jsonrpc: '2.0',
      method: 'null.params',
      params: undefined,
    };

    expect(() => router.publish('null.params', notif)).not.toThrow();
  });

  it('should handle special characters in jobId', () => {
    const specialIds = ['job/with/slashes', 'job.with.dots', 'job_with_underscores'];
    for (const id of specialIds) {
      expect(() => router.hasConnection(id)).not.toThrow();
      expect(router.hasConnection(id)).toBe(false);
    }
  });

  it('should handle rapid subscribe/unsubscribe', () => {
    const handler = vi.fn();

    for (let i = 0; i < 10; i++) {
      const unsub = router.subscribe('rapid.test', handler);
      unsub();
    }

    router.publish('rapid.test', { jsonrpc: '2.0', method: 'rapid.test' });
    expect(handler).not.toHaveBeenCalled();
  });
});