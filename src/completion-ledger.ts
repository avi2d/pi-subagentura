import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join, parse, resolve, sep } from "node:path";
// macOS exposes these two stable system aliases; every other parent symlink fails closed.

function darwinRootAlias(
  root: string,
  current: string,
  next: string,
  part: string,
): string | undefined {
  if (process.platform !== "darwin" || current !== root) return undefined;
  if (part !== "tmp" && part !== "var") {
    return undefined;
  }
  const canonical = `/private/${part}`;
  return realpathSync(next) === canonical ? canonical : undefined;
}

export interface LedgerReadResult {
  lines: string[];
  truncated: boolean;
}

export interface LedgerAppendResult {
  ok: boolean;
  dropped: number;
}

function ensureLedgerParent(path: string): void {
  const parent = dirname(resolve(path));
  const root = parse(parent).root;
  const relative = parent.slice(root.length);
  let current = root;
  for (const part of relative.split(sep).filter(Boolean)) {
    const next = join(current, part);
    try {
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) {
        const alias = darwinRootAlias(root, current, next, part);
        if (alias) {
          current = alias;
          continue;
        }
        throw new Error(`Ledger parent is not a directory: ${next}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Ledger parent is not a directory: ${next}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(next, { mode: 0o700 });
      const stat = lstatSync(next);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Ledger parent is not a directory: ${next}`);
      }
    }
    if (part === ".pi") chmodSync(next, 0o700);
    current = next;
  }
}

function noFollow(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function assertRegularLedger(path: string): void {
  const linkStat = lstatSync(path);
  if (!linkStat.isFile())
    throw new Error(`Ledger is not a regular file: ${path}`);
}

function openLedger(path: string, flags: number, mode?: number): number {
  ensureLedgerParent(path);
  try {
    assertRegularLedger(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(path, flags | noFollow(), mode);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new Error(`Ledger is not a regular file: ${path}`);
  }
  fchmodSync(fd, 0o600);
  return fd;
}

export function sessionLedgerPath(
  cwd: string,
  sessionId: string | undefined,
  name: string,
): string {
  const identity = sessionId ?? "unknown-session";
  const suffix = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 16);
  return join(cwd, ".pi", `${name}-${suffix}.ndjson`);
}

export function readLedgerLines(
  path: string,
  maxBytes: number,
): LedgerReadResult {
  let fd: number | undefined;
  try {
    fd = openLedger(path, constants.O_RDONLY);
    const stat = fstatSync(fd);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(
        fd,
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (read <= 0) break;
      offset += read;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    const truncated = start > 0;
    if (truncated) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    }
    return {
      lines: text.split("\n").filter(Boolean),
      truncated,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], truncated: false };
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeLedger(path: string, lines: string[]): void {
  ensureLedgerParent(path);
  try {
    assertRegularLedger(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    );
    const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    writeSync(fd, content, undefined, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* The temporary file may have been renamed successfully. */
    }
  }
  try {
    assertRegularLedger(path);
  } catch {
    throw new Error(`Ledger rename did not produce a regular file: ${path}`);
  }
}

export function appendLedgerLine(
  path: string,
  line: string,
  limits: { maxRecords: number; maxBytes: number },
): LedgerAppendResult {
  const loaded = readLedgerLines(path, limits.maxBytes);
  const lines = [...loaded.lines, line];
  let dropped = loaded.truncated ? 1 : 0;
  while (
    lines.length > limits.maxRecords ||
    Buffer.byteLength(`${lines.join("\n")}\n`, "utf8") > limits.maxBytes
  ) {
    lines.shift();
    dropped++;
  }
  writeLedger(path, lines);
  return { ok: true, dropped };
}

export function appendLedgerLineLossless(path: string, line: string): void {
  let fd: number | undefined;
  try {
    fd = openLedger(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      0o600,
    );
    const content = `${line}\n`;
    let offset = 0;
    while (offset < content.length) {
      const written = writeSync(fd, content.slice(offset), undefined, "utf8");
      if (written <= 0)
        throw new Error(`Ledger write made no progress: ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function scanLedgerLines(
  path: string,
  maxLineBytes: number,
  onLine: (line: string) => void,
): void {
  let fd: number | undefined;
  try {
    fd = openLedger(path, constants.O_RDONLY);
    const chunk = Buffer.alloc(64 * 1024);
    let carry = "";
    let dropping = false;
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead <= 0) break;
      carry += chunk.subarray(0, bytesRead).toString("utf8");
      for (;;) {
        const newline = carry.indexOf("\n");
        if (newline < 0) break;
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (!dropping) onLine(line);
        dropping = false;
      }
      if (!dropping && Buffer.byteLength(carry, "utf8") > maxLineBytes) {
        carry = "";
        dropping = true;
      }
    }
    if (!dropping && carry) onLine(carry);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
