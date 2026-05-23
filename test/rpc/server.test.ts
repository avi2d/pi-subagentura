import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JsonRpcServer } from '../../rpc/server.js';
import { RpcRequest, RpcResponse, RpcErrorCode } from '../../rpc/types.js';

describe('JsonRpcServer', () => {
  let server: JsonRpcServer;
  let sentMessages: RpcResponse[];

  const mockSendFn = vi.fn((msg: RpcResponse) => {
    sentMessages.push(msg);
  });

  const mockSocket = {
    write: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sentMessages = [];
    server = new JsonRpcServer();
  });

  describe('constructor', () => {
    it('should create server instance', () => {
      expect(server).toBeDefined();
    });

    it('should register default methods', () => {
      // Default methods should be registered: agent.prompt, agent.status, tools.list, tools.execute, session.shutdown, session.heartbeat
      const methods = ['agent.prompt', 'agent.status', 'tools.list', 'tools.execute', 'session.shutdown', 'session.heartbeat'];
      // We can verify by calling handleRequest and checking they don't return MethodNotFound
    });
  });

  describe('default methods', () => {
    it('should handle agent.prompt', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'agent.prompt',
        params: { prompt: 'Hello' },
      });
      expect(response?.result).toEqual({ success: true, prompt: 'Hello' });
    });

    it('should handle agent.status', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '2',
        method: 'agent.status',
      });
      expect(response?.result).toEqual({ status: 'running' });
    });

    it('should handle tools.list', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '3',
        method: 'tools.list',
      });
      expect(response?.result).toEqual({ tools: [] });
    });

    it('should handle tools.execute', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '4',
        method: 'tools.execute',
        params: { name: 'test-tool' },
      });
      expect(response?.result).toEqual({ success: true, tool: 'test-tool' });
    });

    it('should handle session.shutdown', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '5',
        method: 'session.shutdown',
        params: { correlationId: 'corr-123' },
      });
      expect(response?.result).toEqual({ acknowledged: true, correlationId: 'corr-123' });
    });

    it('should handle session.heartbeat', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '6',
        method: 'session.heartbeat',
        params: { seq: 10 },
      });
      expect(response?.result).toEqual({ seq: 10 });
    });
  });

  describe('registerMethod', () => {
    it('should register custom method', async () => {
      server.registerMethod('custom.test', async () => ({ custom: true }));
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'custom.test',
      });
      expect(response?.result).toEqual({ custom: true });
    });

    it('should allow overwriting default methods', async () => {
      server.registerMethod('agent.status', async () => ({ status: 'custom' }));
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'agent.status',
      });
      expect(response?.result).toEqual({ status: 'custom' });
    });
  });

  describe('registerMethods', () => {
    it('should register multiple methods at once', async () => {
      server.registerMethods({
        'multi.a': async () => ({ a: true }),
        'multi.b': async () => ({ b: true }),
        'multi.c': async () => ({ c: true }),
      });

      const resA = await server.handleRequest({ jsonrpc: '2.0', id: '1', method: 'multi.a' });
      const resB = await server.handleRequest({ jsonrpc: '2.0', id: '2', method: 'multi.b' });
      const resC = await server.handleRequest({ jsonrpc: '2.0', id: '3', method: 'multi.c' });

      expect(resA?.result).toEqual({ a: true });
      expect(resB?.result).toEqual({ b: true });
      expect(resC?.result).toEqual({ c: true });
    });
  });

  describe('method handler errors', () => {
    it('should return InternalError on handler exception', async () => {
      server.registerMethod('error.throw', async () => {
        throw new Error('Intentional error');
      });

      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'error.throw',
      });

      expect(response?.error).toBeDefined();
      expect(response?.error?.code).toBe(RpcErrorCode.InternalError);
      expect(response?.error?.message).toBe('Intentional error');
    });

    it('should handle non-Error exceptions', async () => {
      server.registerMethod('error.string', async () => {
        throw 'string error';
      });

      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'error.string',
      });

      expect(response?.error?.code).toBe(RpcErrorCode.InternalError);
      expect(response?.error?.message).toBe('Internal error');
    });
  });

  describe('handleRequest', () => {
    it('should return result for valid request', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'agent.status',
      });

      expect(response).toBeDefined();
      expect(response?.id).toBe('req-1');
      expect(response?.result).toBeDefined();
    });

    it('should return MethodNotFound for unknown method', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'nonexistent.method',
      });

      expect(response?.error?.code).toBe(RpcErrorCode.MethodNotFound);
      expect(response?.error?.message).toContain('Method not found');
    });

    it('should return null for notifications (no id)', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        method: 'agent.prompt',
        params: { prompt: 'test' },
      } as RpcRequest);

      expect(response).toBeNull();
    });

    it('should accept null id', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: null,
        method: 'agent.status',
      });

      expect(response).toBeDefined();
      expect(response?.id).toBeNull();
    });
  });

  describe('request validation', () => {
    it('should reject method name that is too long', async () => {
      const longMethodName = 'a'.repeat(1025);
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: longMethodName,
      });

      expect(response?.error?.code).toBe(RpcErrorCode.InvalidMethodName);
      expect(response?.error?.message).toContain('too long');
    });

    it('should reject method name with invalid characters', async () => {
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'method with spaces',
      });

      expect(response?.error?.code).toBe(RpcErrorCode.InvalidMethodName);
    });

    it('should accept valid method names', async () => {
      const validMethods = [
        'simple',
        'method.name',
        'method_with_underscore',
        'method-name',
        'method/name',
        'a'.repeat(1024),
      ];

      for (const method of validMethods) {
        const response = await server.handleRequest({
          jsonrpc: '2.0',
          id: '1',
          method,
        });
        // Should not be validation error (could be MethodNotFound if not registered)
        expect(response?.error?.code !== RpcErrorCode.InvalidMethodName).toBe(true);
      }
    });

    it('should reject oversized request', async () => {
      const largeParams = { data: 'x'.repeat(11 * 1024 * 1024) };
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'test',
        params: largeParams,
      });

      expect(response?.error?.code).toBe(RpcErrorCode.RequestTooLarge);
    });
  });

  describe('handleMessage', () => {
    it('should parse and handle valid JSON message', async () => {
      await server.handleMessage(
        '{"jsonrpc":"2.0","id":"1","method":"agent.status"}',
        mockSocket,
        mockSendFn
      );

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].result).toEqual({ status: 'running' });
    });

    it('should handle parse error for invalid JSON', async () => {
      await server.handleMessage('not valid json', mockSocket, mockSendFn);

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].error?.code).toBe(-32700);
      expect(sentMessages[0].id).toBeNull();
    });

    it('should handle empty message', async () => {
      await server.handleMessage('', mockSocket, mockSendFn);

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].error?.code).toBe(-32700);
    });
  });

  describe('batch requests', () => {
    it('should handle empty batch', async () => {
      const results = await server.handleBatch([]);

      expect(results.length).toBe(1);
      expect(results[0]?.error?.code).toBe(-32600);
    });

    it('should handle single item batch', async () => {
      const results = await server.handleBatch([
        { jsonrpc: '2.0', id: '1', method: 'agent.status' },
      ]);

      expect(results.length).toBe(1);
      expect(results[0]?.result).toEqual({ status: 'running' });
    });

    it('should handle multiple requests in batch', async () => {
      const results = await server.handleBatch([
        { jsonrpc: '2.0', id: '1', method: 'agent.status' },
        { jsonrpc: '2.0', id: '2', method: 'tools.list' },
        { jsonrpc: '2.0', id: '3', method: 'agent.prompt' },
      ]);

      expect(results.length).toBe(3);
      expect(results[0]?.result).toEqual({ status: 'running' });
      expect(results[1]?.result).toEqual({ tools: [] });
      expect(results[2]?.result).toEqual({ success: true, prompt: undefined });
    });

    it('should handle mixed results and errors in batch', async () => {
      const results = await server.handleBatch([
        { jsonrpc: '2.0', id: '1', method: 'agent.status' },
        { jsonrpc: '2.0', id: '2', method: 'nonexistent' },
        { jsonrpc: '2.0', id: '3', method: 'tools.execute' },
      ]);

      expect(results[0]?.result).toEqual({ status: 'running' });
      expect(results[1]?.error?.code).toBe(RpcErrorCode.MethodNotFound);
      expect(results[2]?.result).toEqual({ success: true, tool: undefined });
    });

    it('should handle notifications in batch (no response)', async () => {
      const results = await server.handleBatch([
        { jsonrpc: '2.0', id: '1', method: 'agent.status' },
        { jsonrpc: '2.0', method: 'agent.prompt' }, // notification - no id
        { jsonrpc: '2.0', id: '3', method: 'tools.list' },
      ]);

      // Notifications should return null
      expect(results.length).toBe(3);
    });

    it('should use batch index for error id when request has no id', async () => {
      const results = await server.handleBatch([
        { jsonrpc: '2.0', method: 'agent.status' },
      ]);

      expect(results[0]?.id).toBe('batch:0');
    });
  });

  describe('correlationId handling', () => {
    it('should pass correlationId to handler', async () => {
      server.registerMethod('correlation.test', async (params, correlationId) => {
        return { correlationId };
      });

      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'correlation.test',
        params: { correlationId: 'corr-abc' },
      });

      expect(response?.result).toEqual({ correlationId: 'corr-abc' });
    });
  });
});

describe('JsonRpcServer - Error Codes', () => {
  let server: JsonRpcServer;

  beforeEach(() => {
    server = new JsonRpcServer();
  });

  const errorCodeTests = [
    { code: -32601, name: 'MethodNotFound' },
    { code: -32602, name: 'InvalidParams' },
    { code: -32603, name: 'InternalError' },
    { code: -32000, name: 'Timeout' },
    { code: -32001, name: 'ConnectionRefused' },
    { code: -32002, name: 'SessionNotFound' },
    { code: -32003, name: 'RequestTooLarge' },
    { code: -32004, name: 'InvalidMethodName' },
    { code: -32005, name: 'SubagentDead' },
  ];

  errorCodeTests.forEach(({ code, name }) => {
    it(`should have error code for ${name}`, () => {
      expect(RpcErrorCode[name]).toBe(code);
    });
  });
});