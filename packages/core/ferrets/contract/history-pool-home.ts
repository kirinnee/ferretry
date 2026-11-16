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
 * Each entry is completely preflighted before any leaf moves; known refusals leave it unchanged and launch unpooled.
 * An unexpected filesystem fault after a move refuses this launch, preserving its conversation instead of starting a
 * new one. A per-entry marker keeps later launches refusing until an idempotent retry finishes the merge and links it.
 */
import type { FencedPath, FerretId, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { LaunchRefusal } from './kinds.ts';

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
  const linked: string[] = [];
  const conflicts: string[] = [];
  const unpooled: string[] = [];
  let reason: string | undefined;
  const progress = { moved: 0, conflicts, uncertain: false };
  let home: RootHandle;
  let homePath: FencedPath;
  let pool: RootHandle;
  let wasPending = false;
  try {
    home = roots.root('agent-homes', { ferret, subfolder: ferret });
    homePath = fenced(home, '');
    for (const entry of entries) {
      if ((await home.lstat(fenced(home, `.history-pool-pending-${entry.name}`))) !== undefined) wasPending = true;
    }
    pool = roots.historyPool();
  } catch (error) {
    if (wasPending) throw interrupted(error);
    return unpooledAll(error);
  }

  for (const entry of entries) {
    const before = progress.moved;
    let marker: FencedPath | undefined;
    let pending = false;
    try {
      marker = fenced(home, `.history-pool-pending-${entry.name}`);
      pending = (await home.lstat(marker)) !== undefined;
      const at = fenced(home, entry.name);
      const found = await home.lstat(at);
      if (found?.kind === 'symlink') {
        linked.push(entry.name);
        if (pending) await home.remove(marker).catch(() => undefined);
        continue;
      }
      if (found !== undefined) {
        await moveIn(home, pool, ferret, entry, progress, async () => {
          if (!pending && marker !== undefined) await home.writeText(marker, 'pending\n', { exclusive: true });
        });
      }
      await home.linkHistory(homePath, entry.name);
      linked.push(entry.name);
      await home.remove(marker).catch(() => undefined);
    } catch (error) {
      if (pending || progress.moved > before || progress.uncertain) {
        throw interrupted(error);
      }
      // No leaf moved: a first-move refusal (for example macOS) can safely use the original home.
      if (marker !== undefined) await home.remove(marker).catch(() => undefined);
      unpooled.push(entry.name);
      reason ??= poolRefusalWord(error);
    }
  }
  return {
    linked,
    moved: progress.moved,
    conflicts,
    sentence:
      unpooled.length === 0
        ? undefined
        : reason === 'no_descriptor_reach'
          ? `This ferret goes on with its own history: ${NO_REACH}.`
          : `This ferret goes on with its own ${unpooled.join(', ')} history because pooling it was refused (${reason ?? 'failed'}).`,
  };
}

const interrupted = (error: unknown): LaunchRefusal =>
  new LaunchRefusal(
    `History was being moved into the shared pool and stopped part-way (${poolRefusalWord(error)}); start this ferret again to finish.`,
  );

const unpooledAll = (error: unknown): PooledHome => ({
  linked: [],
  moved: 0,
  conflicts: [],
  sentence:
    poolRefusalWord(error) === 'no_descriptor_reach'
      ? `This ferret goes on with its own history: ${NO_REACH}.`
      : `This ferret goes on with its own history because the shared pool could not be reached (${poolRefusalWord(error)}).`,
});

/** A local preflight refusal, with the same path-free vocabulary as a kernel refusal. */
class PreflightRefusal extends Error {
  constructor(readonly refusal: string) {
    super(`history preflight refused: ${refusal}`);
  }
}

/**
 * Preflight the COMPLETE entry before moving any file, including names hidden from `entries` by a private-place guard.
 * `list` returns those names; looking/opening each one lets the kernel refuse it, rather than silently skipping it.
 * Only leaves move: no folder can carry an unchecked descendant into the pool. Target conflicts are decided at the
 * atomic move, not by a look before it, so two homes can merge the same slug at once.
 */
