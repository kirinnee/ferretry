/**
 * Cross-account harness history, planned before it is moved.
 *
 * Claude and Codex each get one independent pool. Existing state is renamed into that pool and
 * each account home receives absolute symlinks back to it. Rename-based directory migration keeps
 * live transcript inodes intact; prompt-history merges rewrite the already-pooled file in place so
 * its inode also remains stable. Filesystem observation and mutation sit behind
 * {@link SharedHistoryFileSystem}; all merge, collision, dry-run and rollback decisions live here.
 *
 * Three properties are decided before anything is written, so a dry run can show them: a rename
 * that would cross a filesystem device is refused instead of degrading to a copy, an account home
 * that lies outside the writable roots becomes a structured refusal rather than an exception, and
 * an unfinished journal is reported with validated evidence rather than being cleaned up.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { type HarnessKind, HarnessKindSchema } from './manifest.ts';

export type SharedHistoryEntryType = 'directory' | 'file';

export interface SharedHistoryEntry {
  readonly name: string;
  readonly type: SharedHistoryEntryType;
  readonly merge?: 'jsonl';
}

const SHARED_HISTORY_ENTRIES = {
  claude: [
    { name: 'projects', type: 'directory' },
    { name: 'sessions', type: 'directory' },
    { name: 'session-env', type: 'directory' },
    { name: 'file-history', type: 'directory' },
    { name: 'plans', type: 'directory' },
    { name: 'tasks', type: 'directory' },
    { name: 'todos', type: 'directory' },
    { name: 'shell-snapshots', type: 'directory' },
    { name: 'paste-cache', type: 'directory' },
    { name: 'history.jsonl', type: 'file', merge: 'jsonl' },
  ],
  codex: [
    { name: 'sessions', type: 'directory' },
    { name: 'archived_sessions', type: 'directory' },
    { name: 'history.jsonl', type: 'file', merge: 'jsonl' },
  ],
} as const satisfies Readonly<Record<HarnessKind, readonly SharedHistoryEntry[]>>;

/** Session state required by the harness's native resume path. Identity and auth are never pooled. */
export function sharedHistoryEntries(kind: HarnessKind): readonly SharedHistoryEntry[] {
  return SHARED_HISTORY_ENTRIES[kind];
}

export interface SharedHistoryFileNode {
  readonly kind: 'file';
  readonly modifiedAtMs: number;
  readonly size: number;
  /** The filesystem device holding this inode. A rename can never move an inode off its device. */
  readonly deviceId: number;
  /** Populated only when the caller asks for the root file's text. */
  readonly text?: string;
}

export interface SharedHistoryDirectoryNode {
  readonly kind: 'directory';
  readonly modifiedAtMs: number;
  readonly deviceId: number;
  readonly children: Readonly<Record<string, SharedHistoryNode>>;
}

export interface SharedHistorySymbolicLinkNode {
  readonly kind: 'symbolic-link';
  readonly modifiedAtMs: number;
  readonly deviceId: number;
  readonly target: string;
}

export interface SharedHistoryOtherNode {
  readonly kind: 'other';
  readonly modifiedAtMs: number;
  readonly deviceId: number;
}

export type SharedHistoryNode =
  | SharedHistoryFileNode
  | SharedHistoryDirectoryNode
  | SharedHistorySymbolicLinkNode
  | SharedHistoryOtherNode;

/**
 * The filesystem primitives used by shared-history planning and execution.
 *
 * `snapshot` is lstat-based and must never follow a symbolic link. Missing is `undefined`; every
 * other read failure is an error. Mutation methods likewise fail rather than treating damaged or
 * unreadable state as empty, and every completed mutation is durable before the next one starts.
 */
