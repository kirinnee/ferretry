import { basename, dirname, join } from 'node:path';
import type { FileIdentity, HostFs } from './adapters/node-fs.ts';

/**
 * The index of the home's private places (§7.7): the identity (device and inode) of every private place and of what a
 * private FOLDER holds, to a bounded depth, so a file bind mounted or aliased out of one under any name is recognised
 * by every root. It is computed once and kept, and it is kept INCREMENTALLY: every folder it looked at is remembered
 * with what was in it, each answer looks at those folders again (one identity per folder, never a file) and re-reads
 * only the folders that changed — a created, replaced or removed member always changes its folder's times, so a
 * write into one session folder costs one folder, not the whole tree.
 *
 * What bounds it, and what the bound does:
 * - every declared place has its OWN budget ({@link MEMBER_LIMIT} places for a tree, {@link PATTERN_LIMIT} for a `*`
 *   collection such as each ferret session's `environment.json`), so a place that holds thousands of folders can never starve
 *   another declared place of its files (a login's `auth.json` is pinned however many sessions there are);
 * - a private folder is pinned whole by its own identity however large it is (a walk THROUGH it is held), and what it
 *   holds is indexed breadth first, so the shallow files that matter come before the deep ones, to {@link MEMBER_DEPTH}
 *   levels. A folder met at the depth limit is itself pinned though its members are not looked at;
 * - past a place's budget the rest are not indexed and the snapshot FAILS CLOSED: the tree is `truncated`, and the
 *   guard refuses every entry on that tree's device, because an alias of an unindexed member (a bind mount keeps its
 *   source's device) cannot be told from any other file there. Only an entry on another device is proven not to be
 *   one. That a single file beyond the DEPTH bound is not recognised under a second name is the declared GAP.
 *
 * A change is noticed by the folder's identity including its modification and status-change times to the nanosecond.
 * A folder whose last change is too close to the moment it was looked at to tell apart from the next one (the
 * filesystem's clock has a step, {@link RACY_NS}) is "racy": it is read again at the next look, whatever its identity
 * says, until it is old enough to trust.
 */

/** How many folder levels below a private folder are indexed (`credentials/<id>/auth.json` is two). */
const MEMBER_DEPTH = 3;
/** How many places one private TREE holds (its head and what it holds): its own budget, never shared. */
const MEMBER_LIMIT = 4096;
/** How many members one `*` collection holds (one folder, and the file pinned in it, per member): its own budget. */
const PATTERN_LIMIT = 65_536;
/** A change this close to a look is not told apart from a later one in the same filesystem tick: read it again. */
const RACY_NS = 20_000_000n;

/** The longest the host may go between two looks at the folders the index was built from. */
const MAX_RECHECK_MS = 5000;
/** How often the host looks at the folders again when nothing sound was asked for. */
export const DEFAULT_RECHECK_MS = 250;

/**
 * The look interval that is used for `value`: a finite, non-negative number not above {@link MAX_RECHECK_MS} is
 * itself, anything else (`Infinity`, `NaN`, a negative, a string that got through a cast) is {@link DEFAULT_RECHECK_MS}.
 * An interval that never ends would index once and never look again.
 */
export const recheckIntervalOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_RECHECK_MS
    ? value
    : DEFAULT_RECHECK_MS;

/** How far the index looks into a private folder: how many levels, and how many places each declared place may hold. */
interface IndexBounds {
  readonly depth: number;
  readonly limit: number;
  /** The budget of a `*` collection; absent: {@link PATTERN_LIMIT}. */
  readonly patternLimit?: number;
}

/** A place's identity as one comparable key: what a bind mount or a second name keeps the same. */
export const identityKey = (identity: { readonly device: bigint; readonly inode: bigint }): string =>
  `${identity.device}:${identity.inode}`;

/** One private place of the home: where it was found, and the key of what is there. */
interface IndexedPlace {
  readonly path: string;
  readonly key: string;
  readonly device: bigint;
  readonly inode: bigint;
}

/** A private tree whose members were not all indexed: where, and the device an alias of one of them would show. */
interface ClosedTree {
  readonly path: string;
  readonly device: bigint;
}

/** What the home's private places were when last looked at. */
export interface PrivateSnapshot {
  readonly places: readonly IndexedPlace[];
  /** Every folder the snapshot was computed from, and what it was then (absent: nothing there). */
  readonly watched: ReadonlyMap<string, FileIdentity | undefined>;
  /** The places whose members were not all indexed (a budget was reached). */
  readonly truncated: readonly string[];
  /** The same trees with their device: what the guard refuses wholesale, because it cannot prove an entry there is public. */
  readonly closed: readonly ClosedTree[];
}

