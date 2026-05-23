import { describe, it, expect, beforeEach } from 'vitest';
import {
  RpcRequest,
  RpcResponse,
  RpcNotification,
  RpcJobState,
  RpcErrorCode,
  RpcServiceEntry,
  TmuxSessionConfig,
  TmuxExitEvent,
  HeartbeatPing,
  HeartbeatPong,
  StreamChunk,
  StreamControl,
  LogEvent,
  RPC_CONSTANTS,
  STREAM_CONSTANTS,
  HEARTBEAT_CONSTANTS,
  SOCKET_DIR,
  SOCKET_DIR_MODE,
  SOCKET_MODE,
} from '../../rpc/types.js';

describe('RPC Types', () => {
  describe('RpcRequest', () => {
    it('should accept valid request structure', () => {
      const request: RpcRequest = {
        jsonrpc: '2.0',
        id: 'unique-id-123',
        method: 'agent.prompt',
        params: { prompt: 'Hello' },
      };
      expect(request.jsonrpc).toBe('2.0');
      expect(request.id).toBe('unique-id-123');
      expect(request.method).toBe('agent.prompt');
      expect(request.params?.prompt).toBe('Hello');
    });

    it('should accept numeric id', () => {
      const request: RpcRequest = {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools.list',
      };
      expect(request.id).toBe(42);
    });

    it('should accept request without params', () => {
      const request: RpcRequest = {
        jsonrpc: '2.0',
        id: 'test',
        method: 'agent.status',
      };
      expect(request.params).toBeUndefined();
    });

    it('should accept null id for error responses', () => {
      const request: RpcRequest = {
        jsonrpc: '2.0',
        id: null as any,
        method: 'test',
      };
      expect(request.id).toBeNull();
    });
  });

  describe('RpcResponse', () => {
    it('should accept success response', () => {
      const response: RpcResponse = {
        jsonrpc: '2.0',
        id: 'req-1',
        result: { success: true },
      };
      expect(response.result).toEqual({ success: true });
      expect(response.error).toBeUndefined();
    });

    it('should accept error response', () => {
      const response: RpcResponse = {
        jsonrpc: '2.0',
        id: 'req-2',
        error: {
          code: RpcErrorCode.MethodNotFound,
          message: 'Method not found',
          data: { method: 'unknown' },
        },
      };
      expect(response.result).toBeUndefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.data).toEqual({ method: 'unknown' });
    });

    it('should accept response without id for batch errors', () => {
      const response: RpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
      expect(response.id).toBeNull();
    });
  });

  describe('RpcNotification', () => {
    it('should accept notification without id', () => {
      const notification: RpcNotification = {
        jsonrpc: '2.0',
        method: 'stream.chunk',
        params: { streamId: 'abc', chunkIndex: 0 },
      };
      expect((notification as any).id).toBeUndefined();
      expect(notification.method).toBe('stream.chunk');
    });

    it('should accept notification with correlationId', () => {
      const notification: RpcNotification = {
        jsonrpc: '2.0',
        method: 'session.heartbeat',
        params: { seq: 5, correlationId: 'corr-123' },
      };
      expect(notification.params.correlationId).toBe('corr-123');
    });
  });

  describe('RpcJobState', () => {
    it('should accept job state with all fields', () => {
      const state: RpcJobState = {
        mode: 'rpc',
        socketPath: '/tmp/test.sock',
        exposedTools: ['agent.prompt', 'tools.execute'],
        tmuxSessionId: 'session-1',
        processId: 12345,
        correlationId: 'corr-abc',
      };
      expect(state.mode).toBe('rpc');
      expect(state.processId).toBe(12345);
    });

    it('should accept job state without optional fields', () => {
      const state: RpcJobState = {
        mode: 'rpc',
        socketPath: '/tmp/test.sock',
        exposedTools: ['tools.list'],
        tmuxSessionId: 'session-2',
      };
      expect(state.processId).toBeUndefined();
      expect(state.correlationId).toBeUndefined();
    });
  });

  describe('RpcErrorCode', () => {
    it('should have correct error code values', () => {
      expect(RpcErrorCode.MethodNotFound).toBe(-32601);
      expect(RpcErrorCode.InvalidParams).toBe(-32602);
      expect(RpcErrorCode.InternalError).toBe(-32603);
      expect(RpcErrorCode.Timeout).toBe(-32000);
      expect(RpcErrorCode.ConnectionRefused).toBe(-32001);
      expect(RpcErrorCode.SessionNotFound).toBe(-32002);
      expect(RpcErrorCode.RequestTooLarge).toBe(-32003);
      expect(RpcErrorCode.InvalidMethodName).toBe(-32004);
      expect(RpcErrorCode.SubagentDead).toBe(-32005);
    });

    it('should match JSON-RPC 2.0 spec error codes', () => {
      // Parse error
      expect(RpcErrorCode.InternalError).toBe(-32603); // Internal error
    });
  });

  describe('RpcServiceEntry', () => {
    it('should accept valid service entry', () => {
      const entry: RpcServiceEntry = {
        jobId: 'job-123',
        socketPath: '/tmp/pi/job-123.sock',
        exposedTools: ['agent.prompt'],
        status: 'running',
        startedAt: Date.now(),
      };
      expect(entry.jobId).toBe('job-123');
      expect(entry.status).toBe('running');
    });

    it('should accept all status values', () => {
      const statuses: RpcServiceEntry['status'][] = ['running', 'done', 'error', 'dead'];
      for (const status of statuses) {
        const entry: RpcServiceEntry = {
          jobId: 'test',
          socketPath: '/tmp/test.sock',
          exposedTools: [],
          status,
          startedAt: Date.now(),
        };
        expect(entry.status).toBe(status);
      }
    });

    it('should accept entry with exit code', () => {
      const entry: RpcServiceEntry = {
        jobId: 'job-exit',
        socketPath: '/tmp/test.sock',
        exposedTools: [],
        status: 'done',
        startedAt: Date.now(),
        exitCode: 0,
      };
      expect(entry.exitCode).toBe(0);
    });
  });

  describe('TmuxSessionConfig', () => {
    it('should accept valid config', () => {
      const config: TmuxSessionConfig = {
        jobId: 'tmux-job-1',
        socketDir: '/tmp/pi-sessions',
        entryScriptPath: '/app/entry.sh',
        cwd: '/project',
        timeout: 60000,
        correlationId: 'corr-xyz',
      };
      expect(config.jobId).toBe('tmux-job-1');
      expect(config.timeout).toBe(60000);
    });
  });

  describe('TmuxExitEvent', () => {
    it('should accept all reason values', () => {
      const reasons: TmuxExitEvent['reason'][] = ['normal', 'crash', 'signal', 'timeout'];
      for (const reason of reasons) {
        const event: TmuxExitEvent = {
          sessionId: 'session-1',
          jobId: 'job-1',
          exitCode: reason === 'normal' ? 0 : 1,
          reason,
        };
        expect(event.reason).toBe(reason);
      }
    });
  });

  describe('HeartbeatPing', () => {
    it('should accept valid ping', () => {
      const ping: HeartbeatPing = {
        jsonrpc: '2.0',
        method: 'session.heartbeat',
        params: { seq: 10, correlationId: 'ping-123' },
      };
      expect(ping.params.seq).toBe(10);
      expect(ping.params.correlationId).toBe('ping-123');
    });
  });

  describe('HeartbeatPong', () => {
    it('should accept valid pong', () => {
      const pong: HeartbeatPong = {
        jsonrpc: '2.0',
        method: 'session.heartbeat',
        params: { seq: 10, correlationId: 'ping-123' },
      };
      expect(pong.params.seq).toBe(10);
    });
  });

  describe('StreamChunk', () => {
    it('should accept valid stream chunk', () => {
      const chunk: StreamChunk = {
        jsonrpc: '2.0',
        method: 'stream.chunk',
        params: {
          streamId: 'stream-abc',
          chunkIndex: 0,
          data: Buffer.from('hello').toString('base64'),
          isLast: false,
          correlationId: 'corr-1',
        },
      };
      expect(chunk.params.streamId).toBe('stream-abc');
      expect(chunk.params.isLast).toBe(false);
    });

    it('should accept last chunk', () => {
      const chunk: StreamChunk = {
        jsonrpc: '2.0',
        method: 'stream.chunk',
        params: {
          streamId: 'stream-abc',
          chunkIndex: 5,
          data: Buffer.from('done').toString('base64'),
          isLast: true,
        },
      };
      expect(chunk.params.isLast).toBe(true);
    });
  });

  describe('StreamControl', () => {
    it('should accept pause action', () => {
      const control: StreamControl = {
        jsonrpc: '2.0',
        method: 'stream.control',
        params: { streamId: 'stream-1', action: 'pause' },
      };
      expect(control.params.action).toBe('pause');
    });

    it('should accept resume action', () => {
      const control: StreamControl = {
        jsonrpc: '2.0',
        method: 'stream.control',
        params: { streamId: 'stream-1', action: 'resume' },
      };
      expect(control.params.action).toBe('resume');
    });

    it('should accept cancel action', () => {
      const control: StreamControl = {
        jsonrpc: '2.0',
        method: 'stream.control',
        params: { streamId: 'stream-1', action: 'cancel' },
      };
      expect(control.params.action).toBe('cancel');
    });
  });

  describe('LogEvent', () => {
    it('should accept all log levels', () => {
      const levels: LogEvent['level'][] = ['debug', 'info', 'warn', 'error'];
      for (const level of levels) {
        const event: LogEvent = {
          timestamp: Date.now(),
          level,
          event: 'test',
        };
        expect(event.level).toBe(level);
      }
    });

    it('should accept full log event', () => {
      const event: LogEvent = {
        timestamp: Date.now(),
        level: 'error',
        event: 'connection_failed',
        correlationId: 'corr-err',
        jobId: 'job-err',
        data: { reason: 'timeout' },
      };
      expect(event.data?.reason).toBe('timeout');
    });
  });

  describe('RPC_CONSTANTS', () => {
    it('should have correct max request size (10MB)', () => {
      expect(RPC_CONSTANTS.MAX_REQUEST_SIZE).toBe(10 * 1024 * 1024);
    });

    it('should have correct max depth', () => {
      expect(RPC_CONSTANTS.MAX_DEPTH).toBe(64);
    });

    it('should have correct max string length', () => {
      expect(RPC_CONSTANTS.MAX_STRING_LENGTH).toBe(1024);
    });

    it('should have correct max batch size', () => {
      expect(RPC_CONSTANTS.MAX_BATCH_SIZE).toBe(100);
    });
  });

  describe('STREAM_CONSTANTS', () => {
    it('should have correct chunk size (64KB)', () => {
      expect(STREAM_CONSTANTS.CHUNK_SIZE).toBe(64 * 1024);
    });

    it('should have correct max buffered chunks', () => {
      expect(STREAM_CONSTANTS.MAX_BUFFERED_CHUNKS).toBe(16);
    });

    it('should have correct high water mark', () => {
      expect(STREAM_CONSTANTS.STREAM_HIGH_WATER).toBe(16);
    });
  });

  describe('HEARTBEAT_CONSTANTS', () => {
    it('should have correct interval (10 seconds)', () => {
      expect(HEARTBEAT_CONSTANTS.INTERVAL_MS).toBe(10_000);
    });

    it('should have correct timeout (30 seconds)', () => {
      expect(HEARTBEAT_CONSTANTS.TIMEOUT_MS).toBe(30_000);
    });

    it('should have correct max missed heartbeats', () => {
      expect(HEARTBEAT_CONSTANTS.MAX_MISSED).toBe(3);
    });
  });

  describe('Socket constants', () => {
    it('should have correct socket directory', () => {
      expect(SOCKET_DIR).toBe('/tmp/pi-subagentura/');
    });

    it('should have restrictive socket directory mode', () => {
      expect(SOCKET_DIR_MODE).toBe(0o700);
    });

    it('should have restrictive socket mode', () => {
      expect(SOCKET_MODE).toBe(0o700);
    });
  });
});