export interface SharedHistoryFileSystem {
  snapshot(
    path: string,
    options?: { readonly readText?: boolean; readonly recursive?: boolean },
  ): Promise<SharedHistoryNode | undefined>;
  /** The device of `path`, or of its nearest existing ancestor when `path` does not exist yet. */
  deviceIdOf(path: string): Promise<number>;
  ensureDirectory(path: string): Promise<void>;
  ensureFile(path: string): Promise<void>;
  move(source: string, destination: string): Promise<void>;
  /** Create, write and durably sync a new file; refuse rather than replace an existing path. */
  writeTextExclusive(path: string, text: string): Promise<void>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  /**
   * Append to one regular file through its existing inode, and only while it still starts with
   * `expected`. Returns `false` when it no longer does, so the caller can re-plan. Never truncates.
   */
  appendTextIfPrefix(path: string, expected: string, addition: string): Promise<boolean>;
  createSymbolicLink(target: string, path: string): Promise<void>;
  removeSymbolicLink(path: string, expectedTarget: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

/**
 * An operation was refused because its path is not inside the writable roots.
 *
 * Declared here rather than in the adapter so the planner can recognise a containment refusal
 * without knowing which filesystem raised it: an account home outside the roots is evidence to
 * report in a read-only plan, not a crash.
 */
export class SharedHistoryAccessRefusedError extends Error {
  constructor(
    readonly path: string,
    readonly roots: readonly string[],
  ) {
    super(`refusing shared-history access outside configured roots: ${path}`);
    this.name = 'SharedHistoryAccessRefusedError';
  }
}

export interface SharedHistoryHome {
  /** Stable, path-safe account identity used only to partition preserved conflicts. */
  readonly account: string;
  readonly path: string;
}

export interface SharedHistoryRequest {
  readonly kind: HarnessKind;
  /** `<FY_HOME>/fleet/shared`; the harness kind is appended by the planner. */
  readonly poolRoot: string;
  /** All homes of this harness kind, in the order provisioning will materialize them. */
  readonly homes: readonly SharedHistoryHome[];
}

export type SharedHistoryChange =
  | {
      readonly kind: 'create-pooled-entry';
      readonly path: string;
      readonly entryType: SharedHistoryEntryType;
    }
  | { readonly kind: 'move'; readonly source: string; readonly destination: string }
  | {
      readonly kind: 'collision';
      readonly incoming: string;
      readonly pooled: string;
      readonly winner: string;
      readonly loser: string;
      readonly preservedAt: string;
    }
  | {
      readonly kind: 'merge-jsonl';
      readonly source: string;
      readonly destination: string;
      readonly sourcePreservedAt: string;
    }
  | { readonly kind: 'link'; readonly path: string; readonly target: string }
  | { readonly kind: 'already-shared'; readonly path: string; readonly target: string };

/** One account home that could not be observed, and therefore has no plan of its own. */
export interface SharedHistoryRefusal {
  readonly account: string;
  /** The account home exactly as it was configured. */
  readonly home: string;
  /** The path the filesystem refused, which may be the home itself or something under it. */
  readonly path: string;
  readonly reason: string;
}

/**
 * The exact read-only report used by dry-run and returned after a successful materialization.
 *
 * `emptiedSourceDirectories` and `refusals` are optional only so that an older literal still
 * type-checks; the planner always supplies both, and an absent field means "none".
 */
export interface SharedHistoryPreview {
  readonly kind: HarnessKind;
  readonly pool: string;
  readonly migrated: number;
  readonly conflicts: number;
  readonly links: number;
  readonly changes: readonly SharedHistoryChange[];
  /**
   * Account-home directories the migration empties and then removes.
   *
   * Each one is a directory whose children are all renamed into the pool; the now-empty directory
   * is removed so the account home can hold the pool symlink in its place. The removal is refused
   * and the whole migration rolled back if anything appeared in it meanwhile, so this names a
   * mutation that really happens rather than an intention.
   */
  readonly emptiedSourceDirectories?: readonly string[];
  /**
   * Homes excluded from this plan because the filesystem refused to read them.
   *
   * A dry run stays truthful and read-only: the remaining homes are still planned in full, and a
   * materialization refuses outright rather than migrating a fleet it could only partly observe.
   */
  readonly refusals?: readonly SharedHistoryRefusal[];
}

export type SharedHistoryAction =
  | {
      readonly kind: 'ensure-entry';
      readonly path: string;
      readonly entryType: SharedHistoryEntryType;
      readonly restoreTo: string;
    }
  | { readonly kind: 'move'; readonly source: string; readonly destination: string }
  | {
      readonly kind: 'merge-jsonl';
      readonly source: string;
      readonly destination: string;
      readonly preservedAt: string;
      readonly expectedSource: string;
      /** The pooled text observed at plan time; the append proceeds only while it is still the prefix. */
      readonly expectedDestination: string;
      /** Exactly the lines the pool does not already hold, appended verbatim. Never a replacement. */
      readonly addition: string;
    }
  | { readonly kind: 'remove-empty-directory'; readonly path: string }
  | { readonly kind: 'link'; readonly path: string; readonly target: string };

export interface SharedHistoryPlan extends SharedHistoryPreview {
  readonly actions: readonly SharedHistoryAction[];
}

export interface SharedHistoryObservedHome extends SharedHistoryHome {
  readonly entries: Readonly<Record<string, SharedHistoryNode | undefined>>;
}

/** Immutable evidence consumed by the pure planner. */
export interface SharedHistoryObservation {
  readonly poolEntries: Readonly<Record<string, SharedHistoryNode | undefined>>;
  /** The device of the pool, or of its nearest existing ancestor when the pool is not there yet. */
  readonly poolDeviceId: number;
  readonly conflicts: SharedHistoryNode | undefined;
  readonly homes: readonly SharedHistoryObservedHome[];
  readonly refusals?: readonly SharedHistoryRefusal[];
}

/**
 * The identity a quarantined loser is filed under when nothing in this run contributed it.
 *
 * Accounts must start with an alphanumeric character, so no account can ever claim this directory.
 */
const POOLED_OWNER = '.pooled';

const MIGRATION_CONFLICTS = '.migration-conflicts';
const MIGRATION_JOURNAL = '.migration-journal';
const MIGRATION_PROGRESS = '.migration-progress';
const MAX_CONCURRENT_RETRIES = 3;
const MAX_HOME_LINK_DEPTH = 8;

interface PlanningState {
  readonly actions: SharedHistoryAction[];
  readonly changes: SharedHistoryChange[];
  readonly emptied: string[];
  readonly occupiedConflicts: Set<string>;
  readonly conflictNodes: ReadonlyMap<string, SharedHistoryNode>;
  /** Pooled paths this run has filled, and the account whose copy now occupies them. */
  readonly contributors: Map<string, string>;
  readonly pool: string;
  readonly poolDeviceId: number;
  readonly conflictsRoot: string;
  migrated: number;
  conflicts: number;
  links: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A migration failed. `rollbackFailures` is empty when every completed mutation was restored. */
export class SharedHistoryMigrationError extends Error {
  constructor(
    readonly operationError: unknown,
    readonly rollbackFailures: readonly string[],
  ) {
    super(
      rollbackFailures.length === 0
        ? `shared-history migration failed and was rolled back: ${errorMessage(operationError)}`
        : `shared-history migration failed: ${errorMessage(operationError)}; rollback was incomplete: ${rollbackFailures.join('; ')}`,
      { cause: operationError },
    );
    this.name = 'SharedHistoryMigrationError';
  }
}

function assertAbsolutePath(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path: ${path}`);
}

function pathIsInside(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
}

function validateRequest(request: SharedHistoryRequest): void {
  assertAbsolutePath('shared-history pool root', request.poolRoot);
  const pool = join(request.poolRoot, request.kind);
  const accounts = new Set<string>();
  const homes = new Set<string>();
  for (const home of request.homes) {
    assertAbsolutePath(`account "${home.account}" home`, home.path);
    // A leading dot is excluded so no account can occupy a reserved conflict directory.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(home.account)) {
      throw new Error(`shared-history account must be path safe: ${home.account}`);
    }
    if (accounts.has(home.account)) throw new Error(`duplicate shared-history account: ${home.account}`);
    const resolvedHome = resolve(home.path);
    if (homes.has(resolvedHome)) throw new Error(`duplicate shared-history home: ${home.path}`);
    if (pathIsInside(resolvedHome, pool) || pathIsInside(pool, resolvedHome)) {
      throw new Error(`shared-history home and pool must not overlap: ${home.path} and ${pool}`);
    }
    accounts.add(home.account);
    homes.add(resolvedHome);
  }
}

function expectedNodeKind(type: SharedHistoryEntryType): SharedHistoryNode['kind'] {
  return type === 'directory' ? 'directory' : 'file';
}

function emptyNode(type: SharedHistoryEntryType, deviceId: number): SharedHistoryNode {
  return type === 'directory'
    ? { kind: 'directory', modifiedAtMs: 0, deviceId, children: {} }
    : { kind: 'file', modifiedAtMs: 0, deviceId, size: 0, text: '' };
}

function assertSupportedTree(node: SharedHistoryNode, path: string): void {
  if (node.kind === 'other') throw new Error(`unsupported filesystem entry in shared history: ${path}`);
  if (node.kind !== 'directory') return;
  for (const [name, child] of Object.entries(node.children)) assertSupportedTree(child, join(path, name));
}

function assertPoolNode(entry: SharedHistoryEntry, node: SharedHistoryNode | undefined, path: string): void {
  if (node === undefined) return;
  if (node.kind !== expectedNodeKind(entry.type)) {
    throw new Error(`pooled ${entry.name} must be a ${entry.type}, found ${node.kind}: ${path}`);
  }
  assertSupportedTree(node, path);
}

function assertHomeNode(entry: SharedHistoryEntry, node: SharedHistoryNode | undefined, path: string): void {
  if (node === undefined || node.kind === 'symbolic-link') return;
  if (node.kind !== expectedNodeKind(entry.type)) {
    throw new Error(`account ${entry.name} must be a ${entry.type}, found ${node.kind}: ${path}`);
  }
  assertSupportedTree(node, path);
}

function equivalentLink(path: string, target: string, expected: string): boolean {
  return resolve(dirname(path), target) === resolve(expected);
}

/**
 * Whether the pooled counterpart of one home entry has to be read all the way down.
 *
 * At steady state a home entry is already the link to its pool entry, and then no decision depends
 * on what the pool contains: walking a pool holding every transcript of every account, on every
 * apply, would be the dominant cost of doing nothing. Anything else — a real directory, a real
 * file, or a link pointing somewhere else — is merged or preserved against the pooled tree, so that
 * tree must be observed completely.
 */
export function sharedHistoryEntryNeedsPooledTree(
  source: SharedHistoryNode | undefined,
  sourcePath: string,
  pooledPath: string,
): boolean {
  if (source === undefined) return false;
  return !(source.kind === 'symbolic-link' && equivalentLink(sourcePath, source.target, pooledPath));
}

function collectOccupiedPaths(
  root: string,
  node: SharedHistoryNode | undefined,
  paths: Set<string>,
  nodes: Map<string, SharedHistoryNode>,
): void {
  if (node === undefined) return;
  paths.add(root);
  nodes.set(root, node);
  if (node.kind !== 'directory') return;
  for (const [name, child] of Object.entries(node.children)) {
    collectOccupiedPaths(join(root, name), child, paths, nodes);
  }
}

function assertConflictParentSafe(candidate: string, state: PlanningState): void {
  let parent = dirname(candidate);
  while (pathIsInside(state.conflictsRoot, parent)) {
    const existing = state.conflictNodes.get(parent);
    if (existing !== undefined && existing.kind !== 'directory') {
      throw new Error(`shared-history conflict parent must be a directory, found ${existing.kind}: ${parent}`);
    }
    if (parent === state.conflictsRoot) return;
    parent = dirname(parent);
  }
  throw new Error(`shared-history conflict path escaped its root: ${candidate}`);
}

function reserveConflictPath(base: string, state: PlanningState): string {
  let candidate = base;
  let suffix = 1;
  while (state.occupiedConflicts.has(candidate)) candidate = `${base}.${suffix++}`;
  assertConflictParentSafe(candidate, state);
  state.occupiedConflicts.add(candidate);
  return candidate;
}

/** The device a quarantine rename would land on: the deepest conflict directory that exists. */
function conflictDeviceId(state: PlanningState, preservedAt: string): number {
  let candidate = dirname(preservedAt);
  while (pathIsInside(state.conflictsRoot, candidate)) {
    const existing = state.conflictNodes.get(candidate);
    if (existing !== undefined) return existing.deviceId;
    candidate = dirname(candidate);
  }
  return state.poolDeviceId;
}

/** The account whose copy occupies a pooled path, or the reserved identity for pre-existing state. */
function pooledOwner(state: PlanningState, pooledPath: string): string {
  let candidate = pooledPath;
  while (pathIsInside(state.pool, candidate) && candidate !== state.pool) {
    const owner = state.contributors.get(candidate);
    if (owner !== undefined) return owner;
    candidate = dirname(candidate);
  }
  return POOLED_OWNER;
}

/**
 * Refuse a rename that would have to cross a filesystem boundary, while nothing has been written.
 *
 * The only alternative to a rename is copy-then-delete, and that hands every reader a different
 * inode: a harness with an open transcript would keep writing to a file nobody reads again. The
 * refusal therefore belongs in the plan, where a dry run shows it, not in an errno at the halfway
 * point of a migration.
 */
function assertSameDevice(source: string, sourceDeviceId: number, destination: string, deviceId: number): void {
  if (sourceDeviceId === deviceId) return;
  throw new Error(
    `refusing a cross-device shared-history rename: ${source} is on device ${sourceDeviceId} and ${destination} is on device ${deviceId}; copying is forbidden because the new inode would orphan every transcript a running harness already has open — put the shared pool on the same filesystem as the account homes`,
  );
}

function planMove(
  state: PlanningState,
  source: string,
  sourceNode: SharedHistoryNode,
  destination: string,
  destinationDeviceId: number,
): void {
  assertSameDevice(source, sourceNode.deviceId, destination, destinationDeviceId);
  state.actions.push({ kind: 'move', source, destination });
}

function timestampOf(line: string): number {
  try {
    const parsed = JSON.parse(line) as { readonly timestamp?: unknown; readonly ts?: unknown };
    const candidate = parsed.timestamp ?? parsed.ts;
    if (typeof candidate === 'number') return candidate;
  } catch {
    // Vendor history can contain an unparseable line. Preserve it at the end rather than erasing evidence.
  }
  return Number.POSITIVE_INFINITY;
}

/** Every non-blank line of a JSONL document with how many times it occurs, in first-seen order. */
function countJsonlLines(document: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of document.split('\n')) {
    if (line.trim().length === 0) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function renderJsonlLines(lines: readonly string[]): string {
  const ordered = [...lines].sort((left, right) => timestampOf(left) - timestampOf(right));
  return ordered.length === 0 ? '' : `${ordered.join('\n')}\n`;
}

/**
 * The union of prompt-history documents: what a pooled file is supposed to end up holding.
 *
 * A line's identity is its exact text, and its multiplicity is the LARGEST number of times that
 * text occurs in any single document — never the sum across documents. The same prompt typed twice
 * in one history is two pieces of evidence and both survive; pooling the same history a second time
 * contributes nothing, so re-running a migration cannot grow the pooled file. Lines keep their
 * first-appearance order, stably re-sorted by timestamp, and a line that cannot be parsed is kept
 * verbatim at the end rather than being erased.
 */
export function mergeSharedHistoryJsonl(...documents: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const document of documents) {
    for (const [line, count] of countJsonlLines(document)) {
      counts.set(line, Math.max(counts.get(line) ?? 0, count));
    }
  }
  return renderJsonlLines([...counts].flatMap(([line, count]) => Array.from({ length: count }, () => line)));
}

/**
 * The part of `source` a pooled document does not already hold, and nothing else.
 *
 * This is the union of {@link mergeSharedHistoryJsonl} expressed as something that can only be
 * appended. The pooled file is never rewritten and never truncated, because the only way to write a
 * whole new body is to erase whatever a concurrent writer appended in the meantime — and erasing
 * prompt history is the one thing this migration must never do. The cost is ordering: additions
 * land after everything already pooled rather than being interleaved by timestamp.
 */
export function sharedHistoryJsonlAdditions(destination: string, source: string): string {
  const pooled = countJsonlLines(destination);
  const additions: string[] = [];
  for (const [line, count] of countJsonlLines(source)) {
    for (let index = pooled.get(line) ?? 0; index < count; index++) additions.push(line);
  }
  return renderJsonlLines(additions);
}

function conflictRoot(pool: string, owner: string): string {
  return join(pool, MIGRATION_CONFLICTS, owner);
}

function planForeignLink(
  state: PlanningState,
  account: string,
  source: string,
  poolPath: string,
  sourceNode: SharedHistorySymbolicLinkNode,
): void {
  const preservedAt = reserveConflictPath(join(conflictRoot(state.pool, account), basename(poolPath)), state);
  planMove(state, source, sourceNode, preservedAt, conflictDeviceId(state, preservedAt));
  state.changes.push({
    kind: 'collision',
    incoming: source,
    pooled: poolPath,
    winner: poolPath,
    loser: source,
    preservedAt,
  });
  state.conflicts++;
}

function planCollision(
  state: PlanningState,
  account: string,
  entryRelativePath: string,
  name: string,
  incomingPath: string,
  incoming: SharedHistoryNode,
  existingPath: string,
  existing: SharedHistoryNode,
  pooledDeviceId: number,
): boolean {
  const incomingWins = incoming.modifiedAtMs > existing.modifiedAtMs;
  const loser = incomingWins ? existingPath : incomingPath;
  const winner = incomingWins ? incomingPath : existingPath;
  // The quarantine directory names whoever owned the losing copy: filing a pooled loser under the
  // incoming account would credit account B with account A's transcript.
  const owner = incomingWins ? pooledOwner(state, existingPath) : account;
  const preservedAt = reserveConflictPath(join(conflictRoot(state.pool, owner), entryRelativePath, name), state);
  if (incomingWins) {
    planMove(state, existingPath, existing, preservedAt, conflictDeviceId(state, preservedAt));
    planMove(state, incomingPath, incoming, existingPath, pooledDeviceId);
    state.contributors.set(existingPath, account);
  } else {
    planMove(state, incomingPath, incoming, preservedAt, conflictDeviceId(state, preservedAt));
  }
  state.changes.push({ kind: 'collision', incoming: incomingPath, pooled: existingPath, winner, loser, preservedAt });
  state.conflicts++;
  return incomingWins;
}

function planDirectoryMerge(
  state: PlanningState,
  account: string,
  entryRelativePath: string,
  sourcePath: string,
  pooledPath: string,
  source: SharedHistoryDirectoryNode,
  pooled: SharedHistoryDirectoryNode,
): SharedHistoryDirectoryNode {
  let children: Readonly<Record<string, SharedHistoryNode>> = { ...pooled.children };
  for (const [name, incoming] of Object.entries(source.children).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const existing = children[name];
    const incomingPath = join(sourcePath, name);
    const existingPath = join(pooledPath, name);
    if (existing === undefined) {
      planMove(state, incomingPath, incoming, existingPath, pooled.deviceId);
      state.changes.push({ kind: 'move', source: incomingPath, destination: existingPath });
      state.contributors.set(existingPath, account);
      state.migrated++;
      children = { ...children, [name]: incoming };
      continue;
    }
    if (incoming.kind === 'directory' && existing.kind === 'directory') {
      children = {
        ...children,
        [name]: planDirectoryMerge(
          state,
          account,
          join(entryRelativePath, name),
          incomingPath,
          existingPath,
          incoming,
          existing,
        ),
      };
      continue;
    }
    const incomingWins = planCollision(
      state,
      account,
      entryRelativePath,
      name,
      incomingPath,
      incoming,
      existingPath,
      existing,
      pooled.deviceId,
    );
    if (incomingWins) children = { ...children, [name]: incoming };
  }
  state.actions.push({ kind: 'remove-empty-directory', path: sourcePath });
  state.emptied.push(sourcePath);
  return { ...pooled, children };
}

/**
 * Fold one account's prompt history into the pooled file, and say what that cannot cover.
 *
 * The account's file is renamed into quarantine and the lines the pool does not already hold are
 * APPENDED to the pooled inode, so both copies survive, no reader loses its file, and nothing that
 * anyone else appended in the meantime can be erased. What this does NOT do is capture writes that
 * arrive afterwards: a writer holding a descriptor opened before the rename keeps appending to the
 * quarantined inode, and those lines stay preserved at `preservedAt` without ever reaching the
 * pool. Pooling prompt history is therefore best done while the accounts are idle, and the
 * quarantined copy is the record that makes that gap recoverable rather than silent.
 */
function planJsonlMerge(
  state: PlanningState,
  account: string,
  sourcePath: string,
  pooledPath: string,
  source: SharedHistoryFileNode,
  pooled: SharedHistoryFileNode,
): SharedHistoryFileNode {
  if (source.text === undefined || pooled.text === undefined) {
    throw new Error(`history JSONL was not read completely: ${sourcePath} or ${pooledPath}`);
  }
  const sourcePreservedAt = reserveConflictPath(join(conflictRoot(state.pool, account), basename(sourcePath)), state);
  assertSameDevice(sourcePath, source.deviceId, sourcePreservedAt, conflictDeviceId(state, sourcePreservedAt));
  const lines = sharedHistoryJsonlAdditions(pooled.text, source.text);
  // A pooled file that does not end in a newline would otherwise splice its last line into the first
  // appended one.
  const separator = lines.length > 0 && pooled.text.length > 0 && !pooled.text.endsWith('\n') ? '\n' : '';
  const addition = `${separator}${lines}`;
  state.actions.push({
    kind: 'merge-jsonl',
    source: sourcePath,
    destination: pooledPath,
    preservedAt: sourcePreservedAt,
    expectedSource: source.text,
    expectedDestination: pooled.text,
    addition,
  });
  state.changes.push({
    kind: 'merge-jsonl',
    source: sourcePath,
    destination: pooledPath,
    sourcePreservedAt,
  });
  state.migrated++;
  const pooledText = `${pooled.text}${addition}`;
  return {
    kind: 'file',
    modifiedAtMs: Math.max(source.modifiedAtMs, pooled.modifiedAtMs),
    deviceId: pooled.deviceId,
    size: new TextEncoder().encode(pooledText).byteLength,
    text: pooledText,
  };
}

function planEntry(
  state: PlanningState,
  entry: SharedHistoryEntry,
  account: string,
  homePath: string,
  source: SharedHistoryNode | undefined,
  pooled: SharedHistoryNode | undefined,
): SharedHistoryNode {
  const sourcePath = join(homePath, entry.name);
  const pooledPath = join(state.pool, entry.name);
  assertHomeNode(entry, source, sourcePath);
  assertPoolNode(entry, pooled, pooledPath);

  if (source?.kind === 'symbolic-link' && equivalentLink(sourcePath, source.target, pooledPath)) {
    const next = pooled ?? emptyNode(entry.type, state.poolDeviceId);
    if (pooled === undefined) {
      state.actions.push({ kind: 'ensure-entry', path: pooledPath, entryType: entry.type, restoreTo: sourcePath });
      state.changes.push({ kind: 'create-pooled-entry', path: pooledPath, entryType: entry.type });
    }
    state.changes.push({ kind: 'already-shared', path: sourcePath, target: pooledPath });
    return next;
  }

  let next = pooled;
  if (next === undefined) {
    if (source !== undefined && source.kind !== 'symbolic-link') {
      planMove(state, sourcePath, source, pooledPath, state.poolDeviceId);
      state.changes.push({ kind: 'move', source: sourcePath, destination: pooledPath });
      state.contributors.set(pooledPath, account);
      state.migrated++;
      next = source;
    } else {
      state.actions.push({ kind: 'ensure-entry', path: pooledPath, entryType: entry.type, restoreTo: sourcePath });
      state.changes.push({ kind: 'create-pooled-entry', path: pooledPath, entryType: entry.type });
      next = emptyNode(entry.type, state.poolDeviceId);
    }
  } else if (source?.kind === 'directory' && next.kind === 'directory') {
    next = planDirectoryMerge(state, account, entry.name, sourcePath, pooledPath, source, next);
  } else if (source?.kind === 'file' && next.kind === 'file' && entry.merge === 'jsonl') {
    next = planJsonlMerge(state, account, sourcePath, pooledPath, source, next);
  }

  if (source?.kind === 'symbolic-link') planForeignLink(state, account, sourcePath, pooledPath, source);
  state.actions.push({ kind: 'link', path: sourcePath, target: pooledPath });
  state.changes.push({ kind: 'link', path: sourcePath, target: pooledPath });
  state.links++;
  return next;
}

/**
 * Compute the complete rename/link plan from an immutable filesystem observation.
 *
 * Exported for deterministic unit tests and dry-run renderers; callers normally use
 * {@link SharedHistoryMigration.preview} or {@link SharedHistoryMigration.materialize}.
 */
export function planSharedHistory(
  request: SharedHistoryRequest,
  observation: SharedHistoryObservation,
): SharedHistoryPlan {
  validateRequest(request);
  const pool = join(request.poolRoot, request.kind);
  const conflictsRoot = join(pool, MIGRATION_CONFLICTS);
  const conflictNodes = new Map<string, SharedHistoryNode>();
  const state: PlanningState = {
    actions: [],
    changes: [],
    emptied: [],
    occupiedConflicts: new Set<string>(),
    conflictNodes,
    contributors: new Map<string, string>(),
    pool,
    poolDeviceId: observation.poolDeviceId,
    conflictsRoot,
    migrated: 0,
    conflicts: 0,
    links: 0,
  };
  collectOccupiedPaths(conflictsRoot, observation.conflicts, state.occupiedConflicts, conflictNodes);
  let pooled = { ...observation.poolEntries };
  for (const home of observation.homes) {
    for (const entry of sharedHistoryEntries(request.kind)) {
      pooled = {
        ...pooled,
        [entry.name]: planEntry(state, entry, home.account, home.path, home.entries[entry.name], pooled[entry.name]),
      };
    }
  }
  return {
    kind: request.kind,
    pool,
    migrated: state.migrated,
    conflicts: state.conflicts,
    links: state.links,
    changes: state.changes,
    emptiedSourceDirectories: state.emptied,
    refusals: observation.refusals ?? [],
    actions: state.actions,
  };
}

function withoutActions(plan: SharedHistoryPlan): SharedHistoryPreview {
  return {
    kind: plan.kind,
    pool: plan.pool,
    migrated: plan.migrated,
    conflicts: plan.conflicts,
    links: plan.links,
    changes: plan.changes,
    emptiedSourceDirectories: plan.emptiedSourceDirectories,
    refusals: plan.refusals,
  };
}

function nodeIsEmpty(node: SharedHistoryNode): boolean {
  return node.kind === 'file'
    ? node.size === 0
    : node.kind === 'directory'
      ? Object.keys(node.children).length === 0
      : false;
}

type Undo = () => Promise<void>;

const migrationActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ensure-entry'),
    path: z.string(),
    entryType: z.enum(['directory', 'file']),
    restoreTo: z.string(),
  }),
  z.object({ kind: z.literal('move'), source: z.string(), destination: z.string() }),
  z.object({
    kind: z.literal('merge-jsonl'),
    source: z.string(),
    destination: z.string(),
    preservedAt: z.string(),
    expectedSource: z.string(),
    expectedDestination: z.string(),
    addition: z.string(),
  }),
  z.object({ kind: z.literal('remove-empty-directory'), path: z.string() }),
  z.object({ kind: z.literal('link'), path: z.string(), target: z.string() }),
]);

/** The durable intent: written once, before the first mutation, and never rewritten. */
const migrationJournalSchema = z.object({
  version: z.literal(1),
  kind: HarnessKindSchema,
  pool: z.string(),
  actions: z.array(migrationActionSchema),
});

/** The durable cursor: a fixed-size record rewritten after each action. */
const migrationProgressSchema = z.object({
  version: z.literal(1),
  kind: HarnessKindSchema,
  pool: z.string(),
  state: z.enum(['applying', 'complete', 'rollback-incomplete']),
  completed: z.int().nonnegative(),
  rollbackFailures: z.array(z.string()).optional(),
});

type MigrationProgressState = z.infer<typeof migrationProgressSchema>['state'];

/**
 * Everything a person needs to finish or undo an interrupted migration, by hand or by tool.
 *
 * `appliedActions` is a lower bound and `uncertainAction` is the honest gap: the cursor is written
 * after an action completes, so a crash between the two leaves one action that may be whole, half
 * done, or not started. Nothing here is deleted or repaired automatically.
 */
export interface SharedHistoryRecoveryEvidence {
  readonly journalPath: string;
  readonly progressPath: string;
  readonly kind: HarnessKind;
  readonly pool: string;
  readonly state: MigrationProgressState;
  readonly completedAtLeast: number;
  readonly totalActions: number;
  readonly appliedActions: readonly SharedHistoryAction[];
  readonly uncertainAction: SharedHistoryAction | undefined;
  readonly pendingActions: readonly SharedHistoryAction[];
  readonly rollbackFailures: readonly string[];
}

/**
 * What to tell the operator, which depends entirely on whether the migration got to commit.
 *
 * A journal whose cursor reads `complete` describes work that all landed and a cleanup that did
 * not; telling anyone to undo it would destroy a migrated pool. Every other state describes work
 * that stopped somewhere, and there the reverse replay is the recovery.
 */
function recoveryMessage(evidence: SharedHistoryRecoveryEvidence): string {
  if (evidence.state === 'complete') {
    return `a finished shared-history migration left its journal behind: ${evidence.journalPath}; all ${evidence.totalActions} actions were applied, so undo NOTHING — delete ${evidence.journalPath} and ${evidence.progressPath} and the next apply will carry on`;
  }
  const uncertain =
    evidence.uncertainAction === undefined
      ? ''
      : `, action ${evidence.completedAtLeast + 1} (${evidence.uncertainAction.kind}) may be half applied`;
  const failures =
    evidence.rollbackFailures.length === 0 ? '' : `; rollback failures: ${evidence.rollbackFailures.join('; ')}`;
  return `unfinished shared-history migration journal requires recovery before retrying: ${evidence.journalPath}; state ${evidence.state}, at least ${evidence.completedAtLeast} of ${evidence.totalActions} actions applied${uncertain}${failures}; undo the applied actions in reverse, then remove ${evidence.journalPath} and ${evidence.progressPath}`;
}

/** A previous migration left a journal behind. Fail closed and hand the operator the evidence. */
export class SharedHistoryRecoveryRequiredError extends Error {
  constructor(readonly evidence: SharedHistoryRecoveryEvidence) {
    super(recoveryMessage(evidence));
    this.name = 'SharedHistoryRecoveryRequiredError';
  }
}

function readableText(label: string, path: string, node: SharedHistoryNode): string {
  if (node.kind !== 'file' || node.text === undefined) {
    throw new Error(`shared-history ${label} must be a readable file: ${path}`);
  }
  return node.text;
}

function parseMigrationRecord<Schema extends z.ZodType<{ readonly kind: HarnessKind; readonly pool: string }>>(
  schema: Schema,
  label: string,
  path: string,
  text: string,
  kind: HarnessKind,
  pool: string,
): z.infer<Schema> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`shared-history ${label} is not valid JSON and must be inspected by hand: ${path}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`shared-history ${label} is malformed and must be inspected by hand: ${path}`);
  }
  if (parsed.data.kind !== kind || parsed.data.pool !== pool) {
    throw new Error(
      `shared-history ${label} belongs to a different migration (${parsed.data.kind} ${parsed.data.pool}) and must be inspected by hand: ${path}`,
    );
  }
  return parsed.data;
}

/** A live harness changed evidence between observation and mutation; a clean rollback may retry. */
class SharedHistoryConcurrentChangeError extends Error {
  constructor(readonly path: string) {
    super(`shared-history state changed during migration: ${path}`);
    this.name = 'SharedHistoryConcurrentChangeError';
  }
}

/** Plans, previews and transactionally materializes one harness kind's pooled history. */
export class SharedHistoryMigration {
  constructor(private readonly files: SharedHistoryFileSystem) {}