/** What a private place is declared as, relative to the home: a path, with at most one `*` meaning "each member". */
export interface IndexInput {
  /** Home-relative places pinned by their own identity, never looked into (the key paths, the internal root folders). */
  readonly pins: (stateEntries: readonly string[]) => readonly string[];
  /** Home-relative private places (`state/<id>/<path>`, a `*` segment standing for each member of that folder). */
  readonly private: readonly string[];
}

/** Whether a folder is not what it was. Times are compared to the nanosecond; a folder that appeared or vanished changed. */
const changed = (before: FileIdentity | undefined, now: FileIdentity | undefined): boolean =>
  before === undefined || now === undefined
    ? before !== now
    : before.device !== now.device ||
      before.inode !== now.inode ||
      before.mtimeNs !== now.mtimeNs ||
      before.ctimeNs !== now.ctimeNs ||
      before.size !== now.size ||
      before.links !== now.links;

/** What was remembered of one folder: what it was, and what was learned of it since. */
interface FolderRecord {
  readonly identity: FileIdentity | undefined;
  /** Its last change is too close to the look to be trusted: it is read again at the next one. */
  readonly racy: boolean;
  names?: readonly string[];
  /** The identity of each member asked about (absent from the map: not asked yet; a value of `undefined`: nothing there). */
  readonly child: Map<string, FileIdentity | undefined>;
}

/** The records of every folder the last successful scan visited, kept between scans. */
interface Memory {
  records: Map<string, FolderRecord>;
  /** A record was replaced since the last snapshot was made: the places may differ. */
  dirty: boolean;
}

/** The wall clock in nanoseconds, comparable with the times a filesystem stamps. */
const wallNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

const racyAt = (identity: FileIdentity | undefined, lookedAt: bigint): boolean =>
  identity !== undefined && identity.ctimeNs + RACY_NS >= lookedAt;

interface Budget {
  left: number;
}

async function build(
  fs: HostFs,
  real: string,
  input: IndexInput,
  bounds: IndexBounds,
  memory: Memory,
  wall: () => bigint,
  previous: PrivateSnapshot | undefined,
): Promise<PrivateSnapshot> {
  const visited = new Map<string, FolderRecord>();
  const places: IndexedPlace[] = [];
  const truncated: string[] = [];
  const closed: ClosedTree[] = [];
  const add = (path: string, identity: FileIdentity | undefined): void => {
    if (identity !== undefined)
      places.push({ path, key: identityKey(identity), device: identity.device, inode: identity.inode });
  };

  // Every folder the last scan visited is looked at in ONE parallel batch, before anything is listed: the look costs the
  // slowest lstat of a batch, not their sum. A failure rejects the scan (a folder that cannot be looked at is never kept).
  const known = [...memory.records.keys()];
  const batchAt = wall();
  const batch = new Map(
    (await Promise.all(known.map(async folder => await fs.identity(folder)))).map((found, at) => [
      known[at] as string,
      found,
    ]),
  );

  /** A folder as it is NOW (one identity), its record kept while it has not changed. Looked at once per scan, BEFORE it is listed. */
  const visit = async (folder: string): Promise<FolderRecord> => {
    const seen = visited.get(folder);
    if (seen !== undefined) return seen;
    const prefetched = batch.has(folder);
    const lookedAt = prefetched ? batchAt : wall();
    const identity = prefetched ? batch.get(folder) : await fs.identity(folder);
    const kept = memory.records.get(folder);
    let record: FolderRecord;
    if (kept !== undefined && !kept.racy && !changed(kept.identity, identity)) record = kept;
    else {
      record = { identity, racy: racyAt(identity, lookedAt), child: new Map() };
      memory.records.set(folder, record);
      memory.dirty = true;
    }
    visited.set(folder, record);
    return record;
  };
  /** The names in a folder. A folder that cannot be listed throws: it is never read as empty. */
  const namesIn = async (folder: string): Promise<readonly string[]> => {
    const record = await visit(folder);
    record.names ??= await fs.list(folder);
    return record.names;
  };
  /** The identity of one member of a folder, looked at once while the folder stays as it is. */
  const memberOf = async (folder: string, name: string): Promise<FileIdentity | undefined> => {
    const record = await visit(folder);
    if (!record.child.has(name)) record.child.set(name, await fs.identity(join(folder, name)));
    return record.child.get(name);
  };
  const pick = async (path: string): Promise<FileIdentity | undefined> => await memberOf(dirname(path), basename(path));

  /** The tree below `start`, breadth first, each member a place, until the budget is spent. */
  const walk = async (start: string, depth: number, budget: Budget, tree: ClosedTree): Promise<void> => {
    let level = [start];
    for (let at = 0; at < depth && level.length > 0; at += 1) {
      const next: string[] = [];
      for (const folder of level) {
        for (const name of await namesIn(folder)) {
          if (budget.left <= 0) {
            truncated.push(tree.path);
            closed.push(tree);
            return;
          }
          const identity = await memberOf(folder, name);
          add(join(folder, name), identity);
          budget.left -= 1;
          if (identity?.kind === 'directory') next.push(join(folder, name));
        }
      }
      level = next;
    }
  };

  const state = join(real, 'state');
  const stateEntries = await namesIn(state);

  // A pin is one identity; its parent is watched so one made later is looked at. A pin spends no budget.
  for (const pin of input.pins(stateEntries)) add(join(real, pin), await pick(join(real, pin)));

  for (const declared of input.private) {
    const segments = declared.split('/');
    const star = segments.findIndex(segment => segment.includes('*'));
    // A `*` that is the whole segment means "each member"; one inside a name (`*-token.json`) pins the folder and what it holds.
    const each = star !== -1 && segments[star] === '*';
    const head = star === -1 ? declared : segments.slice(0, star).join('/');
    const headPath = join(real, head);
    const identity = await pick(headPath);
    add(headPath, identity);
    if (identity?.kind !== 'directory') continue;
    const tree: ClosedTree = { path: headPath, device: identity.device };
    // The head is one of the place's own: its budget is what is left for what the head holds.
    const budget: Budget = { left: (each ? (bounds.patternLimit ?? PATTERN_LIMIT) : bounds.limit) - 1 };
    if (!each) {
      await walk(headPath, bounds.depth, budget, tree);
      continue;
    }
    // `folder/*/rest`: the named path inside each member of `folder`.
    const rest = segments.slice(star + 1).join('/');
    for (const name of await namesIn(headPath)) {
      if (budget.left <= 0) {
        truncated.push(headPath);
        closed.push(tree);
        break;
      }
      const member = join(headPath, name);
      const target = rest === '' ? member : join(member, rest);
      const found = rest === '' ? await memberOf(headPath, name) : await pick(target);
      add(target, found);
      budget.left -= 1;
      if (found?.kind === 'directory') await walk(target, bounds.depth, budget, tree);
    }
  }

  // What this scan did not visit is no longer watched; a failed scan (a throw above) keeps what it learned.
  for (const folder of memory.records.keys()) if (!visited.has(folder)) memory.records.delete(folder);
  if (previous !== undefined && !memory.dirty) return previous;
  memory.dirty = false;
  return {
    places,
    watched: new Map([...visited].map(([folder, record]) => [folder, record.identity])),
    truncated,
    closed,
  };
}

