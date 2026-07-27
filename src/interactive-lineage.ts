import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  promises as fs,
} from "node:fs";
import path from "node:path";

export const LINEAGE_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_MANIFEST_BYTES = 16 * 1024;
export const DEFAULT_MAX_STRING_BYTES = 2048;
export const DEFAULT_MAX_TASK_PREVIEW_BYTES = 4096;
export const DEFAULT_MAX_NODES = 256;
export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_PROJECTION_BYTES = 512 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_HEX = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

export interface LineagePaneRef {
  backend: string;
  paneId: string;
  muxSession?: string;
  windowName?: string;
}

export interface LineageManifest {
  schemaVersion: typeof LINEAGE_SCHEMA_VERSION;
  agentId: string;
  parentAgentId?: string;
  rootId: string;
  rootHash: string;
  ownerSessionId: string;
  name: string;
  taskPreview: string;
  startedAt: string;
  cwd: string;
  pane: LineagePaneRef;
  artifactDir?: string;
  childSessionFile?: string;
}

export interface LineageBounds {
  maxManifestBytes: number;
  maxStringBytes: number;
  maxTaskPreviewBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxProjectionBytes: number;
}

export interface LineageStorePaths {
  treeDir: string;
  rootPath: string;
  nodesDir: string;
}

export type ProjectionIssueKind =
  "cycle" | "malformed" | "orphan" | "stale" | "truncated";

export interface ProjectionIssue {
  kind: ProjectionIssueKind;
  agentId?: string;
  path?: string;
  reason: string;
}

export type ProjectedNodeState = "actionable" | "non-actionable";

export interface ProjectedLineageNode {
  manifest: LineageManifest;
  depth: number;
  state: ProjectedNodeState;
  reasons: ProjectionIssueKind[];
  children: ProjectedLineageNode[];
}

export interface LineageProjection {
  rootHash: string;
  roots: ProjectedLineageNode[];
  nonActionable: ProjectedLineageNode[];
  issues: ProjectionIssue[];
  truncated: boolean;
}

export interface CancelLineageNodeResult {
  agentId: string;
  status: "cancelled" | "already-terminal" | "stale" | "failed";
  error?: string;
}

export interface CancelSubtreeResult {
  attempted: CancelLineageNodeResult[];
  cancelled: string[];
  alreadyTerminal: string[];
  stale: string[];
  failed: CancelLineageNodeResult[];
}

export interface CancelSubtreeCallbacks {
  isTerminal(node: ProjectedLineageNode): boolean | Promise<boolean>;
  isStale(node: ProjectedLineageNode): boolean | Promise<boolean>;
  cancel(node: ProjectedLineageNode): void | Promise<void>;
}

export function lineageBounds(
  overrides: Partial<LineageBounds> = {},
): LineageBounds {
  return {
    maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
    maxStringBytes: DEFAULT_MAX_STRING_BYTES,
    maxTaskPreviewBytes: DEFAULT_MAX_TASK_PREVIEW_BYTES,
    maxNodes: DEFAULT_MAX_NODES,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxProjectionBytes: DEFAULT_MAX_PROJECTION_BYTES,
    ...overrides,
  };
}

export function hashLineageRoot(rootId: string): string {
  assertBoundedString(rootId, "rootId", DEFAULT_MAX_STRING_BYTES);
  return createHash("sha256").update(rootId).digest("hex");
}

export async function resolveLineageStorePaths(
  sessionRoot: string,
  rootId: string,
): Promise<LineageStorePaths> {
  // Match sync twin: create the session root before realpath so a fresh
  // install does not reject with ENOENT (swallowed by the supervisor load
  // path into a silent direct-children-only degrade).
  await fs.mkdir(sessionRoot, { recursive: true });
  const safeSessionRoot = await resolveContainedRealPath(
    sessionRoot,
    sessionRoot,
  );
  const rootHash = hashLineageRoot(rootId);
  const treeDir = path.join(safeSessionRoot, "subagentura", "trees", rootHash);
  await assertPathHasNoSymlinkEscape(safeSessionRoot, treeDir);
  return {
    treeDir,
    rootPath: path.join(treeDir, "root.json"),
    nodesDir: path.join(treeDir, "nodes"),
  };
}