  async preview(request: SharedHistoryRequest): Promise<SharedHistoryPreview> {
    return withoutActions(await this.plan(request));
  }

  /**
   * Validated evidence about an interrupted migration, or `undefined` when there is nothing to fix.
   *
   * Read-only by construction: it deletes nothing, repairs nothing, and refuses a journal it cannot
   * validate rather than guessing. The remaining seam is a command that shows this to a person and,
   * on their say-so, replays the undo.
   */
  async inspectRecovery(request: SharedHistoryRequest): Promise<SharedHistoryRecoveryEvidence | undefined> {
    validateRequest(request);
    return await this.readRecovery(join(request.poolRoot, request.kind), request.kind);
  }

  async materialize(request: SharedHistoryRequest): Promise<SharedHistoryPreview> {
    let lastConcurrentFailure: SharedHistoryMigrationError | undefined;
    for (let attempt = 1; attempt <= MAX_CONCURRENT_RETRIES; attempt++) {
      const plan = await this.plan(request);
      assertNoRefusals(plan);
      try {
        await this.execute(plan);
        return withoutActions(plan);
      } catch (error) {
        if (
          error instanceof SharedHistoryMigrationError &&
          error.operationError instanceof SharedHistoryConcurrentChangeError &&
          error.rollbackFailures.length === 0
        ) {
          lastConcurrentFailure = error;
          continue;
        }
        throw error;
      }
    }
    throw new SharedHistoryMigrationError(
      new Error(
        `shared-history state kept changing across ${MAX_CONCURRENT_RETRIES} attempts; retry when the ${request.kind} homes are idle`,
        { cause: lastConcurrentFailure },
      ),
      [],
    );
  }

