import { type ProjectIndex, ProjectFolderRefused } from './build.ts';

/** A read of an index older than this answers the old one and starts a rebuild (owner decision D5: no watcher). */
export const STALE_AFTER_MS = 30_000;

/** The most projects held in memory at once; the oldest idle one goes first. A project's index is a few MB of names. */
export const MAX_CACHED_PROJECTS = 16;

/**
 * The most builds that run at once, across every project. A build walks a disk and holds descriptors, and it is the one
 * thing here a caller can ask for by naming a project; the rest wait their turn rather than all starting together.
 */
export const MAX_CONCURRENT_BUILDS = 2;

/** Every held project is building or waiting to, so there is no room to take another: say so, retry later. */
export class IndexCacheBusy extends Error {
  constructor() {
    super('every project index slot is busy building');
    this.name = 'IndexCacheBusy';
  }
}

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
 * project runs at a time and a second request joins it; at most {@link MAX_CONCURRENT_BUILDS} run at once and the rest
 * queue; at most {@link MAX_CACHED_PROJECTS} projects are held, and when every one of them is building another is
 * refused ({@link IndexCacheBusy}) rather than held past the bound. The clock is injected so staleness is proved without
 * waiting.
 *
 * A rebuild the privacy policy refuses (`ProjectFolderRefused('private')`) DISCARDS the index it had: what was private is
 * no longer answered from memory. A rebuild that merely failed keeps the old one.
 */
export class ProjectIndexCache {
  private readonly entries = new Map<string, Entry>();
  private building = 0;
  /** Builds queued for a slot, each remembering the entry it was asked for, so evicting that entry can cancel it. */
  private readonly waiting: {
    readonly entry: Entry;
    readonly begin: () => void;
    readonly cancel: (e: Error) => void;
  }[] = [];

  constructor(
    private readonly build: (path: string, holdSlot: (work: Promise<unknown>) => void) => Promise<ProjectIndex>,
    private readonly nowMs: () => number,
    private readonly staleMs: number = STALE_AFTER_MS,
  ) {}

  /** How many projects are held (an index, or a build in flight). */
  size(): number {
    return this.entries.size;
  }

  /**
   * Forgets a project's index at once: what the place was is no longer what is registered. A build of it still WAITING
   * for a slot is cancelled (its waiting readers are told the folder is unavailable) rather than left in the queue, which
   * would let evicted work pile up past the bound; one already RUNNING keeps its slot until it ends, so it stays counted.
   */
  evict(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    const queued = this.waiting.findIndex(waiter => waiter.entry === entry);
    if (queued >= 0) this.waiting.splice(queued, 1)[0]?.cancel(new ProjectFolderRefused('unavailable'));
  }

  /**
   * The index to answer with. The FIRST read waits for the build (and throws what it throws: a refused folder); a later
   * one never waits — an old index is answered at once and, when it is stale, rebuilt behind the answer.
   */
  async read(key: string, path: string): Promise<CachedIndex> {
    const entry = this.entry(key);
    if (entry.index === undefined) {
      const index = await this.run(key, entry, path);
      return { index, rebuilding: false };
    }
    if (entry.running === undefined && this.nowMs() - entry.checkedMs >= this.staleMs)
      this.background(key, entry, path);
    return { index: entry.index, rebuilding: entry.running !== undefined };
  }

  /** The state without waiting: a project never built starts its first build and answers none yet. */
  status(key: string, path: string): CachedStatus {
    const entry = this.entry(key);
    if (entry.index === undefined || (entry.running === undefined && this.nowMs() - entry.checkedMs >= this.staleMs))
      this.background(key, entry, path);
    return { index: entry.index, rebuilding: entry.running !== undefined };
  }

  /** Starts a rebuild now (or joins the one running) and answers without waiting for it. */
  rescan(key: string, path: string): CachedStatus {
    const entry = this.entry(key);
    this.background(key, entry, path);
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
    // Room is made BEFORE the new one is held, so a full cache of running builds never grows past its bound.
    for (const [other, candidate] of this.entries) {
      if (this.entries.size < MAX_CACHED_PROJECTS) break;
      if (candidate.running === undefined) this.entries.delete(other);
    }
    if (this.entries.size >= MAX_CACHED_PROJECTS) throw new IndexCacheBusy();
    const entry: Entry = { index: undefined, checkedMs: 0, running: undefined };
    this.entries.set(key, entry);
    return entry;
  }

  /** Starts the build now when one of the {@link MAX_CONCURRENT_BUILDS} slots is free (synchronously), else when one is. */
  private start(path: string, entry: Entry): Promise<ProjectIndex> {
    if (this.building >= MAX_CONCURRENT_BUILDS)
      return new Promise<ProjectIndex>((resolve, reject) => {
        this.waiting.push({
          entry,
          begin: () => {
            this.start(path, entry).then(resolve, reject);
          },
          cancel: reject,
        });
      });
    this.building += 1;
    // Work the build leaves running behind its answer (a read in flight at its deadline): the slot is not free until it stops.
    const outliving: Promise<unknown>[] = [];
    const release = async (): Promise<void> => {
      for (let work = outliving.splice(0); work.length > 0; work = outliving.splice(0)) await Promise.allSettled(work);
      this.building -= 1;
      this.waiting.shift()?.begin();
    };
    let started: Promise<ProjectIndex>;
    try {
      started = this.build(path, work => void outliving.push(work));
    } catch (error) {
      started = Promise.reject(error);
    }
    // A side branch: giving the slot back never delays what the caller is told.
    started.then(release, release);
    return started;
  }

  /** One build per project: a second caller gets the promise already running. */
  private run(key: string, entry: Entry, path: string): Promise<ProjectIndex> {
    entry.running ??= this.start(path, entry)
      .then(
        index => {
          entry.index = index;
          entry.checkedMs = this.nowMs();
          return index;
        },
        (error: unknown) => {
          // What the privacy policy refuses is not answered from memory any longer; a hiccup keeps what there is.
          if (error instanceof ProjectFolderRefused && error.reason === 'private') {
            entry.index = undefined;
            if (this.entries.get(key) === entry) this.entries.delete(key);
          }
          throw error;
        },
      )
      .finally(() => {
        entry.running = undefined;
      });
    return entry.running;
  }

  /** A build nobody waits on: its failure keeps the index there is, and is not retried until the next stale interval. */
  private background(key: string, entry: Entry, path: string): void {
    this.run(key, entry, path).catch(() => {
      entry.checkedMs = this.nowMs();
    });
  }
}