export function resolveLineageStorePathsSync(
  sessionRoot: string,
  rootId: string,
): LineageStorePaths {
  mkdirSync(sessionRoot, { recursive: true });
  const safeSessionRoot = realpathSync(sessionRoot);
  const rootHash = hashLineageRoot(rootId);
  const treeDir = path.join(safeSessionRoot, "subagentura", "trees", rootHash);
  assertPathHasNoSymlinkEscapeSync(safeSessionRoot, treeDir);
  return {
    treeDir,
    rootPath: path.join(treeDir, "root.json"),
    nodesDir: path.join(treeDir, "nodes"),
  };
}

export async function safeContainedPath(
  root: string,
  candidate: string,
): Promise<string> {
  // Return the root's real-path form so callers get the same value whether the
  // input used a platform alias such as macOS /var or its /private/var target.
  return resolveContainedRealPath(root, candidate);
}

export function nodeManifestPath(nodesDir: string, agentId: string): string {
  assertSafeId(agentId, "agentId");
  return path.join(nodesDir, `${agentId}.json`);
}

export async function writeLineageManifestAtomic(
  nodesDir: string,
  manifest: LineageManifest,
  bounds: Partial<LineageBounds> = {},
): Promise<string> {
  const effectiveBounds = lineageBounds(bounds);
  const validated = validateLineageManifest(manifest, effectiveBounds);
  const filePath = nodeManifestPath(nodesDir, validated.agentId);
  await fs.mkdir(nodesDir, { recursive: true });
  const data = `${JSON.stringify(validated, stableJsonReplacer, 2)}\n`;
  if (Buffer.byteLength(data) > effectiveBounds.maxManifestBytes) {
    throw new Error("lineage manifest exceeds byte limit");
  }
  const tmpPath = path.join(
    nodesDir,
    `.${validated.agentId}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tmpPath, data, { mode: 0o600 });
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
  return filePath;
}

export function writeLineageManifestAtomicSync(
  nodesDir: string,
  manifest: LineageManifest,
  bounds: Partial<LineageBounds> = {},
): string {
  const effectiveBounds = lineageBounds(bounds);
  const validated = validateLineageManifest(manifest, effectiveBounds);
  const filePath = nodeManifestPath(nodesDir, validated.agentId);
  mkdirSync(nodesDir, { recursive: true });
  const data = `${JSON.stringify(validated, stableJsonReplacer, 2)}\n`;
  if (Buffer.byteLength(data) > effectiveBounds.maxManifestBytes) {
    throw new Error("lineage manifest exceeds byte limit");
  }
  const tmpPath = path.join(
    nodesDir,
    `.${validated.agentId}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  writeFileSync(tmpPath, data, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return filePath;
}

export function validateLineageManifest(
  value: unknown,
  bounds: Partial<LineageBounds> = {},
): LineageManifest {
  const effectiveBounds = lineageBounds(bounds);
  if (!isRecord(value)) {
    throw new Error("lineage manifest must be an object");
  }
  const allowed = new Set([
    "schemaVersion",
    "agentId",
    "parentAgentId",
    "rootId",
    "rootHash",
    "ownerSessionId",
    "name",
    "taskPreview",
    "startedAt",
    "cwd",
    "pane",
    "artifactDir",
    "childSessionFile",
  ]);
  rejectUnknownKeys(value, allowed, "lineage manifest");
  const schemaVersion = expectNumber(value.schemaVersion, "schemaVersion");
  if (schemaVersion !== LINEAGE_SCHEMA_VERSION) {
    throw new Error("unsupported lineage manifest schemaVersion");
  }
  const agentId = expectSafeId(value.agentId, "agentId");
  const parentAgentId = optionalSafeId(value.parentAgentId, "parentAgentId");
  const rootId = expectBoundedString(
    value.rootId,
    "rootId",
    effectiveBounds.maxStringBytes,
  );
  const rootHash = expectBoundedString(value.rootHash, "rootHash", 64);
  if (!HASH_HEX.test(rootHash) || rootHash !== hashLineageRoot(rootId)) {
    throw new Error("lineage manifest rootHash does not match rootId");
  }
  const ownerSessionId = expectBoundedString(
    value.ownerSessionId,
    "ownerSessionId",
    effectiveBounds.maxStringBytes,
  );
  const name = expectBoundedString(
    value.name,
    "name",
    effectiveBounds.maxStringBytes,
  );
  const taskPreview = expectBoundedString(
    value.taskPreview,
    "taskPreview",
    effectiveBounds.maxTaskPreviewBytes,
  );
  const startedAt = expectBoundedString(
    value.startedAt,
    "startedAt",
    effectiveBounds.maxStringBytes,
  );
  if (Number.isNaN(Date.parse(startedAt))) {
    throw new Error("lineage manifest startedAt must be an ISO date string");
  }
  const cwd = expectBoundedString(
    value.cwd,
    "cwd",
    effectiveBounds.maxStringBytes,
  );
  const artifactDir = optionalBoundedString(
    value.artifactDir,
    "artifactDir",
    effectiveBounds.maxStringBytes,
  );
  const childSessionFile = optionalBoundedString(
    value.childSessionFile,
    "childSessionFile",
    effectiveBounds.maxStringBytes,
  );
  const pane = validatePaneRef(value.pane, effectiveBounds);
  return {
    schemaVersion,
    agentId,
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
    rootId,
    rootHash,
    ownerSessionId,
    name,
    taskPreview,
    startedAt,
    cwd,
    pane,
    ...(artifactDir === undefined ? {} : { artifactDir }),
    ...(childSessionFile === undefined ? {} : { childSessionFile }),
  };
}

export async function readLineageManifest(
  filePath: string,
  bounds: Partial<LineageBounds> = {},
): Promise<LineageManifest> {
  const effectiveBounds = lineageBounds(bounds);
  const data = await readBoundedFile(
    filePath,
    effectiveBounds.maxManifestBytes,
  );
  const parsed = JSON.parse(data) as unknown;
  return validateLineageManifest(parsed, effectiveBounds);
}

export async function projectLineageStore(
  nodesDir: string,
  rootHash: string,
  isNodeStale: (manifest: LineageManifest) => boolean | Promise<boolean>,
  bounds: Partial<LineageBounds> = {},
): Promise<LineageProjection> {
  const effectiveBounds = lineageBounds(bounds);
  if (!HASH_HEX.test(rootHash)) {
    throw new Error("rootHash must be a sha256 hex digest");
  }
  const issues: ProjectionIssue[] = [];
  const manifests = new Map<string, LineageManifest>();
  const paths = await listManifestPaths(nodesDir, effectiveBounds);
  let consumedBytes = 0;
  for (const manifestPath of paths) {
    if (manifests.size >= effectiveBounds.maxNodes) {
      issues.push({
        kind: "truncated",
        path: manifestPath,
        reason: "node cap reached",
      });
      break;
    }
    try {
      const data = await readBoundedFile(
        manifestPath,
        effectiveBounds.maxManifestBytes,
      );
      consumedBytes += Buffer.byteLength(data);
      if (consumedBytes > effectiveBounds.maxProjectionBytes) {
        issues.push({
          kind: "truncated",
          path: manifestPath,
          reason: "projection byte cap reached",
        });
        break;
      }
      const manifest = validateLineageManifest(
        JSON.parse(data),
        effectiveBounds,
      );
      if (manifest.rootHash !== rootHash) {
        continue;
      }
      if (manifests.has(manifest.agentId)) {
        issues.push({
          kind: "malformed",
          agentId: manifest.agentId,
          path: manifestPath,
          reason: "duplicate agentId",
        });
        continue;
      }
      manifests.set(manifest.agentId, manifest);
    } catch (error) {
      issues.push({
        kind: "malformed",
        path: manifestPath,
        reason: errorMessage(error),
      });
    }
  }
  return await projectManifests(
    [...manifests.values()],
    rootHash,
    isNodeStale,
    {
      ...effectiveBounds,
      issues,
    },
  );
}

export async function projectManifests(
  manifests: LineageManifest[],
  rootHash: string,
  isNodeStale: (manifest: LineageManifest) => boolean | Promise<boolean> = () =>
    false,
  options: Partial<LineageBounds> & { issues?: ProjectionIssue[] } = {},
): Promise<LineageProjection> {
  const effectiveBounds = lineageBounds(options);
  const issues = [...(options.issues ?? [])];
  const byId = new Map<string, LineageManifest>();
  const nonActionableIds = new Map<string, Set<ProjectionIssueKind>>();
  const addReason = (agentId: string, reason: ProjectionIssueKind): void => {
    const reasons =
      nonActionableIds.get(agentId) ?? new Set<ProjectionIssueKind>();
    reasons.add(reason);
    nonActionableIds.set(agentId, reasons);
  };

  for (const manifest of manifests
    .filter((manifest) => manifest.rootHash === rootHash)
    .sort(compareManifest)) {
    if (byId.size >= effectiveBounds.maxNodes) {
      issues.push({
        kind: "truncated",
        agentId: manifest.agentId,
        reason: "node cap reached",
      });
      continue;
    }
    if (byId.has(manifest.agentId)) {
      issues.push({
        kind: "malformed",
        agentId: manifest.agentId,
        reason: "duplicate agentId",
      });
      addReason(manifest.agentId, "malformed");
      continue;
    }
    byId.set(manifest.agentId, manifest);
  }

  for (const manifest of byId.values()) {
    if (manifest.parentAgentId && !byId.has(manifest.parentAgentId)) {
      issues.push({
        kind: "orphan",
        agentId: manifest.agentId,
        reason: "parent manifest missing",
      });
      addReason(manifest.agentId, "orphan");
    }
    if (await isNodeStale(manifest)) {
      issues.push({
        kind: "stale",
        agentId: manifest.agentId,
        reason: "node is stale",
      });
      addReason(manifest.agentId, "stale");
    }
  }

  const children = new Map<string, LineageManifest[]>();
  const roots: LineageManifest[] = [];
  for (const manifest of byId.values()) {
    if (!manifest.parentAgentId || !byId.has(manifest.parentAgentId)) {
      roots.push(manifest);
      continue;
    }
    const siblings = children.get(manifest.parentAgentId) ?? [];
    siblings.push(manifest);
    children.set(manifest.parentAgentId, siblings);
  }
  roots.sort((left, right) => {
    const leftOrphan =
      nonActionableIds.get(left.agentId)?.has("orphan") ?? false;
    const rightOrphan =
      nonActionableIds.get(right.agentId)?.has("orphan") ?? false;
    if (leftOrphan !== rightOrphan) {
      return leftOrphan ? 1 : -1;
    }
    return compareManifest(left, right);
  });
  for (const siblings of children.values()) {
    siblings.sort(compareManifest);
  }

  const built = new Map<string, ProjectedLineageNode>();
  const build = (
    manifest: LineageManifest,
    depth: number,
    stack: Set<string>,
  ): ProjectedLineageNode => {
    const reasonSet = new Set(nonActionableIds.get(manifest.agentId) ?? []);
    if (depth > effectiveBounds.maxDepth) {
      reasonSet.add("truncated");
      issues.push({
        kind: "truncated",
        agentId: manifest.agentId,
        reason: "depth cap reached",
      });
    }
    if (stack.has(manifest.agentId)) {
      reasonSet.add("cycle");
      issues.push({
        kind: "cycle",
        agentId: manifest.agentId,
        reason: "cycle detected",
      });
      return makeNode(manifest, depth, reasonSet, []);
    }
    const childStack = new Set(stack);
    childStack.add(manifest.agentId);
    const directChildren = children.get(manifest.agentId) ?? [];
    if (depth >= effectiveBounds.maxDepth && directChildren.length > 0) {
      reasonSet.add("truncated");
      issues.push({
        kind: "truncated",
        agentId: manifest.agentId,
        reason: "depth cap reached",
      });
    }
    const projectedChildren =
      depth >= effectiveBounds.maxDepth
        ? []
        : directChildren.map((child) => build(child, depth + 1, childStack));
    const node = makeNode(manifest, depth, reasonSet, projectedChildren);
    built.set(manifest.agentId, node);
    return node;
  };

  const projectedRoots = roots.map((root) => build(root, 0, new Set()));
  for (const manifest of byId.values()) {
    if (!built.has(manifest.agentId)) {
      const reasonSet = new Set(nonActionableIds.get(manifest.agentId) ?? []);
      reasonSet.add("cycle");
      issues.push({
        kind: "cycle",
        agentId: manifest.agentId,
        reason: "unreachable cycle",
      });
      built.set(manifest.agentId, makeNode(manifest, 0, reasonSet, []));
    }
  }
  const nonActionable = [...built.values()]
    .filter((node) => node.state === "non-actionable")
    .sort(compareProjectedNode);
  return {
    rootHash,
    roots: projectedRoots,
    nonActionable,
    issues: issues.sort(compareIssue),
    truncated: issues.some((issue) => issue.kind === "truncated"),
  };
}

export function flattenLineageTree(
  nodes: ProjectedLineageNode[],
): ProjectedLineageNode[] {
  const flattened: ProjectedLineageNode[] = [];
  const visit = (node: ProjectedLineageNode): void => {
    flattened.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return flattened;
}

export async function cancelLineageSubtreeBestEffort(
  root: ProjectedLineageNode,
  callbacks: CancelSubtreeCallbacks,
): Promise<CancelSubtreeResult> {
  const nodes = flattenLineageTree([root]).sort((left, right) => {
    const depthDelta = right.depth - left.depth;
    return depthDelta === 0 ? compareProjectedNode(left, right) : depthDelta;
  });
  const attempted: CancelLineageNodeResult[] = [];
  for (const node of nodes) {
    const agentId = node.manifest.agentId;
    try {
      if (node.state !== "actionable" || (await callbacks.isStale(node))) {
        attempted.push({ agentId, status: "stale" });
        continue;
      }
      if (await callbacks.isTerminal(node)) {
        attempted.push({ agentId, status: "already-terminal" });
        continue;
      }
      await callbacks.cancel(node);
      attempted.push({ agentId, status: "cancelled" });
    } catch (error) {
      attempted.push({ agentId, status: "failed", error: errorMessage(error) });
    }
  }
  return {
    attempted,
    cancelled: attempted
      .filter((result) => result.status === "cancelled")
      .map((result) => result.agentId),
    alreadyTerminal: attempted
      .filter((result) => result.status === "already-terminal")
      .map((result) => result.agentId),
    stale: attempted
      .filter((result) => result.status === "stale")
      .map((result) => result.agentId),
    failed: attempted.filter((result) => result.status === "failed"),
  };
}

async function resolveContainedRealPath(
  root: string,
  candidate: string,
): Promise<string> {
  const rootAbsolute = path.resolve(root);
  const rootReal = await fs.realpath(root);
  const candidateAbsolute = path.resolve(rootAbsolute, candidate);
  let relative = containedRelativePath(
    rootAbsolute,
    rootReal,
    candidateAbsolute,
  );
  if (relative === undefined) {
    try {
      const candidateReal = await fs.realpath(candidateAbsolute);
      relative = containedRelativePath(rootReal, rootReal, candidateReal);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  if (relative === undefined) throw new Error("path escapes lineage root");
  const resolved = path.resolve(rootReal, relative);
  await assertPathHasNoSymlinkEscape(rootReal, resolved);
  return resolved;
}

function containedRelativePath(
  rootAbsolute: string,
  rootReal: string,
  candidateAbsolute: string,
): string | undefined {
  for (const base of new Set([rootAbsolute, rootReal])) {
    const relative = path.relative(base, candidateAbsolute);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    ) {
      return relative;
    }
  }
  return undefined;
}

async function assertPathHasNoSymlinkEscape(
  rootReal: string,
  candidate: string,
): Promise<void> {
  const relative = path.relative(rootReal, path.resolve(candidate));
  if (relative === "") {
    return;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes lineage root");
  }
  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error("lineage path contains a symlink");
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
  }
}

function assertPathHasNoSymlinkEscapeSync(
  rootReal: string,
  candidate: string,
): void {
  const relative = path.relative(rootReal, path.resolve(candidate));
  if (relative === "") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes lineage root");
  }
  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("lineage path contains a symlink");
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
  }
}

async function listManifestPaths(
  nodesDir: string,
  bounds: LineageBounds,
): Promise<string[]> {
  const entries = await fs
    .readdir(nodesDir, { withFileTypes: true })
    .catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(nodesDir, entry.name))
    .sort()
    .slice(0, bounds.maxNodes + 1);
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) {
    throw new Error("lineage manifest exceeds byte limit");
  }
  return await fs.readFile(filePath, "utf8");
}