  private async plan(request: SharedHistoryRequest): Promise<SharedHistoryPlan> {
    validateRequest(request);
    const pool = join(request.poolRoot, request.kind);
    const entries = sharedHistoryEntries(request.kind);
    const poolRoot = await this.files.snapshot(pool, { recursive: false });
    if (poolRoot !== undefined && poolRoot.kind !== 'directory') {
      throw new Error(`shared-history pool must be a directory: ${pool}`);
    }
    const recovery = await this.readRecovery(pool, request.kind);
    if (recovery !== undefined) throw new SharedHistoryRecoveryRequiredError(recovery);
    const poolDeviceId = await this.files.deviceIdOf(pool);

    const refusals: SharedHistoryRefusal[] = [];
    const homes: SharedHistoryObservedHome[] = [];
    const resolvedHomes = new Map<string, string>();
    for (const home of request.homes) {
      const observed = await this.observeHome(home, entries, pool, resolvedHomes, refusals);
      if (observed !== undefined) homes.push(observed);
    }

    const deep = new Set(
      entries
        .filter(entry =>
          homes.some(home =>
            sharedHistoryEntryNeedsPooledTree(
              home.entries[entry.name],
              join(home.path, entry.name),
              join(pool, entry.name),
            ),
          ),
        )
        .map(entry => entry.name),
    );
    const poolEntries = Object.fromEntries(
      await Promise.all(
        entries.map(async entry => [
          entry.name,
          await this.files.snapshot(join(pool, entry.name), {
            readText: entry.merge === 'jsonl' && deep.has(entry.name),
            recursive: deep.has(entry.name),
          }),
        ]),
      ),
    );
    const conflicts = await this.files.snapshot(join(pool, MIGRATION_CONFLICTS), { recursive: deep.size > 0 });
    if (conflicts !== undefined && conflicts.kind !== 'directory') {
      throw new Error(`shared-history conflicts path must be a directory: ${join(pool, MIGRATION_CONFLICTS)}`);
    }
    return planSharedHistory(request, { poolEntries, poolDeviceId, conflicts, homes, refusals });
  }