/** The kept index of one home: the snapshot, and the one scan in flight when it has to be redone. */
export interface PrivateIndex {
  /** The places now: the kept snapshot when its folders are unchanged, else a fresh one. Throws when the home cannot be looked at. */
  readonly snapshot: () => Promise<PrivateSnapshot>;
}

/** How an index is looked at again, and what it may hold. Every field is for a test; the host uses the defaults but the interval. */
export interface IndexOptions {
  /** At most this many milliseconds pass between two looks (default 0: every answer looks); see {@link recheckIntervalOf}. */
  readonly recheckMs?: number;
  /** A monotonic clock, in milliseconds. */
  readonly now?: () => number;
  readonly bounds?: IndexBounds;
  /** The wall clock in nanoseconds, to tell a change that is too recent to trust from one that is not. */
  readonly wall?: () => bigint;
}

/**
 * The index of the home at `real` for `input`. At most the interval of milliseconds passes between two looks at the
 * folders a snapshot was computed from; a place created or replaced is indexed at the next look, so that is also the
 * longest one stays unrecognised.
 */
export function privateIndexOf(fs: HostFs, real: string, input: IndexInput, options: IndexOptions = {}): PrivateIndex {
  const recheckMs = options.recheckMs === undefined ? 0 : recheckIntervalOf(options.recheckMs);
  const now = options.now ?? ((): number => performance.now());
  const bounds = options.bounds ?? { depth: MEMBER_DEPTH, limit: MEMBER_LIMIT };
  const wall = options.wall ?? wallNs;
  const memory: Memory = { records: new Map(), dirty: false };
  let kept: PrivateSnapshot | undefined;
  let lookedAt = Number.NEGATIVE_INFINITY;
  let tail: Promise<unknown> = Promise.resolve();
  const refresh = async (): Promise<PrivateSnapshot> => {
    if (kept !== undefined && now() - lookedAt < recheckMs) return kept;
    const started = now();
    kept = await build(fs, real, input, bounds, memory, wall, kept);
    lookedAt = started;
    return kept;
  };
  return {
    // Answers that arrive together are looked at one after the other: the second finds what the first kept. A failure is not kept.
    snapshot: () => {
      const run = tail.then(refresh, refresh);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