async function moveIn(
  home: RootHandle,
  pool: RootHandle,
  ferret: FerretId,
  entry: HistoryPoolEntry,
  progress: { moved: number; conflicts: string[]; uncertain: boolean },
  markPending: () => Promise<void>,
): Promise<void> {
  const files: string[] = [];
  const folders: string[] = [];
  const scan = async (relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new PreflightRefusal('too_many');
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    if (name === '' || name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('\0'))
      throw new PreflightRefusal('denied');
    const here = await home.lstat(fenced(home, relative));
    if (here === undefined) throw new PreflightRefusal('changed');
    if (here.kind === 'directory') {
      for (const child of await home.list(fenced(home, relative))) await scan(`${relative}/${child}`, depth + 1);
      folders.push(relative); // deepest first, for empty-only removal after every leaf has moved
    } else if (here.kind === 'file') {
      if (here.links !== 1) throw new PreflightRefusal('hard_link');
      files.push(relative);
      if (files.length > MAX_MOVES - progress.moved) throw new PreflightRefusal('too_many');
    } else {
      throw new PreflightRefusal(here.kind === 'symlink' ? 'link_escape' : 'not_file');
    }
  };
  const top = await home.lstat(fenced(home, entry.name));
  if (top?.kind !== (entry.kind === 'folder' ? 'directory' : 'file')) throw new PreflightRefusal('not_file');
  await scan(entry.name, 0);
  // A zero-byte read applies the kernel's private-place and hard-link guards without buffering any transcript.
  for (const relative of files) await home.readBytes(fenced(home, relative), { offset: 0, length: 0 });

  const attemptMove = async (relative: string, target: string): Promise<void> => {
    const from = fenced(home, relative);
    const before = await home.fileIdentity(from);
    try {
      await home.moveToHistoryPool(from, pool, fenced(pool, target));
    } catch (error) {
      // A refusal can follow the syscall (its post-move proof or disk sync failed). Only fall back unpooled when the
      // original inode is still at the source; otherwise keep the pending marker and refuse even the FIRST move.
      const after = await home.fileIdentity(from).catch(() => undefined);
      if (before === undefined || after?.device !== before.device || after.inode !== before.inode) {
        progress.uncertain = true;
        throw new PreflightRefusal('changed');
      }
      throw error;
    }
  };
  const keepConflict = async (relative: string): Promise<void> => {
    // NOREPLACE arbitrates conflict names too: another launch can win a name after any look.
    const base = `.conflicts/${ferret}/${relative}`;
    for (let n = 0; n < 1000; n += 1) {
      const target = n === 0 ? base : `${base}.${n + 1}`;
      try {
        await attemptMove(relative, target);
        progress.moved += 1;
        progress.conflicts.push(target);
        return;
      } catch (error) {
        if (poolRefusalWord(error) !== 'exists') throw error;
      }
    }
    throw new PreflightRefusal('exists');
  };
  if (files.length > 0) await markPending();
  for (const relative of files) {
    const parts = relative.split('/');
    // An old history.jsonl is retained whole, never concatenated with the shared history.
    let conflict = entry.kind === 'file';
    for (let depth = 1; depth < parts.length && !conflict; depth += 1) {
      const target = await pool.lstat(fenced(pool, parts.slice(0, depth).join('/')));
      if (target === undefined) break;
      conflict = target.kind !== 'directory';
    }
    if (conflict) {
      await keepConflict(relative);
      continue;
    }
    try {
      await attemptMove(relative, relative);
      progress.moved += 1;
    } catch (error) {
      if (poolRefusalWord(error) !== 'exists') throw error;
      await keepConflict(relative);
    }
  }
  // Preserve empty directories too, without ever renaming a folder and its unchecked contents.
  for (const relative of folders) {
    let blocked = false;
    const parts = relative.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const target = await pool.lstat(fenced(pool, parts.slice(0, depth).join('/')));
      if (target === undefined) break;
      if (target.kind !== 'directory') {
        blocked = true;
        break;
      }
    }
    if (!blocked) await pool.makeDirectory(fenced(pool, relative));
    await home.remove(fenced(home, relative), { onlyIfEmpty: true });
  }
}