  private async observeHome(
    home: SharedHistoryHome,
    entries: readonly SharedHistoryEntry[],
    pool: string,
    resolvedHomes: Map<string, string>,
    refusals: SharedHistoryRefusal[],
  ): Promise<SharedHistoryObservedHome | undefined> {
    try {
      await this.resolveHomeRoot(home, pool, resolvedHomes);
      return {
        ...home,
        entries: Object.fromEntries(
          await Promise.all(
            entries.map(async entry => [
              entry.name,
              await this.files.snapshot(join(home.path, entry.name), { readText: entry.merge === 'jsonl' }),
            ]),
          ),
        ),
      };
    } catch (error) {
      if (!(error instanceof SharedHistoryAccessRefusedError)) throw error;
      refusals.push({ account: home.account, home: home.path, path: error.path, reason: error.message });
      return undefined;
    }
  }

  /**
   * Follow an account home that is itself a symbolic link, without ever following one of its entries.
   *
   * Operators do link a home into a bigger volume, and the confinement rule that matters is about
   * the real directory an operation lands in — which the filesystem adapter already decides on the
   * canonical path. So the link is followed here only to re-prove the two things a lexical check
   * could not: that the home does not resolve inside the pool, and that two accounts do not resolve
   * onto the same directory. Every entry underneath is still observed through the configured path
   * and its own final component is never followed.
   */
  private async resolveHomeRoot(
    home: SharedHistoryHome,
    pool: string,
    resolvedHomes: Map<string, string>,
  ): Promise<void> {
    const declared = resolve(home.path);
    let current = declared;
    let node = await this.files.snapshot(current, { recursive: false });
    for (let depth = 0; node?.kind === 'symbolic-link'; depth++) {
      if (depth === MAX_HOME_LINK_DEPTH) {
        throw new Error(
          `shared-history account home link chain is too deep to follow: ${home.path}; replace the link with a real directory`,
        );
      }
      current = resolve(dirname(current), node.target);
      node = await this.files.snapshot(current, { recursive: false });
    }
    if (node === undefined) {
      if (current === declared) return;
      throw new Error(
        `shared-history account home link ${home.path} points at a missing directory: ${current}; recreate that directory or repoint the link`,
      );
    }
    if (node.kind !== 'directory') {
      throw new Error(`shared-history account home must be a directory, found ${node.kind}: ${home.path}`);
    }
    if (pathIsInside(current, pool) || pathIsInside(pool, current)) {
      throw new Error(
        `shared-history home and pool must not overlap: ${home.path} resolves to ${current} and the pool is ${pool}; repoint the link outside the pool`,
      );
    }
    const owner = resolvedHomes.get(current);
    if (owner !== undefined) {
      throw new Error(
        `shared-history accounts ${owner} and ${home.account} resolve to the same home directory: ${current}; give each account its own directory`,
      );
    }
    resolvedHomes.set(current, home.account);
  }

