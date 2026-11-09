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
 * What bounds the COST (so it stays flat however many ferret sessions a machine has ever made):
 * - a look re-reads nothing when no folder it looked at changed, and a snapshot that came out the same is the SAME
 *   snapshot, so what is built from it (a root's guard, an owner's fence) is built once, not on every look;
 * - the folders of a `*` collection's members (each ferret session's folder) are TIERED. One whose last change is
 *   older than {@link COLD_AFTER_MS} is "resting": a look does not touch it. Resting folders are looked at in
 *   rotating slices of {@link COLD_SLICE}, so one look costs the folders that changed lately plus one slice, never
 *   every folder ever made. A resting folder that changed is found when its slice comes round (at 512 a slice and a
 *   250 ms look, 5,000 sessions are all looked at in 2.5 s and 20,000 in 10 s) and is then hot again. A new member, or
 *   a folder that changed lately, is always looked at by the next look. That a replaced file in a RESTING folder is
 *   recognised only when its slice comes round is the staleness of the tiering; it cannot be used through an alias of
 *   the session FOLDER, because every member folder of the collection, one that holds the file or not, is pinned by its
 *   own identity (§7.7). A member folder REPLACED by another while it rests (renamed aside, made again under its name)
 *   is not pinned until its slice comes round: the declared GAP of §7.7.
 *
 * What bounds the SIZE, and what the bound does:
 * - every declared place has its OWN budget ({@link MEMBER_LIMIT} places for a tree, {@link PATTERN_LIMIT} for a `*`
 *   collection such as each ferret session's `environment.json`), so a place that holds thousands of folders can never starve
 *   another declared place of its files (a login's `auth.json` is pinned however many sessions there are). A `*`
 *   collection spends its budget only on a member that HOLDS the declared file: a session folder with no
 *   `environment.json` costs nothing against it;
 * - a private folder is pinned whole by its own identity however large it is (a walk THROUGH it is held), and what it
 *   holds is indexed breadth first, so the shallow files that matter come before the deep ones, to {@link MEMBER_DEPTH}
 *   levels. A folder met at the depth limit is itself pinned though its members are not looked at;
 * - past a place's budget the rest are not indexed and the snapshot FAILS CLOSED: the tree is `truncated`, and the
 *   guard refuses every entry on a device the tree's indexed places answer with (the folder's AND the files', which a
 *   disk may give different devices), because an alias of an unindexed member (a bind mount keeps its
 *   source's device) cannot be told from any other file there. Only an entry on another device is proven not to be
 *   one. That a single file beyond the DEPTH bound is not recognised under a second name is the declared GAP. A
 *   truncation is never silent: every change of what is truncated is announced to whoever watches the index.
 *
 * A change is noticed by the folder's identity including its modification and status-change times to the nanosecond.
 * A folder whose last change is too close to the moment it was looked at to tell apart from the next one (the
 * filesystem's clock has a step, {@link RACY_NS}, or {@link COARSE_RACY_NS} for one whose times carry no fraction of a
 * second) is "racy": it is read again at the next look, whatever its identity says, until it is old enough to trust.
 * A filesystem that gives no usable status-change time (zero) leaves every folder racy for ever: it is read again at
 * every look, never trusted.
 */

/** How many folder levels below a private folder are indexed (`credentials/<id>/auth.json` is two). */
const MEMBER_DEPTH = 3;
/** How many places one private TREE holds (its head and what it holds): its own budget, never shared. */
const MEMBER_LIMIT = 4096;
/** How many members one `*` collection holds (one pinned file per member that has it): its own budget. */
const PATTERN_LIMIT = 65_536;
/** A change this close to a look is not told apart from a later one in the same filesystem tick: read it again. */
const RACY_NS = 20_000_000n;
/** The same, on a filesystem whose times carry no fraction of a second (HFS+, FAT, some network mounts). */
const COARSE_RACY_NS = 2_000_000_000n;
/** A member folder unchanged this long is resting: a look does not touch it until its slice comes round. */
const COLD_AFTER_MS = 60_000;
/** How many resting member folders one look visits. */
const COLD_SLICE = 512;

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
  /** How long a member folder must stay unchanged to rest, in milliseconds; absent: {@link COLD_AFTER_MS}. */
  readonly coldAfterMs?: number;
  /** How many resting member folders one look visits; absent: {@link COLD_SLICE}. */
  readonly slice?: number;
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

/**
 * A private tree whose members were not all indexed: where, and the devices an alias of one of them would show. A bind
 * mount keeps the device of its SOURCE, and a disk need not give a file the device it gives the folder that holds it
 * (an overlay filesystem answers a folder with its own device and a file with the layer's), so the tree is closed on
 * EVERY device its indexed places answer with: the head's, a member folder's and a member file's.
 */
interface ClosedTree {
  readonly path: string;
  /** The device of the tree's head folder. */
  readonly device: bigint;
  /** Every device the head and the places indexed in the tree answer with (the head's included). */
  readonly devices: ReadonlySet<bigint>;
}

/** A declared place that reached its budget: where, how many places it was allowed, and how many were indexed. */
export interface PlaceBudget {
  readonly path: string;
  readonly limit: number;
  readonly indexed: number;
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
  /** Each place that reached its budget, with its limit and how many places were indexed: what is announced. */
  readonly budgets: readonly PlaceBudget[];
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
  /** A member folder of a `*` collection: it may rest ({@link COLD_AFTER_MS}) and is then looked at in slices. */
  readonly tiered: boolean;
  /** From this instant (wall clock, nanoseconds) the folder rests; absent: it never does (not a member folder, or racy). */
  readonly restFrom: bigint | undefined;
  names?: readonly string[];
  /** The identity of each member asked about (absent from the map: not asked yet; a value of `undefined`: nothing there). */
  readonly child: Map<string, FileIdentity | undefined>;
  /** The place pinned in this member folder, made once: a look that finds the folder as it was reuses it. */
  place?: IndexedPlace;
  /** The place of the member folder itself (its identity), pinned beside its file: made once, while the folder stays as it is. */
  folderPlace?: IndexedPlace;
}

/** The records of every folder the last successful scan visited, kept between scans. */
interface Memory {
  records: Map<string, FolderRecord>;
  /** A record was replaced since the last snapshot was made: the places may differ. */
  dirty: boolean;
  /** Where the next slice of resting folders starts. */
  cursor: number;
}

/** The wall clock in nanoseconds, comparable with the times a filesystem stamps. */
const wallNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

/** A filesystem that stamps whole seconds (or milliseconds) at best: its next change can land in the same tick. */
const racyWindowOf = (identity: FileIdentity): bigint =>
  identity.ctimeNs % 1_000_000n === 0n && identity.mtimeNs % 1_000_000n === 0n ? COARSE_RACY_NS : RACY_NS;

/** A folder with no usable status-change time cannot be told apart from itself later: it is never trusted. */
const racyAt = (identity: FileIdentity | undefined, lookedAt: bigint): boolean =>
  identity !== undefined && (identity.ctimeNs <= 0n || identity.ctimeNs + racyWindowOf(identity) >= lookedAt);

/** A folder as it is at `identity`, looked at at `lookedAt`: whether it is racy, and from when it would rest. */
const recordOf = (
  identity: FileIdentity | undefined,
  lookedAt: bigint,
  tiered: boolean,
  coldNs: bigint,
  child: Map<string, FileIdentity | undefined> = new Map(),
): FolderRecord => {
  const racy = racyAt(identity, lookedAt);
  return {
    identity,
    racy,
    tiered,
    restFrom: tiered && !racy && identity !== undefined ? identity.ctimeNs + coldNs : undefined,
    child,
  };
};

/** Whether a record is resting at `now`: a member folder, trusted, and unchanged for as long as it takes to rest. */
const resting = (record: FolderRecord, now: bigint): boolean => record.restFrom !== undefined && record.restFrom < now;

/** Whether two answers are the same file: nothing there either time, or the same device, inode and kind. */
const sameFile = (a: FileIdentity | undefined, b: FileIdentity | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.device === b.device && a.inode === b.inode && a.kind === b.kind;

const placeOf = (path: string, identity: FileIdentity): IndexedPlace => ({
  path,
  key: identityKey(identity),
  device: identity.device,
  inode: identity.inode,
});

interface Budget {
  left: number;
}

/** Whether two trees closed on the same devices. */
const sameDevices = (a: ReadonlySet<bigint>, b: ReadonlySet<bigint> | undefined): boolean =>
  b !== undefined && a.size === b.size && [...a].every(device => b.has(device));

/** A tree while it is being indexed: the devices its places answer with are collected as they are met. */
type GrowingTree = ClosedTree & { readonly devices: Set<bigint> };

/**
 * Renews the records of the member folders that changed when every one of them still holds the file it held (the same
 * device and inode, or nothing, as before), so no place differs: answers whether it did. A folder that was listed
 * (a walk went through it), vanished, gained or lost its pinned file, or is not a member folder is not renewed, and
 * nothing is changed then: the caller scans the tree.
 */
async function renew(
  fs: HostFs,
  memory: Memory,
  stirred: readonly string[],
  batch: ReadonlyMap<string, FileIdentity | undefined>,
  lookedAt: bigint,
  coldNs: bigint,
): Promise<boolean> {
  const renewed = new Map<string, FolderRecord>();
  for (const folder of stirred) {
    const old = memory.records.get(folder) as FolderRecord;
    if (!old.tiered || old.names !== undefined) return false;
    // A folder that is no longer the folder it was (another inode, or gone) is pinned afresh by a scan: its pin is its identity.
    if (!sameFile(old.identity, batch.get(folder))) return false;
    const child = new Map<string, FileIdentity | undefined>();
    for (const [name, before] of old.child) {
      const now = await fs.identity(join(folder, name));
      if (!sameFile(before, now)) return false;
      child.set(name, now);
    }
    const record = recordOf(batch.get(folder), lookedAt, true, coldNs, child);
    if (old.place !== undefined) record.place = old.place;
    renewed.set(folder, record);
  }
  for (const [folder, record] of renewed) memory.records.set(folder, record);
  return true;
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
  const coldNs = BigInt(Math.floor(bounds.coldAfterMs ?? COLD_AFTER_MS)) * 1_000_000n;
  const batchAt = wall();

  // The folders to look at now: every one that is not resting, and the next slice of those that are. They are looked
  // at in ONE parallel batch, before anything is listed: the look costs the slowest lstat of a batch, not their sum.
  // A failure rejects the scan (a folder that cannot be looked at is never kept).
  const probe: string[] = [];
  const asleep: string[] = [];
  for (const [folder, record] of memory.records) (resting(record, batchAt) ? asleep : probe).push(folder);
  const slice = new Set<string>();
  if (asleep.length > 0) {
    const start = memory.cursor % asleep.length;
    const take = Math.min(bounds.slice ?? COLD_SLICE, asleep.length);
    for (let at = 0; at < take; at += 1) slice.add(asleep[(start + at) % asleep.length] as string);
    memory.cursor = start + take;
  }
  probe.push(...slice);
  const batch = new Map(
    (await Promise.all(probe.map(async folder => await fs.identity(folder)))).map((found, at) => [
      probe[at] as string,
      found,
    ]),
  );
  if (previous !== undefined && !memory.dirty) {
    // Everything below is derived from the folders looked at, so when none changed (and none is racy) it is the same.
    const stirred = probe.filter(folder => {
      const record = memory.records.get(folder) as FolderRecord;
      return record.racy || changed(record.identity, batch.get(folder));
    });
    if (stirred.length === 0) return previous;
    // A member folder that changed but still holds the same pinned file changes no place: its record is renewed and
    // the snapshot stands, at the price of one identity per changed folder, never a walk of the tree.
    if (await renew(fs, memory, stirred, batch, batchAt, coldNs)) return previous;
  }

  const visited = new Map<string, FolderRecord>();
  const places: IndexedPlace[] = [];
  const truncated: string[] = [];
  const closed: ClosedTree[] = [];
  const budgets: PlaceBudget[] = [];
  const add = (path: string, identity: FileIdentity | undefined): void => {
    if (identity !== undefined) places.push(placeOf(path, identity));
  };
  /** A tree's budget was reached: it is truncated and closed, once, however many of its members find out. */
  const reached = (tree: ClosedTree, limit: number, budget: Budget): void => {
    if (closed.includes(tree)) return;
    truncated.push(tree.path);
    closed.push(tree);
    budgets.push({ path: tree.path, limit, indexed: limit - budget.left });
  };

  /** A folder as it is NOW (one identity), its record kept while it has not changed. Looked at once per scan, BEFORE it is listed. */
  const visit = async (folder: string, tiered: boolean): Promise<FolderRecord> => {
    const seen = visited.get(folder);
    if (seen !== undefined) return seen;
    const kept = memory.records.get(folder);
    // Resting and not in this look's slice: it is what it was.
    if (kept !== undefined && !slice.has(folder) && resting(kept, batchAt)) {
      visited.set(folder, kept);
      return kept;
    }
    const prefetched = batch.has(folder);
    const lookedAt = prefetched ? batchAt : wall();
    const identity = prefetched ? batch.get(folder) : await fs.identity(folder);
    let record: FolderRecord;
    if (kept !== undefined && !kept.racy && !changed(kept.identity, identity)) record = kept;
    else {
      record = recordOf(identity, lookedAt, tiered, coldNs);
      memory.records.set(folder, record);
      memory.dirty = true;
    }
    visited.set(folder, record);
    return record;
  };
  /** The names in a folder. A folder that cannot be listed throws: it is never read as empty. */
  const namesIn = async (folder: string): Promise<readonly string[]> => {
    const record = await visit(folder, false);
    record.names ??= await fs.list(folder);
    return record.names;
  };
  /** The identity of one member of a folder, looked at once while the folder stays as it is. */
  const memberOf = async (folder: string, name: string, tiered = false): Promise<FileIdentity | undefined> => {
    const record = await visit(folder, tiered);
    if (!record.child.has(name)) record.child.set(name, await fs.identity(join(folder, name)));
    return record.child.get(name);
  };
  const pick = async (path: string, tiered = false): Promise<FileIdentity | undefined> =>
    await memberOf(dirname(path), basename(path), tiered);

  /** The tree below `start`, breadth first, each member a place, until the budget is spent. */
  const walk = async (
    start: string,
    depth: number,
    budget: Budget,
    tree: GrowingTree,
    limit: number,
    tiered: boolean,
  ): Promise<void> => {
    let level = [start];
    for (let at = 0; at < depth && level.length > 0; at += 1) {
      const next: string[] = [];
      for (const folder of level) {
        for (const name of await namesIn(folder)) {
          if (budget.left <= 0) {
            reached(tree, limit, budget);
            return;
          }
          const identity = await memberOf(folder, name, tiered);
          add(join(folder, name), identity);
          if (identity !== undefined) tree.devices.add(identity.device);
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
    const tree: GrowingTree = { path: headPath, device: identity.device, devices: new Set([identity.device]) };
    const limit = each ? (bounds.patternLimit ?? PATTERN_LIMIT) : bounds.limit;
    // The head is one of the place's own: its budget is what is left for what the head holds.
    const budget: Budget = { left: limit - 1 };
    if (!each) {
      await walk(headPath, bounds.depth, budget, tree, limit, false);
      continue;
    }
    // `folder/*/rest`: the named path inside each member of `folder`. Only a member that HOLDS it spends the budget.
    const rest = segments.slice(star + 1).join('/');
    // One file in each member folder (`sessions/*/environment.json`): a member folder that is as it was is answered
    // from its record, without a promise or a path built, so a look costs microseconds a member, not a tree walk.
    const single = rest !== '' && !rest.includes('/');
    const prefix = headPath.endsWith('/') ? headPath : `${headPath}/`;
    const trusted = (folder: string, record: FolderRecord): boolean =>
      (resting(record, batchAt) && !slice.has(folder)) ||
      (batch.has(folder) && !record.racy && !changed(record.identity, batch.get(folder)));
    for (const name of await namesIn(headPath)) {
      const member = `${prefix}${name}`;
      const target = rest === '' ? member : `${member}/${rest}`;
      let found: FileIdentity | undefined;
      let place: IndexedPlace | undefined;
      const kept = single ? memory.records.get(member) : undefined;
      if (kept?.tiered === true && kept.child.has(rest) && trusted(member, kept)) {
        visited.set(member, kept);
        found = kept.child.get(rest);
        place = kept.place;
      } else found = rest === '' ? await memberOf(headPath, name) : await pick(target, true);
      // Every member folder is pinned by its own identity whether or not it holds the file NOW, and the pin spends no
      // budget: an alias of the FOLDER (a bind mount made at any time) is held however stale the folder's slice is, and
      // a session that ended (its file removed) and is resumed (a new credential written into it) is held too. It
      // lives on the folder's record, so it leaves with the folder, and costs one place per record, never a walk.
      const folder = single ? visited.get(member) : undefined;
      if (folder?.identity !== undefined) {
        folder.folderPlace ??= placeOf(member, folder.identity);
        places.push(folder.folderPlace);
      }
      if (found === undefined) continue;
      tree.devices.add(found.device);
      if (budget.left <= 0) {
        reached(tree, limit, budget);
        break;
      }
      if (place === undefined) {
        place = placeOf(target, found);
        const record = single ? visited.get(member) : undefined;
        if (record !== undefined) record.place = place;
      }
      places.push(place);
      budget.left -= 1;
      if (found.kind === 'directory') await walk(target, bounds.depth, budget, tree, limit, true);
    }
  }

  // What this scan did not visit is no longer watched; a failed scan (a throw above) keeps what it learned.
  for (const folder of memory.records.keys()) if (!visited.has(folder)) memory.records.delete(folder);
  memory.dirty = false;
  const same =
    previous !== undefined &&
    previous.places.length === places.length &&
    previous.places.every((place, at) => place.path === places[at]?.path && place.key === places[at]?.key) &&
    previous.truncated.join('\0') === truncated.join('\0') &&
    previous.closed.every((tree, at) => sameDevices(tree.devices, closed[at]?.devices)) &&
    previous.closed.length === closed.length &&
    previous.budgets.every((one, at) => one.indexed === budgets[at]?.indexed && one.limit === budgets[at]?.limit);
  // A snapshot that came out the same is the same one: what is built from it is not built again.
  if (same) return previous;
  return {
    places,
    get watched() {
      return new Map([...visited].map(([folder, record]) => [folder, record.identity] as const));
    },
    truncated,
    closed,
    budgets,
  };
}

/** What watches an index is told when what is truncated changes: the places now past their budget (none: all clear). */
export type TruncationWatcher = (budgets: readonly PlaceBudget[]) => void;

/** The kept index of one home: the snapshot, and the one scan in flight when it has to be redone. */
export interface PrivateIndex {
  /** The places now: the kept snapshot when its folders are unchanged, else a fresh one. Throws when the home cannot be looked at. */
  readonly snapshot: () => Promise<PrivateSnapshot>;
  /**
   * Tells `watcher` every time what is truncated changes (the same function is told once however often it is added).
   * A place already past its budget is announced to it at once.
   */
  readonly watch: (watcher: TruncationWatcher) => void;
}

/** How an index is looked at again, and what it may hold. Every field is for a test; the host uses the defaults but the interval. */
export interface IndexOptions {
  /** At most this many milliseconds pass between two looks at the folders a snapshot was computed from (default 0: every answer looks); see {@link recheckIntervalOf}. */
  readonly recheckMs?: number;
  /** A monotonic clock, in milliseconds. */
  readonly now?: () => number;
  readonly bounds?: IndexBounds;
  /** The wall clock in nanoseconds, to tell a change that is too recent to trust from one that is not. */
  readonly wall?: () => bigint;
}

/** What is truncated, as one comparable text: the places and their limits. */
const budgetsText = (budgets: readonly PlaceBudget[]): string =>
  JSON.stringify(budgets.map(budget => [budget.path, budget.limit]));

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
  const memory: Memory = { records: new Map(), dirty: false, cursor: 0 };
  const watchers = new Set<TruncationWatcher>();
  let announced = budgetsText([]);
  let kept: PrivateSnapshot | undefined;
  let lookedAt = Number.NEGATIVE_INFINITY;
  let tail: Promise<unknown> = Promise.resolve();
  const announce = (to: Iterable<TruncationWatcher>, budgets: readonly PlaceBudget[]): void => {
    for (const watcher of to)
      try {
        watcher(budgets);
      } catch {
        // A watcher that throws must never change what the index answers.
      }
  };
  const refresh = async (): Promise<PrivateSnapshot> => {
    if (kept !== undefined && now() - lookedAt < recheckMs) return kept;
    const started = now();
    kept = await build(fs, real, input, bounds, memory, wall, kept);
    lookedAt = started;
    // Once per transition: a truncation that persists is not announced again; a place that fits again is.
    const text = budgetsText(kept.budgets);
    if (text !== announced) {
      announced = text;
      announce(watchers, kept.budgets);
    }
    return kept;
  };
  return {
    // Answers that arrive together are looked at one after the other: the second finds what the first kept. A failure is not kept.
    snapshot: () => {
      const run = tail.then(refresh, refresh);
      tail = run.catch(() => undefined);
      return run;
    },
    watch: watcher => {
      if (watchers.has(watcher)) return;
      watchers.add(watcher);
      if (kept !== undefined && kept.budgets.length > 0) announce([watcher], kept.budgets);
    },
  };
}
