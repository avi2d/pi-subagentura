/**
 * Tmux Session Management - Session creation and file-based coordination
 *
 * Manages the session directory structure and coordinates
 * activity writes with exit sidecar for clean completion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TmuxSessionInfo {
	id: string;
	sessionDir: string;
	activityFile: string;
	exitFile: string;
	task: string;
	createdAt: Date;
	contextMode: 'isolated' | 'with_context';
}

export interface TmuxActivityData {
	version: number;
	runningChildId: string;
	phase: 'starting' | 'active' | 'waiting' | 'done' | 'error';
	activeScope: 'idle' | 'prompt' | 'tool' | 'thinking' | 'output';
	toolName?: string;
	latestEvent: string;
	turn?: number;
	outputLength?: number;
	timestamp: string;
	sequence: number;
}

export interface TmuxExitData {
	type: 'done' | 'error' | 'cancelled';
	timestamp: string;
	output?: string;
	errorMessage?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	model?: string;
}

// Activity file helpers
function getActivityFilePath(sessionDir: string): string {
	return path.join(sessionDir, 'activity.json');
}

// Throttled activity writes
const THROTTLE_MS = 500;
let lastWriteTime = 0;
let pendingWrite: TmuxActivityData | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function flushActivity(sessionDir: string, data: TmuxActivityData): void {
	try {
		const activityPath = getActivityFilePath(sessionDir);
		const dir = path.dirname(activityPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(activityPath, JSON.stringify(data, null, 2));
		lastWriteTime = Date.now();
	} catch (e) {
		// Activity is a best-effort signal - log but never throw on the TUI hot path.
		console.error('[tmux-session] activity write failed:', (e as Error).message);
	}
}

export function writeTmuxActivity(
	sessionDir: string,
	data: Partial<TmuxActivityData>
): void {
	const full: TmuxActivityData = {
		version: 1,
		runningChildId: '',
		phase: 'active',
		activeScope: 'idle',
		latestEvent: 'initialized',
		timestamp: new Date().toISOString(),
		sequence: 0,
		...data,
	};

	const now = Date.now();
	const elapsed = now - lastWriteTime;

	if (elapsed < THROTTLE_MS) {
		pendingWrite = full;
		if (!writeTimer) {
			writeTimer = setTimeout(() => {
				if (pendingWrite) {
					flushActivity(sessionDir, pendingWrite);
					pendingWrite = null;
				}
				writeTimer = null;
			}, THROTTLE_MS - elapsed);
		}
		return;
	}

	flushActivity(sessionDir, full);
}

export function flushPendingActivity(sessionDir: string): void {
	if (writeTimer) {
		clearTimeout(writeTimer);
		writeTimer = null;
	}
	if (pendingWrite) {
		flushActivity(sessionDir, pendingWrite);
		pendingWrite = null;
	}
}

// Exit sidecar helpers
export function writeExitSidecar(
	sessionDir: string,
	type: TmuxExitData['type'],
	data: Partial<TmuxExitData> = {}
): void {
	try {
		const exitFile = path.join(sessionDir, 'exit.json');
		const dir = path.dirname(exitFile);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const exitData: TmuxExitData = {
			type,
			timestamp: new Date().toISOString(),
			...data,
		};
		// Atomic write: write to temp, then rename so the parent never sees
		// a half-written JSON when polling the file.
		const tempFile = `${exitFile}.tmp`;
		fs.writeFileSync(tempFile, JSON.stringify(exitData, null, 2));
		fs.renameSync(tempFile, exitFile);
	} catch (e) {
		// The exit sidecar is the contract with the parent. A failed write means
		// the parent will never see a completion signal, so log loudly.
		console.error(
			`[tmux-session] CRITICAL: failed to write exit sidecar in ${sessionDir}:`,
			(e as Error).message
		);
	}
}

export function peekExitSidecar(sessionDir: string): TmuxExitData | null {
	const exitFile = path.join(sessionDir, 'exit.json');
	try {
		if (fs.existsSync(exitFile)) {
			const content = fs.readFileSync(exitFile, 'utf-8');
			return JSON.parse(content) as TmuxExitData;
		}
	} catch (e) {
		console.error('[tmux-session] peekExitSidecar failed:', (e as Error).message);
	}
	return null;
}

export function consumeExitSidecar(sessionDir: string): TmuxExitData | null {
	const exitFile = path.join(sessionDir, 'exit.json');
	try {
		if (fs.existsSync(exitFile)) {
			const content = fs.readFileSync(exitFile, 'utf-8');
			fs.unlinkSync(exitFile);
			return JSON.parse(content) as TmuxExitData;
		}
	} catch (e) {
		console.error('[tmux-session] consumeExitSidecar failed:', (e as Error).message);
	}
	return null;
}

// Session creation
export function createTmuxSession(
	id: string,
	task: string,
	contextMode: 'isolated' | 'with_context'
): TmuxSessionInfo {
	const sessionDir = path.join('/tmp/pi-subagents', id);

	// Create directory
	fs.mkdirSync(sessionDir, { recursive: true });

	const info: TmuxSessionInfo = {
		id,
		sessionDir,
		activityFile: getActivityFilePath(sessionDir),
		exitFile: path.join(sessionDir, 'exit.json'),
		task,
		createdAt: new Date(),
		contextMode,
	};

	// Initialize activity
	writeTmuxActivity(sessionDir, {
		runningChildId: id,
		phase: 'starting',
		activeScope: 'idle',
		latestEvent: 'session_created',
	});

	return info;
}

export function readTmuxActivity(session: TmuxSessionInfo): TmuxActivityData | null {
	try {
		if (fs.existsSync(session.activityFile)) {
			return JSON.parse(fs.readFileSync(session.activityFile, 'utf-8')) as TmuxActivityData;
		}
	} catch (e) {
		console.error('[tmux-session] readTmuxActivity failed:', (e as Error).message);
	}
	return null;
}

export function cleanupTmuxSession(session: TmuxSessionInfo): void {
	try {
		const files = [
			session.activityFile,
			session.exitFile,
			path.join(session.sessionDir, 'done'),
		];
		for (const file of files) {
			if (fs.existsSync(file)) {
				fs.unlinkSync(file);
			}
		}
	} catch (e) {
		// Cleanup errors are best-effort; the OS will reap /tmp eventually.
		console.error('[tmux-session] cleanupTmuxSession failed:', (e as Error).message);
	}
}
