import { dirname, join } from 'node:path';
import type { FileIdentity, HostFs } from './adapters/node-fs.ts';

/**
 * The index of the home's private places (§7.7): the identity (device and inode) of every private place and of what a
 * private FOLDER holds, to a bounded depth, so a file bind mounted or aliased out of one under any name is recognised
 * by every root. It is computed once and kept: each answer first looks at the folders it was computed from (one
 * identity per folder, never a file), and rescans only when one of them changed — a created, replaced or removed
 * member always changes its folder's modification time.
 *
 * The bound fails closed where it can and says so where it cannot: a private folder is pinned whole by its own identity
 * (a walk THROUGH it is held) however large it is; what it holds is indexed breadth first, so the shallow files that
 * matter (a login's `auth.json`, a browser profile's cookies) come before the deep ones, to {@link MEMBER_DEPTH} levels
 * and {@link MEMBER_LIMIT} places in all. A folder met at the depth limit is itself pinned (a bind mount of it is held)
 * though its members are not looked at; past the limit on places the rest are not indexed and the snapshot says so
 * (`truncated`). That a single file beyond the bound is not recognised under a second name is the declared GAP.
 */

/** How many folder levels below a private folder are indexed (`credentials/<id>/auth.json` is two). */
const MEMBER_DEPTH = 3;
/** How many places one snapshot holds, the home's key paths and every pin included. */
const MEMBER_LIMIT = 4096;

