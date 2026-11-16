/**
 * A harness plugin's ferret home linked to the plugin's ONE history pool (docs/design/shared-history.md, 3.1), shared by
 * Claude Code and Codex: both pool the same way and differ only in the entry list their manifests declare.
 *
 * For each declared entry of the ferret's home:
 *   - already a link: left alone (the kernel makes only pool links in a home; a launch finds last time's);
 *   - nothing there: `RootHandle.linkHistory` makes it;
 *   - a real folder or file (a 5.0 ferret that ran before pooling): its files are MOVED into the pool by rename, one file
 *     at a time so two ferrets' `projects/<slug>/` folders merge; a name the pool already has goes to
 *     `.conflicts/<ferret>/<entry>/<path>` (never overwritten, named in the result), and then the link is made.
 *
 * Fail-safe: pooling is a convenience, never a reason a launch fails. Any refusal or fault for an entry leaves that entry
 * exactly as it was, and the launch goes on with the ferret's own history for it; the result says so in ONE sentence.
 */
import type { FencedPath, FerretId, RootEntry, RootHandle, RootsPort } from '@ferretry/kernel/contract';

/** One entry of a harness home a manifest's `permissions.historyPool.entries` declares. */
export interface HistoryPoolEntry {
  readonly name: string;
  readonly kind: 'folder' | 'file';
}

/** What a launch's pooling did. `sentence` is set iff some entry stayed the ferret's own. */
export interface PooledHome {
  /** Entries now linked to the pool (made now, or found already linked). */
  readonly linked: readonly string[];
  /** Files moved from the home into the pool by this call. */
  readonly moved: number;
  /** Where a file went instead of overwriting one the pool already had (`.conflicts/<ferret>/…`, pool-relative). */
  readonly conflicts: readonly string[];
  /** One plain sentence when the ferret goes on unpooled for any entry, else `undefined`. */
  readonly sentence: string | undefined;
}

/** Deep enough for every history entry (`projects/<slug>/<id>/subagents/…`), shallow enough to end. */
const MAX_DEPTH = 12;
/** The most files one launch moves: a home with more is left to a person (it is unpooled, and says so). */
const MAX_MOVES = 20_000;

const fenced = (root: RootHandle, relative: string): FencedPath => {
  const resolved = root.resolve(relative);
  if (!resolved.ok) throw new Error(`the history path could not be placed (${String(resolved.error)})`);
  return resolved.value;
};

/** A refusal's closed reason, never a path: `HistoryPoolError.refusal` or `RootError.refusal`, else a plain word. */
export const poolRefusalWord = (error: unknown): string => {
  const refusal = (error as { readonly refusal?: unknown } | null)?.refusal;
  return typeof refusal === 'string' ? refusal : 'failed';
};

/** The sentence for the one thing a person can do nothing about on this host (macOS today). */
const NO_REACH = 'this computer cannot link shared history yet';

export async function poolHomeHistory(input: {
  readonly roots: Pick<RootsPort, 'root' | 'historyPool'>;
  readonly ferret: FerretId;
  readonly entries: readonly HistoryPoolEntry[];
}): Promise<PooledHome> {
  const { roots, ferret, entries } = input;
  const home = roots.root('agent-homes', { ferret, subfolder: ferret });
  const linked: string[] = [];
  const conflicts: string[] = [];
  const unpooled: string[] = [];
  let reason: string | undefined;
  let moved = 0;
  let pool: RootHandle;
  try {
    pool = roots.historyPool();
  } catch (error) {
    return unpooledAll(error);
  }
  const homePath = fenced(home, '');

  for (const entry of entries) {
    try {
      const at = fenced(home, entry.name);
      const found = await home.lstat(at);
      if (found?.kind === 'symlink') {
        linked.push(entry.name);
        continue;
      }
      if (found !== undefined) {
        const budget = { left: MAX_MOVES - moved };
        const result = await moveIn(home, pool, ferret, entry, budget);
        moved += result.moved;
        conflicts.push(...result.conflicts);
        // Whatever could not be moved (a link inside, a hard-linked file) stays, and then the link is refused `exists`.
      }
      await home.linkHistory(homePath, entry.name);
      linked.push(entry.name);
    } catch (error) {
      unpooled.push(entry.name);
      reason ??= poolRefusalWord(error);
    }
  }
  return {
    linked,
    moved,
    conflicts,
    sentence:
      unpooled.length === 0
        ? undefined
        : reason === 'no_descriptor_reach'
          ? `This ferret goes on with its own history: ${NO_REACH}.`
          : `This ferret goes on with its own ${unpooled.join(', ')} history because pooling it was refused (${reason ?? 'failed'}).`,
  };
}

const unpooledAll = (error: unknown): PooledHome => ({
  linked: [],
  moved: 0,
  conflicts: [],
  sentence:
    poolRefusalWord(error) === 'no_descriptor_reach'
      ? `This ferret goes on with its own history: ${NO_REACH}.`
      : `This ferret goes on with its own history because the shared pool could not be reached (${poolRefusalWord(error)}).`,
});

/**
 * Moves what is at `<home>/<entry>` into the pool by rename: a folder the pool does not have goes whole (one rename); a
 * folder both have is merged file by file; a file the pool has is moved to `.conflicts/<ferret>/<entry>/…` under a name
 * nothing holds. An emptied folder is removed. A link, a device or anything else is left where it is.
 */
async function moveIn(
  home: RootHandle,
  pool: RootHandle,
  ferret: FerretId,
  entry: HistoryPoolEntry,
  budget: { left: number },
): Promise<{ moved: number; conflicts: string[] }> {
  const conflicts: string[] = [];
  let moved = 0;

  const conflictTarget = async (relative: string): Promise<string> => {
    const base = `.conflicts/${ferret}/${relative}`;
    for (let n = 0; n < 1000; n += 1) {
      const candidate = n === 0 ? base : `${base}.${n + 1}`;
      if ((await pool.lstat(fenced(pool, candidate))) === undefined) return candidate;
    }
    throw new Error('no free conflict name');
  };

  const move = async (relative: string, target: string): Promise<void> => {
    if (budget.left <= 0) throw new Error('too many files to move');
    budget.left -= 1;
    await home.moveToHistoryPool(fenced(home, relative), pool, fenced(pool, target));
    moved += 1;
  };

  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const there = await pool.lstat(fenced(pool, relative));
    const here = await home.lstat(fenced(home, relative));
    if (here === undefined) return;
    if (here.kind === 'directory') {
      if (there === undefined) {
        await move(relative, relative);
        return;
      }
      if (there.kind === 'directory') {
        const children: readonly RootEntry[] = await home.entries(fenced(home, relative));
        for (const child of children) await walk(`${relative}/${child.name}`, depth + 1);
        await home.remove(fenced(home, relative), { onlyIfEmpty: true }).catch(() => undefined);
        return;
      }
      const to = await conflictTarget(relative);
      await move(relative, to);
      conflicts.push(to);
      return;
    }
    if (here.kind === 'file') {
      if (there === undefined) {
        await move(relative, relative);
        return;
      }
      const to = await conflictTarget(relative);
      await move(relative, to);
      conflicts.push(to);
    }
    // A link or another kind: never moved.
  };

  await walk(entry.name, 0);
  return { moved, conflicts };
}