  private async readRecovery(pool: string, kind: HarnessKind): Promise<SharedHistoryRecoveryEvidence | undefined> {
    const journalPath = join(pool, MIGRATION_JOURNAL);
    const progressPath = join(pool, MIGRATION_PROGRESS);
    const journalNode = await this.files.snapshot(journalPath, { readText: true });
    const progressNode = await this.files.snapshot(progressPath, { readText: true });
    const progress =
      progressNode === undefined
        ? undefined
        : parseMigrationRecord(
            migrationProgressSchema,
            'migration progress record',
            progressPath,
            readableText('migration progress record', progressPath, progressNode),
            kind,
            pool,
          );
    if (journalNode === undefined) {
      // The journal is removed before the progress record, so a progress record on its own means a
      // finished migration whose last unlink was interrupted. The next apply overwrites it.
      if (progress === undefined || progress.state === 'complete') return undefined;
      throw new Error(
        `shared-history progress record ${progressPath} reports state ${progress.state} but its journal is gone; the migration cannot be recovered automatically and must be inspected by hand`,
      );
    }
    const journal = parseMigrationRecord(
      migrationJournalSchema,
      'migration journal',
      journalPath,
      readableText('migration journal', journalPath, journalNode),
      kind,
      pool,
    );
    const completedAtLeast = Math.min(progress?.completed ?? 0, journal.actions.length);
    return {
      journalPath,
      progressPath,
      kind: journal.kind,
      pool: journal.pool,
      state: progress?.state ?? 'applying',
      completedAtLeast,
      totalActions: journal.actions.length,
      appliedActions: journal.actions.slice(0, completedAtLeast),
      uncertainAction: journal.actions[completedAtLeast],
      pendingActions: journal.actions.slice(completedAtLeast + 1),
      rollbackFailures: progress?.rollbackFailures ?? [],
    };
  }