function validatePaneRef(
  value: unknown,
  bounds: LineageBounds,
): LineagePaneRef {
  if (!isRecord(value)) {
    throw new Error("pane must be an object");
  }
  rejectUnknownKeys(
    value,
    new Set(["backend", "paneId", "muxSession", "windowName"]),
    "pane",
  );
  return {
    backend: expectBoundedString(
      value.backend,
      "pane.backend",
      bounds.maxStringBytes,
    ),
    paneId: expectBoundedString(
      value.paneId,
      "pane.paneId",
      bounds.maxStringBytes,
    ),
    ...optionalObjectString(value, "muxSession", "pane.muxSession", bounds),
    ...optionalObjectString(value, "windowName", "pane.windowName", bounds),
  };
}

function optionalObjectString(
  object: JsonRecord,
  key: string,
  label: string,
  bounds: LineageBounds,
): Record<string, string> {
  const value = optionalBoundedString(
    object[key],
    label,
    bounds.maxStringBytes,
  );
  return value === undefined ? {} : { [key]: value };
}

function makeNode(
  manifest: LineageManifest,
  depth: number,
  reasons: Set<ProjectionIssueKind>,
  children: ProjectedLineageNode[],
): ProjectedLineageNode {
  const sortedReasons = [...reasons].sort();
  return {
    manifest,
    depth,
    state: sortedReasons.length === 0 ? "actionable" : "non-actionable",
    reasons: sortedReasons,
    children,
  };
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function expectSafeId(value: unknown, label: string): string {
  const stringValue = expectBoundedString(
    value,
    label,
    DEFAULT_MAX_STRING_BYTES,
  );
  assertSafeId(stringValue, label);
  return stringValue;
}

function optionalSafeId(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectSafeId(value, label);
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} contains unsafe characters`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): asserts value is string {
  expectBoundedString(value, label, maxBytes);
}

function expectBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${label} exceeds byte limit`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectBoundedString(value, label, maxBytes);
}

function rejectUnknownKeys(
  record: JsonRecord,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown key ${key}`);
    }
  }
}

function compareManifest(
  left: LineageManifest,
  right: LineageManifest,
): number {
  const startedDelta = left.startedAt.localeCompare(right.startedAt);
  return startedDelta === 0
    ? left.agentId.localeCompare(right.agentId)
    : startedDelta;
}

function compareProjectedNode(
  left: ProjectedLineageNode,
  right: ProjectedLineageNode,
): number {
  return compareManifest(left.manifest, right.manifest);
}

function compareIssue(left: ProjectionIssue, right: ProjectionIssue): number {
  return `${left.kind}:${left.agentId ?? ""}:${left.path ?? ""}:${left.reason}`.localeCompare(
    `${right.kind}:${right.agentId ?? ""}:${right.path ?? ""}:${right.reason}`,
  );
}

function stableJsonReplacer(_key: string, value: unknown): unknown {
  if (!isRecord(value) || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
