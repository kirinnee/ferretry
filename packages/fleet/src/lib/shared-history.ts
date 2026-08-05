/**
 * Cross-account harness history, planned before it is moved.
 *
 * Claude and Codex each get one independent pool. Existing state is renamed into that pool and
 * each account home receives absolute symlinks back to it. Rename-based directory migration keeps
 * live transcript inodes intact; prompt-history merges rewrite the already-pooled file in place so
 * its inode also remains stable. Filesystem observation and mutation sit behind
 * {@link SharedHistoryFileSystem}; all merge, collision, dry-run and rollback decisions live here.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HarnessKind } from './manifest.ts';

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
  /** Populated only when the caller asks for the root file's text. */
  readonly text?: string;
}

export interface SharedHistoryDirectoryNode {
  readonly kind: 'directory';
  readonly modifiedAtMs: number;
  readonly children: Readonly<Record<string, SharedHistoryNode>>;
}

export interface SharedHistorySymbolicLinkNode {
  readonly kind: 'symbolic-link';
  readonly modifiedAtMs: number;
  readonly target: string;
}

export interface SharedHistoryOtherNode {
  readonly kind: 'other';
  readonly modifiedAtMs: number;
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
 * unreadable state as empty.
 */
export interface SharedHistoryFileSystem {
  snapshot(
    path: string,
    options?: { readonly readText?: boolean; readonly recursive?: boolean },
  ): Promise<SharedHistoryNode | undefined>;
  ensureDirectory(path: string): Promise<boolean>;
  ensureFile(path: string): Promise<boolean>;
  move(source: string, destination: string): Promise<void>;
  /** Create, write and durably sync a new file; refuse rather than replace an existing path. */
  writeTextExclusive(path: string, text: string): Promise<void>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  /** Compare and rewrite one regular file through its existing inode. */
  rewriteTextInPlace(path: string, expected: string, text: string): Promise<boolean>;
  createSymbolicLink(target: string, path: string): Promise<void>;
  removeSymbolicLink(path: string, expectedTarget: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
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

/** The exact read-only report used by dry-run and returned after a successful materialization. */
export interface SharedHistoryPreview {
  readonly kind: HarnessKind;
  readonly pool: string;
  readonly migrated: number;
  readonly conflicts: number;
  readonly links: number;
  readonly changes: readonly SharedHistoryChange[];
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
      readonly expectedDestination: string;
      readonly content: string;
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
  readonly conflicts: SharedHistoryNode | undefined;
  readonly homes: readonly SharedHistoryObservedHome[];
}

interface PlanningState {
  readonly actions: SharedHistoryAction[];
  readonly changes: SharedHistoryChange[];
  readonly occupiedConflicts: Set<string>;
  readonly conflictNodes: ReadonlyMap<string, SharedHistoryNode>;
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
    if (!/^[a-zA-Z0-9._-]+$/.test(home.account) || home.account === '.' || home.account === '..') {
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

function emptyNode(type: SharedHistoryEntryType): SharedHistoryNode {
  return type === 'directory'
    ? { kind: 'directory', modifiedAtMs: 0, children: {} }
    : { kind: 'file', modifiedAtMs: 0, size: 0, text: '' };
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

interface TimestampedLine {
  readonly line: string;
  readonly timestamp: number;
}

function timestamped(line: string): TimestampedLine {
  let timestamp = Number.POSITIVE_INFINITY;
  try {
    const parsed = JSON.parse(line) as { readonly timestamp?: unknown; readonly ts?: unknown };
    const candidate = parsed.timestamp ?? parsed.ts;
    if (typeof candidate === 'number') timestamp = candidate;
  } catch {
    // Vendor history can contain an unparseable line. Preserve it at the end rather than erasing evidence.
  }
  return { line, timestamp };
}

/** Union prompt-history JSONL without dropping malformed evidence; equal timestamps stay stable. */
export function mergeSharedHistoryJsonl(...documents: readonly string[]): string {
  const unique = new Set<string>();
  for (const document of documents) {
    for (const line of document.split('\n')) if (line.trim().length > 0) unique.add(line);
  }
  const lines = [...unique].map(timestamped).sort((left, right) => left.timestamp - right.timestamp);
  return lines.length === 0 ? '' : `${lines.map(item => item.line).join('\n')}\n`;
}

function conflictRoot(pool: string, account: string): string {
  return join(pool, '.migration-conflicts', account);
}

function planForeignLink(
  state: PlanningState,
  account: string,
  source: string,
  poolPath: string,
  sourceNode: SharedHistorySymbolicLinkNode,
): void {
  const preservedAt = reserveConflictPath(join(conflictRoot(dirname(poolPath), account), basename(poolPath)), state);
  state.actions.push({ kind: 'move', source, destination: preservedAt });
  state.changes.push({
    kind: 'collision',
    incoming: source,
    pooled: poolPath,
    winner: poolPath,
    loser: source,
    preservedAt,
  });
  state.conflicts++;
  // Referencing the node makes the preflight intent explicit: the link itself is preserved, never followed.
  void sourceNode;
}

function planDirectoryMerge(
  state: PlanningState,
  account: string,
  pool: string,
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
      state.actions.push({ kind: 'move', source: incomingPath, destination: existingPath });
      state.changes.push({ kind: 'move', source: incomingPath, destination: existingPath });
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
          pool,
          join(entryRelativePath, name),
          incomingPath,
          existingPath,
          incoming,
          existing,
        ),
      };
      continue;
    }

    const incomingWins = incoming.modifiedAtMs > existing.modifiedAtMs;
    const loser = incomingWins ? existingPath : incomingPath;
    const winner = incomingWins ? incomingPath : existingPath;
    const preservedAt = reserveConflictPath(join(conflictRoot(pool, account), entryRelativePath, name), state);
    if (incomingWins) {
      state.actions.push({ kind: 'move', source: existingPath, destination: preservedAt });
      state.actions.push({ kind: 'move', source: incomingPath, destination: existingPath });
      children = { ...children, [name]: incoming };
    } else {
      state.actions.push({ kind: 'move', source: incomingPath, destination: preservedAt });
    }
    state.changes.push({
      kind: 'collision',
      incoming: incomingPath,
      pooled: existingPath,
      winner,
      loser,
      preservedAt,
    });
    state.conflicts++;
  }
  state.actions.push({ kind: 'remove-empty-directory', path: sourcePath });
  return { ...pooled, children };
}

function planJsonlMerge(
  state: PlanningState,
  account: string,
  sourcePath: string,
  pooledPath: string,
  source: SharedHistoryFileNode,
  pooled: SharedHistoryFileNode,
  pool: string,
): SharedHistoryFileNode {
  if (source.text === undefined || pooled.text === undefined) {
    throw new Error(`history JSONL was not read completely: ${sourcePath} or ${pooledPath}`);
  }
  const sourcePreservedAt = reserveConflictPath(join(conflictRoot(pool, account), basename(sourcePath)), state);
  const merged = mergeSharedHistoryJsonl(pooled.text, source.text);
  state.actions.push({
    kind: 'merge-jsonl',
    source: sourcePath,
    destination: pooledPath,
    preservedAt: sourcePreservedAt,
    expectedSource: source.text,
    expectedDestination: pooled.text,
    content: merged,
  });
  state.changes.push({
    kind: 'merge-jsonl',
    source: sourcePath,
    destination: pooledPath,
    sourcePreservedAt,
  });
  state.migrated++;
  return {
    kind: 'file',
    modifiedAtMs: Math.max(source.modifiedAtMs, pooled.modifiedAtMs),
    size: new TextEncoder().encode(merged).byteLength,
    text: merged,
  };
}

function planEntry(
  state: PlanningState,
  entry: SharedHistoryEntry,
  account: string,
  homePath: string,
  pool: string,
  source: SharedHistoryNode | undefined,
  pooled: SharedHistoryNode | undefined,
): SharedHistoryNode {
  const sourcePath = join(homePath, entry.name);
  const pooledPath = join(pool, entry.name);
  assertHomeNode(entry, source, sourcePath);
  assertPoolNode(entry, pooled, pooledPath);

  if (source?.kind === 'symbolic-link' && equivalentLink(sourcePath, source.target, pooledPath)) {
    const next = pooled ?? emptyNode(entry.type);
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
      state.actions.push({ kind: 'move', source: sourcePath, destination: pooledPath });
      state.changes.push({ kind: 'move', source: sourcePath, destination: pooledPath });
      state.migrated++;
      next = source;
    } else {
      state.actions.push({ kind: 'ensure-entry', path: pooledPath, entryType: entry.type, restoreTo: sourcePath });
      state.changes.push({ kind: 'create-pooled-entry', path: pooledPath, entryType: entry.type });
      next = emptyNode(entry.type);
    }
  } else if (source?.kind === 'directory' && next.kind === 'directory') {
    next = planDirectoryMerge(state, account, pool, entry.name, sourcePath, pooledPath, source, next);
  } else if (source?.kind === 'file' && next.kind === 'file' && entry.merge === 'jsonl') {
    next = planJsonlMerge(state, account, sourcePath, pooledPath, source, next, pool);
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
  const conflictsRoot = join(pool, '.migration-conflicts');
  const conflictNodes = new Map<string, SharedHistoryNode>();
  const state: PlanningState = {
    actions: [],
    changes: [],
    occupiedConflicts: new Set<string>(),
    conflictNodes,
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
        [entry.name]: planEntry(
          state,
          entry,
          home.account,
          home.path,
          pool,
          home.entries[entry.name],
          pooled[entry.name],
        ),
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

const MIGRATION_JOURNAL = '.migration-journal';
const MAX_CONCURRENT_RETRIES = 3;

interface MigrationJournal {
  readonly version: 1;
  readonly kind: HarnessKind;
  readonly pool: string;
  readonly state: 'applying' | 'rollback-incomplete';
  readonly completed: number;
  readonly actions: readonly SharedHistoryAction[];
  readonly rollbackFailures?: readonly string[];
}

function migrationJournalText(journal: MigrationJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
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

  async materialize(request: SharedHistoryRequest): Promise<SharedHistoryPreview> {
    let lastConcurrentFailure: SharedHistoryMigrationError | undefined;
    for (let attempt = 1; attempt <= MAX_CONCURRENT_RETRIES; attempt++) {
      const plan = await this.plan(request);
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
    const journalPath = join(pool, MIGRATION_JOURNAL);
    const poolRoot = await this.files.snapshot(pool, { recursive: false });
    if (poolRoot !== undefined && poolRoot.kind !== 'directory') {
      throw new Error(`shared-history pool must be a directory: ${pool}`);
    }
    const journal = await this.files.snapshot(journalPath, { readText: true });
    if (journal !== undefined) {
      throw new Error(`unfinished shared-history migration journal requires recovery before retrying: ${journalPath}`);
    }
    const poolEntries = Object.fromEntries(
      await Promise.all(
        entries.map(async entry => [
          entry.name,
          await this.files.snapshot(join(pool, entry.name), { readText: entry.merge === 'jsonl' }),
        ]),
      ),
    );
    const conflicts = await this.files.snapshot(join(pool, '.migration-conflicts'));
    if (conflicts !== undefined && conflicts.kind !== 'directory') {
      throw new Error(`shared-history conflicts path must be a directory: ${join(pool, '.migration-conflicts')}`);
    }
    const homes = await Promise.all(
      request.homes.map(async home => {
        const homeRoot = await this.files.snapshot(home.path, { recursive: false });
        if (homeRoot !== undefined && homeRoot.kind !== 'directory') {
          throw new Error(`shared-history account home must be a directory: ${home.path}`);
        }
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
      }),
    );
    return planSharedHistory(request, { poolEntries, conflicts, homes });
  }

  private async execute(plan: SharedHistoryPlan): Promise<void> {
    if (plan.actions.length === 0) return;
    const journalPath = join(plan.pool, MIGRATION_JOURNAL);
    const undo: Undo[] = [];
    let journalCreated = false;
    let completed = 0;
    try {
      await this.files.writeTextExclusive(
        journalPath,
        migrationJournalText({
          version: 1,
          kind: plan.kind,
          pool: plan.pool,
          state: 'applying',
          completed,
          actions: plan.actions,
        }),
      );
      journalCreated = true;
      for (const action of plan.actions) {
        await this.executeOne(action, undo);
        completed++;
        await this.files.writeTextAtomic(
          journalPath,
          migrationJournalText({
            version: 1,
            kind: plan.kind,
            pool: plan.pool,
            state: 'applying',
            completed,
            actions: plan.actions,
          }),
        );
      }
      await this.files.removeFile(journalPath);
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const restore of undo.toReversed()) {
        try {
          await restore();
        } catch (rollbackError) {
          rollbackFailures.push(errorMessage(rollbackError));
        }
      }
      if (journalCreated) {
        if (rollbackFailures.length === 0) {
          try {
            await this.files.removeFile(journalPath);
          } catch (journalError) {
            rollbackFailures.push(`could not remove migration journal after rollback: ${errorMessage(journalError)}`);
          }
        } else {
          try {
            await this.files.writeTextAtomic(
              journalPath,
              migrationJournalText({
                version: 1,
                kind: plan.kind,
                pool: plan.pool,
                state: 'rollback-incomplete',
                completed,
                actions: plan.actions,
                rollbackFailures,
              }),
            );
          } catch (journalError) {
            rollbackFailures.push(`could not update migration journal: ${errorMessage(journalError)}`);
          }
        }
      }
      throw new SharedHistoryMigrationError(error, rollbackFailures);
    }
  }

  private async executeOne(action: SharedHistoryAction, undo: Undo[]): Promise<void> {
    if (action.kind === 'ensure-entry') {
      const created =
        action.entryType === 'directory'
          ? await this.files.ensureDirectory(action.path)
          : await this.files.ensureFile(action.path);
      if (created) {
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
      }
      return;
    }
    if (action.kind === 'move') {
      await this.files.move(action.source, action.destination);
      undo.push(async () => await this.files.move(action.destination, action.source));
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
      await this.files.move(action.source, action.preservedAt);
      undo.push(async () => await this.files.move(action.preservedAt, action.source));
      const preserved = await this.files.snapshot(action.preservedAt, { readText: true });
      if (preserved?.kind !== 'file' || preserved.text !== action.expectedSource) {
        throw new SharedHistoryConcurrentChangeError(action.preservedAt);
      }
      const rewritten = await this.files.rewriteTextInPlace(
        action.destination,
        action.expectedDestination,
        action.content,
      );
      if (!rewritten) throw new SharedHistoryConcurrentChangeError(action.destination);
      undo.push(async () => {
        const restored = await this.files.rewriteTextInPlace(
          action.destination,
          action.content,
          action.expectedDestination,
        );
        if (!restored) throw new Error(`shared-history rollback found a changed file: ${action.destination}`);
      });
      const stableSource = await this.files.snapshot(action.preservedAt, { readText: true });
      if (stableSource?.kind !== 'file' || stableSource.text !== action.expectedSource) {
        throw new SharedHistoryConcurrentChangeError(action.preservedAt);
      }
      return;
    }
    if (action.kind === 'remove-empty-directory') {
      try {
        await this.files.removeEmptyDirectory(action.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
          throw new SharedHistoryConcurrentChangeError(action.path);
        }
        throw error;
      }
      undo.push(async () => {
        await this.files.ensureDirectory(action.path);
      });
      return;
    }
    await this.files.createSymbolicLink(action.target, action.path);
    undo.push(async () => await this.files.removeSymbolicLink(action.path, action.target));
  }
}