  private async writeProgress(
    plan: SharedHistoryPlan,
    state: MigrationProgressState,
    completed: number,
    rollbackFailures?: readonly string[],
  ): Promise<void> {
    await this.files.writeTextAtomic(
      join(plan.pool, MIGRATION_PROGRESS),
      `${JSON.stringify({
        version: 1,
        kind: plan.kind,
        pool: plan.pool,
        state,
        completed,
        ...(rollbackFailures === undefined ? {} : { rollbackFailures }),
      })}\n`,
    );
  }

  /**
   * Apply the plan, leaving a crash-durable record whose cost does not grow with the plan.
   *
   * The action list is written once, exclusively, before the first mutation; after that only a
   * fixed-size cursor is rewritten, so a thousand-action migration writes a thousand small records
   * instead of a thousand copies of itself. The cursor advances only after the mutation it counts is
   * durable, which makes it a lower bound: recovery treats the next action as possibly half applied.
   */
  private async execute(plan: SharedHistoryPlan): Promise<void> {
    if (plan.actions.length === 0) return;
    const journalPath = join(plan.pool, MIGRATION_JOURNAL);
    const progressPath = join(plan.pool, MIGRATION_PROGRESS);
    const undo: Undo[] = [];
    let journalCreated = false;
    let completed = 0;
    try {
      await this.files.writeTextExclusive(
        journalPath,
        `${JSON.stringify({ version: 1, kind: plan.kind, pool: plan.pool, actions: plan.actions }, null, 2)}\n`,
      );
      journalCreated = true;
      await this.writeProgress(plan, 'applying', completed);
      for (const action of plan.actions) {
        await this.executeOne(action, undo);
        completed++;
        await this.writeProgress(plan, 'applying', completed);
      }
      await this.writeProgress(plan, 'complete', completed);
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const restore of undo.toReversed()) {
        try {
          await restore();
        } catch (rollbackError) {
          rollbackFailures.push(errorMessage(rollbackError));
        }
      }
      if (journalCreated) await this.closeJournal(plan, completed, rollbackFailures);
      throw new SharedHistoryMigrationError(error, rollbackFailures);
    }
    // Committed. The durable record now says every action landed, so retiring it is cleanup and
    // never a reason to undo the work — a rollback here would delete the action list first and
    // then destroy the state that list describes.
    try {
      await this.files.removeFile(journalPath);
    } catch (error) {
      throw new Error(
        `shared-history migration completed but its journal could not be retired: ${errorMessage(error)}; every action in ${journalPath} was applied, so remove it and ${progressPath} before the next apply`,
      );
    }
    try {
      await this.files.removeFile(progressPath);
    } catch {
      // A progress record with no journal is harmless residue from an interrupted cleanup: the next
      // apply reads it as a finished migration and overwrites it. Failing here would report a
      // migration that fully succeeded as a failure.
    }
  }

