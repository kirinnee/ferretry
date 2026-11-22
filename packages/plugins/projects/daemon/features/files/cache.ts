import type { ProjectIndex } from './build.ts';

/** A read of an index older than this answers the old one and starts a rebuild (owner decision D5: no watcher). */
export const STALE_AFTER_MS = 30_000;

/** The most projects held in memory at once; the oldest idle one goes first. A project's index is a few MB of names. */
export const MAX_CACHED_PROJECTS = 16;

interface Entry {
  index: ProjectIndex | undefined;
  /** When `index` was last built, or a rebuild last failed (so a broken project is not retried on every read). */
  checkedMs: number;
  running: Promise<ProjectIndex> | undefined;
}

/** What a reader gets: an index, and whether a newer one is being built behind it. */
export interface CachedIndex {
  readonly index: ProjectIndex;
  readonly rebuilding: boolean;
}

/** What a badge gets: the index if there is one yet, and whether one is being built. */
export interface CachedStatus {
  readonly index: ProjectIndex | undefined;
  readonly rebuilding: boolean;
}

/**
 * The indexes in memory, one per project: built on the first read, answered from memory after that, and rebuilt behind a
 * read once they are {@link STALE_AFTER_MS} old (stale-while-revalidate).
 *
 * MEMORY ONLY, deliberately. A list of every file name written into `state/` is one more place names could leak from
 * (backups, copies) for no real speed gain: a rebuild costs well under a second on a 14,000-file project. One build per
 * project runs at a time and a second request joins it. The clock is injected so staleness is proved without waiting.
 */
export class ProjectIndexCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly build: (path: string) => Promise<ProjectIndex>,
    private readonly nowMs: () => number,
    private readonly staleMs: number = STALE_AFTER_MS,
  ) {}

  /**
   * The index to answer with. The FIRST read waits for the build (and throws what it throws: a refused folder); a later
   * one never waits — an old index is answered at once and, when it is stale, rebuilt behind the answer.
   */
  async read(key: string, path: string): Promise<CachedIndex> {
    const entry = this.entry(key);
    if (entry.index === undefined) {
      const index = await this.run(entry, path);
      return { index, rebuilding: false };
    }
    if (entry.running === undefined && this.nowMs() - entry.checkedMs >= this.staleMs) this.background(entry, path);
    return { index: entry.index, rebuilding: entry.running !== undefined };
  }

  /** The state without waiting: a project never built starts its first build and answers none yet. */
  status(key: string, path: string): CachedStatus {
    const entry = this.entry(key);
    if (entry.index === undefined || (entry.running === undefined && this.nowMs() - entry.checkedMs >= this.staleMs))
      this.background(entry, path);
    return { index: entry.index, rebuilding: entry.running !== undefined };
  }

  /** Starts a rebuild now (or joins the one running) and answers without waiting for it. */
  rescan(key: string, path: string): CachedStatus {
    const entry = this.entry(key);
    this.background(entry, path);
    return { index: entry.index, rebuilding: true };
  }

  private entry(key: string): Entry {
    const held = this.entries.get(key);
    if (held !== undefined) {
      // Most recently used goes last, so the first key is the oldest.
      this.entries.delete(key);
      this.entries.set(key, held);
      return held;
    }
    const entry: Entry = { index: undefined, checkedMs: 0, running: undefined };
    this.entries.set(key, entry);
    for (const [other, candidate] of this.entries) {
      if (this.entries.size <= MAX_CACHED_PROJECTS) break;
      if (other !== key && candidate.running === undefined) this.entries.delete(other);
    }
    return entry;
  }

  /** One build per project: a second caller gets the promise already running. */
  private run(entry: Entry, path: string): Promise<ProjectIndex> {
    entry.running ??= this.build(path)
      .then(index => {
        entry.index = index;
        entry.checkedMs = this.nowMs();
        return index;
      })
      .finally(() => {
        entry.running = undefined;
      });
    return entry.running;
  }

  /** A build nobody waits on: its failure keeps the index there is, and is not retried until the next stale interval. */
  private background(entry: Entry, path: string): void {
    this.run(entry, path).catch(() => {
      entry.checkedMs = this.nowMs();
    });
  }
}
