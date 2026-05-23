/**
 * Tmux Agent Mode - Unix Socket Server Infrastructure
 *
 * Provides the core socket server for parent↔subagent communication when
 * pi is invoked in tmux mode. Handles JSON-RPC 2.0 message routing.
 *
 * Protocol:
 *   - Parent → Subagent: task, abort, ping
 *   - Subagent → Parent: progress, result, error
 */

import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { mkdir, rm, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

/** JSON-RPC 2.0 incoming request from parent */
export interface RpcIncomingRequest {
	jsonrpc: "2.0";
	method: string;
	params: {
		task?: string;
		context?: Record<string, unknown>;
		[key: string]: unknown;
	};
	id: number | string | null;
}

/** JSON-RPC 2.0 incoming notification (no id) */
export interface RpcIncomingNotification {
	jsonrpc: "2.0";
	method: string;
	params: Record<string, unknown>;
}

/** Union for all incoming messages */
export type RpcIncomingMessage = RpcIncomingRequest | RpcIncomingNotification;

/** JSON-RPC 2.0 success response */
export interface RpcSuccessResponse {
	jsonrpc: "2.0";
	result: unknown;
	id: number | string | null;
}

/** JSON-RPC 2.0 error response */
export interface RpcErrorResponse {
	jsonrpc: "2.0";
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
	id: number | string | null;
}

/** Notification sent to parent (no id field) */
export interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params: Record<string, unknown>;
}

/** Union for all outgoing messages */
export type RpcOutgoingMessage = RpcSuccessResponse | RpcErrorResponse | RpcNotification;

/** Progress notification sent to parent */
export interface ProgressParams {
	output: string;
	tool?: string;
	turn: number;
}

/** Result response sent to parent */
export interface ResultParams {
	output: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	isError: boolean;
}

/** Error response sent to parent */
export interface ErrorParams {
	message: string;
}

/** Message handler invoked for each parsed JSON-RPC message */
export type MessageHandler = (message: RpcIncomingMessage) => void;

/** Socket server configuration */
export interface SocketServer {
	/** Path to the Unix domain socket */
	readonly socketPath: string;

	/** Path to the readiness marker file */
	readonly readyFilePath: string;

	/**
	 * Send a progress notification to the parent agent.
	 * @param output - Text output from this turn
	 * @param tool - Optional active tool name
	 * @param turn - Current turn number
	 */
	sendProgress(output: string, tool?: string, turn?: number): void;

	/**
	 * Send a result response to the parent agent.
	 * @param output - Final output text
	 * @param usage - Token usage statistics
	 * @param isError - Whether this is an error result
	 * @param id - Request ID to respond to
	 */
	sendResult(output: string, usage: ResultParams["usage"], isError: boolean, id: number | string | null): void;

	/**
	 * Send an error response to the parent agent.
	 * @param message - Error message
	 * @param id - Request ID to respond to
	 */
	sendError(message: string, id: number | string | null): void;

	/**
	 * Send a task request to the subagent.
	 * @param task - The task description
	 * @param id - Request ID
	 */
	sendTask(task: string, id?: number | string | null): void;

	/**
	 * Send a completion request to the subagent.
	 * Tells the agent to finalize and send its result, but keep running.
	 * @param id - Request ID
	 */
	sendComplete(id?: number | string | null): void;

	/**
	 * Register a handler for incoming messages from the subagent.
	 */
	onMessage: MessageHandler | null;

