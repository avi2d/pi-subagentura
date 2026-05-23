import { 
  RpcRequest, 
  RpcResponse, 
  RpcNotification,
  RpcErrorCode,
  RPC_CONSTANTS 
} from './types.js';

type MethodHandler = (params?: Record<string, unknown>, correlationId?: string) => Promise<unknown>;

export class JsonRpcServer {
  private methodRegistry: Map<string, MethodHandler> = new Map();
  private pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  constructor() {
    this.registerDefaultMethods();
  }

  private registerDefaultMethods(): void {
    // Agent methods - these would be connected to actual agent logic
    this.registerMethod('agent.prompt', async (params) => {
      return { success: true, prompt: params?.prompt };
    });

    this.registerMethod('agent.status', async () => {
      return { status: 'running' };
    });

    this.registerMethod('tools.list', async () => {
      return { tools: [] }; // Would return actual exposed tools
    });

    this.registerMethod('tools.execute', async (params) => {
      return { success: true, tool: params?.name };
    });

    // System methods
    this.registerMethod('session.shutdown', async (params, correlationId) => {
      // Return acknowledgment - actual shutdown handled by caller
      return { acknowledged: true, correlationId };
    });

    this.registerMethod('session.heartbeat', async (params) => {
      return { seq: params?.seq };
    });
  }

  registerMethod(name: string, handler: MethodHandler): void {
    this.methodRegistry.set(name, handler);
  }

  registerMethods(methods: Record<string, MethodHandler>): void {
    for (const [name, handler] of Object.entries(methods)) {
      this.registerMethod(name, handler);
    }
  }

  // Handle incoming request from a socket
  async handleMessage(data: string, socket: any, sendFn: (msg: RpcResponse) => void): Promise<void> {
    try {
      const parsed = JSON.parse(data);
      
      // Handle batch request
      if (Array.isArray(parsed)) {
        const results = await this.handleBatch(parsed);
        for (const result of results) {
          if (result) { // Skip notifications
            sendFn(result);
          }
        }
        return;
      }

      // Handle single request
      const response = await this.handleRequest(parsed);
      if (response) {
        sendFn(response);
      }
    } catch (err) {
      // Parse error
      const errorResponse: RpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      };
      sendFn(errorResponse);
    }
  }

  async handleRequest(request: RpcRequest): Promise<RpcResponse | null> {
    // Validate request (S-3)
    const validationError = this.validateRequest(request);
    if (validationError) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: validationError.code, message: validationError.message }
      };
    }

    // Handle notification (no response needed)
    if (request.id === undefined) {
      const handler = this.methodRegistry.get(request.method);
      if (handler) {
        handler(request.params).catch(() => {}); // Fire and forget for notifications
      }
      return null;
    }

    // Find method handler
    const handler = this.methodRegistry.get(request.method);
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: RpcErrorCode.MethodNotFound, message: `Method not found: ${request.method}` }
      };
    }

    try {
      const result = await handler(request.params, request.params?.correlationId as string);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: RpcErrorCode.InternalError,
          message: err instanceof Error ? err.message : "Internal error"
        }
      };
    }
  }

  async handleBatch(requests: RpcRequest[]): Promise<(RpcResponse | null)[]> {
    // Empty batch returns InvalidRequest per JSON-RPC 2.0 spec (M-3)
    if (requests.length === 0) {
      return [{
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid batch request" }
      }];
    }

    // Enforce batch size limit to prevent DoS
    if (requests.length > RPC_CONSTANTS.MAX_BATCH_SIZE) {
      return [{
        jsonrpc: "2.0",
        id: null,
        error: { code: RpcErrorCode.RequestTooLarge, message: `Batch too large: ${requests.length} items` }
      }];
    }

    // Process all requests in order, handle errors per-item
    const results: (RpcResponse | null)[] = [];
    for (let i = 0; i < requests.length; i++) {
      try {
        const result = await this.handleRequest(requests[i]);
        // For notifications that return null, assign synthetic batch id if needed
        if (result === null && requests[i].id === undefined) {
          results.push({
            jsonrpc: "2.0",
            id: `batch:${i}`
          });
        } else {
          results.push(result);
        }
      } catch (err) {
        results.push({
          jsonrpc: "2.0",
          id: requests[i].id ?? `batch:${i}`,
          error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" }
        });
      }
    }
    return results;
  }

  private validateRequest(request: RpcRequest): { code: number; message: string } | null {
    // Validate JSON string length
    try {
      const serialized = JSON.stringify(request);
      if (serialized.length > RPC_CONSTANTS.MAX_REQUEST_SIZE) {
        return { code: RpcErrorCode.RequestTooLarge, message: "Request exceeds maximum size" };
      }
    } catch {
      return { code: -32700, message: "Parse error" };
    }

    // Validate method name length
    if (request.method.length > RPC_CONSTANTS.MAX_STRING_LENGTH) {
      return { code: RpcErrorCode.InvalidMethodName, message: "Method name too long" };
    }

    // Validate method name characters (basic sanity check)
    if (!/^[a-zA-Z0-9._/-]+$/.test(request.method)) {
      return { code: RpcErrorCode.InvalidMethodName, message: "Invalid method name characters" };
    }

    return null;
  }

  // For making outbound calls (parent to subagent)
  async call(socket: any, method: string, params?: Record<string, unknown>, timeout = 30000): Promise<unknown> {
    const id = Math.random().toString(36).substring(7);
    const correlationId = params?.correlationId as string || id;
    
    const request: RpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, correlationId }
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC call timeout: ${method}`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout: timer });

      // Send request
      socket.write(JSON.stringify(request) + '\n');
    });
  }
}