  /**
   * Retire the crash record, or keep it and say why.
   *
   * A clean rollback leaves nothing applied, so the record has no reader and both files go. An
   * incomplete one keeps them: the journal still holds the action list, and the progress record
   * gains the failures, because deleting the only account of what is half migrated is the one
   * unrecoverable move.
   */
  private async closeJournal(plan: SharedHistoryPlan, completed: number, rollbackFailures: string[]): Promise<void> {
    if (rollbackFailures.length > 0) {
      try {
        await this.writeProgress(plan, 'rollback-incomplete', completed, [...rollbackFailures]);
      } catch (error) {
        rollbackFailures.push(`could not update migration progress record: ${errorMessage(error)}`);
      }
      return;
    }
    try {
      await this.files.removeFile(join(plan.pool, MIGRATION_JOURNAL));
      // The cursor may never have been written: a failure before the first action leaves only the
      // journal, and reporting a phantom cleanup failure would hide the real one.
      const progressPath = join(plan.pool, MIGRATION_PROGRESS);
      if ((await this.files.snapshot(progressPath)) !== undefined) await this.files.removeFile(progressPath);
    } catch (error) {
      rollbackFailures.push(`could not remove the migration crash record after rollback: ${errorMessage(error)}`);
    }
  }

  /**
   * Undo a rename, but only once it is established that the rename happened.
   *
   * A mutation can fail after it has already changed the filesystem — a rename that succeeded and
   * then failed to sync its parent directory is still a rename. So every undo is registered before
   * its mutation and decides from observed state whether there is anything to reverse; registering
   * afterwards would silently drop exactly the half-applied action a crash record exists for.
   */
  private undoMove(source: string, destination: string): Undo {
    return async () => {
      if ((await this.files.snapshot(destination)) === undefined) return;
      await this.files.move(destination, source);
    };
  }

  private async executeOne(action: SharedHistoryAction, undo: Undo[]): Promise<void> {
    if (action.kind === 'ensure-entry') {
      undo.push(async () => {
        const current = await this.files.snapshot(action.path);
        if (current === undefined) return;
        if (nodeIsEmpty(current)) {
          if (current.kind === 'directory') await this.files.removeEmptyDirectory(action.path);
          else if (current.kind === 'file') await this.files.removeFile(action.path);
          return;
        }
        if ((await this.files.snapshot(action.restoreTo)) === undefined) {
          await this.files.move(action.path, action.restoreTo);
        }
        // If the original destination has already been restored, retain this second copy. Losing
        // newly-written evidence merely to make rollback cosmetically exact would be destructive.
      });
      if (action.entryType === 'directory') await this.files.ensureDirectory(action.path);
      else await this.files.ensureFile(action.path);
      return;
    }
    if (action.kind === 'move') {
      undo.push(this.undoMove(action.source, action.destination));
      await this.files.move(action.source, action.destination);
      return;
    }
    if (action.kind === 'merge-jsonl') {
      const source = await this.files.snapshot(action.source, { readText: true });
      const destination = await this.files.snapshot(action.destination, { readText: true });
      if (source?.kind !== 'file' || source.text !== action.expectedSource) {
        throw new SharedHistoryConcurrentChangeError(action.source);
      }
      if (destination?.kind !== 'file' || destination.text !== action.expectedDestination) {
        throw new SharedHistoryConcurrentChangeError(action.destination);
      }
      undo.push(this.undoMove(action.source, action.preservedAt));
      await this.files.move(action.source, action.preservedAt);
      const preserved = await this.files.snapshot(action.preservedAt, { readText: true });
      if (preserved?.kind !== 'file' || preserved.text !== action.expectedSource) {
        throw new SharedHistoryConcurrentChangeError(action.preservedAt);
      }
      // A completed append is deliberately never reversed. Reversing it means truncating, and a
      // truncate deletes whatever a live harness appended after us. The appended lines are the
      // account's own, they are still in the quarantined copy this rollback restores, and a replan
      // finds the pool already holding them and adds nothing — safe, and idempotent.
      //
      // An append that THREW is the different case: it may have written some of its bytes, so the
      // pooled file may end in half a line. That cannot be undone and must not be reported as a
      // clean rollback, because a clean rollback retires the journal — the only record of it.
      let appendSettled = false;
      undo.push(async () => {
        if (appendSettled) return;
        throw new Error(
          `shared-history rollback cannot undo a partial append to ${action.destination}: an append is only reversible by deleting bytes, and this one never reported success, so the pooled file may end in a truncated line; compare it against ${action.preservedAt}`,
        );
      });
      const appended = await this.files.appendTextIfPrefix(
        action.destination,
        action.expectedDestination,
        action.addition,
      );
      appendSettled = true;
      if (!appended) throw new SharedHistoryConcurrentChangeError(action.destination);
      const stableSource = await this.files.snapshot(action.preservedAt, { readText: true });
      if (stableSource?.kind !== 'file' || stableSource.text !== action.expectedSource) {
        throw new SharedHistoryConcurrentChangeError(action.preservedAt);
      }
      return;
    }
    if (action.kind === 'remove-empty-directory') {
      undo.push(async () => {
        if ((await this.files.snapshot(action.path)) !== undefined) return;
        await this.files.ensureDirectory(action.path);
      });
      try {
        await this.files.removeEmptyDirectory(action.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
          throw new SharedHistoryConcurrentChangeError(action.path);
        }
        throw error;
      }
      return;
    }
    undo.push(async () => {
      if ((await this.files.snapshot(action.path)) === undefined) return;
      await this.files.removeSymbolicLink(action.path, action.target);
    });
    await this.files.createSymbolicLink(action.target, action.path);
  }
}

/** A partly observed fleet is never migrated: the plan may show it, but an apply refuses it. */
function assertNoRefusals(plan: SharedHistoryPlan): void {
  const refusals = plan.refusals ?? [];
  if (refusals.length === 0) return;
  throw new Error(
    `refusing to migrate ${plan.kind} history while ${refusals.length} account home(s) cannot be read: ${refusals
      .map(refusal => `${refusal.account} (${refusal.home}): ${refusal.reason}`)
      .join('; ')}`,
  );
}