	/**
	 * Close the server, socket, and cleanup resources.
	 * Removes the socket file and readiness marker.
	 */
	close(): Promise<void>;
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Per-user socket directory prefix */
const SOCKET_DIR_PREFIX = "/tmp/pi-";

/** Socket filename suffix */
const SOCKET_SUFFIX = ".sock";

/** Readiness marker filename */
const READY_FILENAME = ".ready";

/** Socket permissions: user read/write only */
const SOCKET_MODE = 0o600;

// ── Implementation ─────────────────────────────────────────────────────────

/**
 * Create a Unix domain socket server for tmux-agent communication.
 *
 * @param uuid - Unique identifier for this agent session
 * @param cwd - Working directory (used to derive socket path user)
 * @param onMessage - Optional handler for incoming JSON-RPC messages
 * @returns Promise resolving to configured SocketServer instance
 *
 * @example
 * ```typescript
 * const server = await createSocketServer(generateUUID(), process.cwd());
 * // Server is now listening and ready for connections
 * ```
 */
export async function createSocketServer(
	uuid: string,
	cwd: string,
	onMessage?: MessageHandler,
): Promise<SocketServer> {
	const uid = process.getuid?.() ?? 1000;
	const socketDir = `${SOCKET_DIR_PREFIX}${uid}`;
	const socketFilename = `agent-${uuid}${SOCKET_SUFFIX}`;
	const socketPath = join(socketDir, socketFilename);
	const readyFilePath = join(socketDir, READY_FILENAME);

	let server: NetServer | null = null;
	let socket: Socket | null = null;
	const messageHandler: MessageHandler | null = onMessage ?? null;
	let isClosed = false;

	// Accumulate message data until we have a complete JSON object
	let messageBuffer = "";

	/**
	 * Send a JSON-RPC message over the socket.
	 * Silently ignores if socket is not yet connected.
	 */
	const sendMessage = (message: RpcOutgoingMessage): void => {
		if (!socket || !socket.writable) return;
		try {
			socket.write(JSON.stringify(message) + "\n");
		} catch {
			// Socket write errors are ignored during cleanup
		}
	};

	/**
	 * Handle incoming socket data.
	 * Accumulates bytes and splits on newlines to parse complete JSON messages.
	 */
	const onData = (data: Buffer): void => {
		if (isClosed) return;

		messageBuffer += data.toString("utf8");
		const lines = messageBuffer.split("\n");
		// Keep the last partial line in the buffer
		messageBuffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const message = JSON.parse(line) as RpcIncomingMessage;
				messageHandler?.(message);
			} catch (parseErr) {
				// Send JSON parse error response, but continue processing
				sendMessage({
					jsonrpc: "2.0",
					error: {
						code: -32700,
						message: "Parse error",
						data: String(parseErr),
					},
					id: null,
				});
			}
		}
	};

	/**
	 * Handle socket errors - log but don't throw to keep server alive.
	 */
	const onError = (err: Error): void => {
		// Only log if we haven't initiated close ourselves
		if (!isClosed) {
			console.error("[tmux-agent] socket error:", err.message);
		}
	};

	/**
	 * Handle socket close - socket cleanup is managed by close()
	 */
	const onClose = (): void => {
		socket = null;
	};

	/**
	 * Create and configure the net.Server instance.
	 */
	const createServer = (): Promise<NetServer> => {
		return new Promise((resolve, reject) => {
			const s = createNetServer((conn) => {
				// Take ownership of the first connected client
				// Subsequent connections are rejected until this one closes
				if (socket) {
					try {
						conn.destroy();
					} catch {
						// Ignore destroy errors
					}
					return;
				}

				socket = conn;
				socket.on("data", onData);
				socket.on("error", onError);
				socket.on("close", onClose);
			});

			s.on("error", (err) => {
				reject(err);
			});

			s.listen(socketPath, () => {
				resolve(s);
			});
		});
	};

	// Create socket directory with strict permissions
	await mkdir(socketDir, { mode: 0o700, recursive: true });

	// Create and start the server
	server = await createServer();

	// Set socket file permissions to user-only
	try {
		await chmod(socketPath, SOCKET_MODE);
	} catch {
		// chmod may not be available on all systems - continue anyway
	}

	// Write readiness marker
	await writeFile(readyFilePath, socketPath, { mode: SOCKET_MODE });

	// Return the SocketServer interface
	return {
		get socketPath() {
			return socketPath;
		},

		get readyFilePath() {
			return readyFilePath;
		},

		onMessage: messageHandler as MessageHandler | null,

		sendProgress(output: string, tool?: string, turn: number = 1): void {
			sendMessage({
				jsonrpc: "2.0",
				method: "progress",
				params: { output, tool, turn } as unknown as Record<string, unknown>,
			});
		},

		sendResult(
			output: string,
			usage: ResultParams["usage"],
			isError: boolean,
			id: number | string | null,
		): void {
			sendMessage({
				jsonrpc: "2.0",
				result: { output, usage, isError } as unknown as Record<string, unknown>,
				id,
			});
		},

		sendError(message: string, id: number | string | null): void {
			sendMessage({
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message,
				},
				id,
			});
		},

		sendTask(task: string, id: number | string | null = null): void {
			sendMessage({
				jsonrpc: "2.0",
				method: "task",
				params: { task } as unknown as Record<string, unknown>,
				id,
			});
		},

		sendComplete(id: number | string | null = null): void {
			sendMessage({
				jsonrpc: "2.0",
				method: "complete",
				params: undefined,
				id,
			});
		},

		async close(): Promise<void> {
			if (isClosed) return;
			isClosed = true;

			// Remove readiness marker first
			try {
				await unlink(readyFilePath);
			} catch {
				// File may not exist if not yet written
			}

			// Destroy socket connection if open
			if (socket) {
				try {
					socket.destroy();
				} catch {
					// Ignore destroy errors during cleanup
				}
				socket = null;
			}

			// Close server
			if (server) {
				await new Promise<void>((resolve) => {
					server!.close(() => resolve());
				});
				server = null;
			}

			// Remove socket file
			try {
				await rm(socketPath, { force: true });
			} catch {
				// Socket file may already be cleaned up by OS
			}
		},
	};
}