/** How far the index looks into a private folder: how many levels, and how many places in all. */
interface IndexBounds {
  readonly depth: number;
  readonly limit: number;
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

/** What the home's private places were when last looked at. */
export interface PrivateSnapshot {
  readonly places: readonly IndexedPlace[];
  /** Every folder the snapshot was computed from, and what it was then (absent: nothing there). */
  readonly watched: ReadonlyMap<string, FileIdentity | undefined>;
  /** The places whose members were not all indexed (the bound was reached). */
  readonly truncated: readonly string[];
}

/** What a private place is declared as, relative to the home: a path, with at most one `*` meaning "each member". */
export interface IndexInput {
  /** Home-relative places pinned by their own identity, never looked into (the key paths, the internal root folders). */
  readonly pins: (stateEntries: readonly string[]) => readonly string[];
  /** Home-relative private places (`state/<id>/<path>`, a `*` segment standing for each member of that folder). */
  readonly private: readonly string[];
}

const changed = (before: FileIdentity | undefined, now: FileIdentity | undefined): boolean =>
  before === undefined || now === undefined
    ? before !== now
    : before.device !== now.device ||
      before.inode !== now.inode ||
      before.mtimeMs !== now.mtimeMs ||
      before.size !== now.size ||
      before.links !== now.links;

/** Looks at a folder's identity, remembering it BEFORE what it lists: a change during the scan then shows next time. */
async function watch(fs: HostFs, watched: Map<string, FileIdentity | undefined>, folder: string): Promise<void> {
  if (!watched.has(folder)) watched.set(folder, await fs.identity(folder));
}

async function build(fs: HostFs, real: string, input: IndexInput, bounds: IndexBounds): Promise<PrivateSnapshot> {
  const watched = new Map<string, FileIdentity | undefined>();
  const places: IndexedPlace[] = [];
  const truncated: string[] = [];
  const room = (): boolean => places.length < bounds.limit;
  const add = (path: string, identity: FileIdentity | undefined): void => {
    if (identity !== undefined)
      places.push({ path, key: identityKey(identity), device: identity.device, inode: identity.inode });
  };

  await watch(fs, watched, join(real, 'state'));
  const stateEntries = await fs.list(join(real, 'state'));

  // A pin is one identity; its parent is watched so one made later is looked at.
  for (const pin of input.pins(stateEntries)) {
    const path = join(real, pin);
    await watch(fs, watched, dirname(path));
    add(path, await fs.identity(path));
  }

  /** Members of `folder` below depth 0, breadth first, each as an indexed place. */
  const members = async (start: string, depth: number): Promise<void> => {
    let level = [start];
    for (let at = 0; at < depth && level.length > 0; at += 1) {
      const next: string[] = [];
      for (const folder of level) {
        await watch(fs, watched, folder);
        for (const name of await fs.list(folder)) {
          if (!room()) {
            truncated.push(start);
            return;
          }
          const path = join(folder, name);
          const identity = await fs.identity(path);
          add(path, identity);
          if (identity?.kind === 'directory') next.push(path);
        }
      }
      level = next;
    }
  };

  for (const declared of input.private) {
    const segments = declared.split('/');
    const star = segments.findIndex(segment => segment.includes('*'));
    // A `*` that is the whole segment means "each member"; one inside a name (`*-token.json`) pins the folder and what it holds.
    const each = star !== -1 && segments[star] === '*';
    const head = star === -1 ? declared : segments.slice(0, star).join('/');
    const headPath = join(real, head);
    await watch(fs, watched, dirname(headPath));
    const identity = await fs.identity(headPath);
    add(headPath, identity);
    if (identity?.kind !== 'directory') continue;
    if (!each) {
      await members(headPath, bounds.depth);
      continue;
    }
    // `folder/*/rest`: the named path inside each member of `folder`.
    const rest = segments.slice(star + 1).join('/');
    await watch(fs, watched, headPath);
    for (const name of await fs.list(headPath)) {
      if (!room()) {
        truncated.push(headPath);
        break;
      }
      const member = join(headPath, name);
      if (rest === '') {
        const found = await fs.identity(member);
        add(member, found);
        if (found?.kind === 'directory') await members(member, bounds.depth);
        continue;
      }
      await watch(fs, watched, member);
      const target = join(member, rest);
      const found = await fs.identity(target);
      add(target, found);
      if (found?.kind === 'directory') await members(target, bounds.depth);
    }
  }
  return { places, watched, truncated };
}

/** Whether every folder a snapshot was computed from is still as it was. A folder that cannot be looked at is a change. */
async function current(fs: HostFs, snapshot: PrivateSnapshot): Promise<boolean> {
  const now = await Promise.all(
    [...snapshot.watched.keys()].map(async path => await fs.identity(path).catch(() => ({ failed: true }) as const)),
  );
  let index = 0;
  for (const before of snapshot.watched.values()) {
    const found = now[index];
    index += 1;
    if (found !== undefined && 'failed' in found) return false;
    if (changed(before, found as FileIdentity | undefined)) return false;
  }
  return true;
}

/** The kept index of one home: the snapshot, and the one scan in flight when it has to be redone. */
export interface PrivateIndex {
  /** The places now: the kept snapshot when its folders are unchanged, else a fresh one. Throws when the home cannot be looked at. */
  readonly snapshot: () => Promise<PrivateSnapshot>;
}

/**
 * The index of the home at `real` for `input`. At most `recheckMs` of milliseconds pass between two looks at the
 * folders a snapshot was computed from (default 0: every answer looks); a place created or replaced is indexed at the
 * next look, so that is also the longest one stays unrecognised.
 */
export function privateIndexOf(
  fs: HostFs,
  real: string,
  input: IndexInput,
  recheckMs = 0,
  now: () => number = () => performance.now(),
  bounds: IndexBounds = { depth: MEMBER_DEPTH, limit: MEMBER_LIMIT },
): PrivateIndex {
  let kept: PrivateSnapshot | undefined;
  let lookedAt = Number.NEGATIVE_INFINITY;
  let tail: Promise<unknown> = Promise.resolve();
  const refresh = async (): Promise<PrivateSnapshot> => {
    if (kept !== undefined && now() - lookedAt < recheckMs) return kept;
    if (kept !== undefined && (await current(fs, kept))) {
      lookedAt = now();
      return kept;
    }
    const started = now();
    kept = await build(fs, real, input, bounds);
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
