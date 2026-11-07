/**
 * WORK SEARCH: keeps the {@link WorkIndex} as current as the work it projects, and answers the search and related-check
 * routes from it (docs/work-search.md § Freshness).
 *
 * THE SOURCES ARE THE TRUTH; the index is a copy that must never be stale where a reader could tell:
 *
 * - **Cheap sources** (the board's cards, held in memory, a changed card being a new object) are read on every search
 *   and only the pieces whose object changed are re-indexed: a pointer comparison per piece, no I/O.
 * - **Other sources** (the asks) are re-read when they say they changed ({@link changed}, wired to `asks.changed`), and
 *   every {@link WORK_SEARCH_SWEEP_MS} a search also starts a background sweep of every source, so an edit made outside
 *   this daemon is found within the sweep interval, never later.
 * - **Secrets.** Every text passes the redactor's scrub before it is indexed. When the set of known values changes (its
 *   epoch), the next search rebuilds the whole index before it answers, so a value registered as a secret after it was
 *   written on a card stops being findable at once.
 *
 * The first search waits for the first full build; {@link warm} starts it at boot so it rarely has to.
 */
import {
  MAX_WORK_RELATED_HITS,
  type WorkHit,
  type WorkRelatedRequest,
  type WorkRelatedResponse,
  type WorkSearchQuery,
  type WorkSearchResponse,
} from '../../../contract/index.ts';
import { type RawWork, type ScrubText, workDocument } from './documents.ts';
import { WorkIndex } from './work-index.ts';

/** How stale a sweep of every source may grow before a search starts the next. */
export const WORK_SEARCH_SWEEP_MS = 5_000;

/**
 * How many pieces of work are indexed between yields to the event loop. Closed work of every age is indexed (the 30-day
 * window is applied when searching), so a first build over a large fleet is split up rather than run as one synchronous
 * pass that would stall the daemon.
 */
export const WORK_SEARCH_INDEX_CHUNK = 100;

/** Gives the event loop back for a turn; the daemon runs on Bun, whose `sleep(0)` is a macrotask. */
const yieldToLoop = async (): Promise<void> => await Bun.sleep(0);

/** `items` in runs of at most `size`. */
const chunksOf = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
};

/**
 * Where some of the work comes from. `list` returns the same object for a piece of work while it has not changed, so
 * the service can tell by identity what to re-index.
 */
export interface WorkSource {
  readonly id: string;
  /** Read on every search (a source held in memory) rather than only when it changed or a sweep runs. */
  readonly cheap?: true;
  list(): Promise<readonly RawWork[]>;
}

/** The secret redactor, as indexing needs it: a scrub for one batch, and a name for the current values. */
export interface WorkRedaction {
  batch<T>(work: (scrub: ScrubText) => T): Promise<T>;
  /** Changes whenever the set of known secret values may have. */
  epoch(): Promise<string>;
}

export interface WorkSearchDependencies {
  readonly sources: readonly WorkSource[];
  readonly redaction: WorkRedaction;
  readonly now: () => number;
  readonly warn: (message: string) => void;
}

export class WorkSearchService {
  private readonly index = new WorkIndex();
  /** Each source's pieces as last indexed, by key. */
  private readonly seen = new Map<string, Map<string, RawWork>>();
  private readonly dirty = new Set<string>();
  private epoch: string | undefined;
  private built: Promise<void> | undefined;
  private sweeping: Promise<void> | undefined;
  private lastSweepMs = Number.NEGATIVE_INFINITY;
  /** Every index update runs in turn, so a search never interleaves with a sweep's writes. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: WorkSearchDependencies) {}

  /** Builds the index now, in the background, so the first search does not pay for it. */
  warm(): void {
    void this.ready().catch((error: unknown) =>
      this.ports.warn(`work search could not build its index: ${message(error)}`),
    );
  }

  // read-scoped: none — every hit is masked by the epoch-keyed read redaction before it leaves the service
  async search(query: WorkSearchQuery): Promise<WorkSearchResponse> {
    await this.current();
    const { hits, total, olderHidden } = this.index.search(query, this.ports.now());
    return {
      hits: await this.masked(hits),
      total,
      indexed: this.index.size,
      ...(query.all === undefined ? {} : { olderHidden }),
    };
  }

  async related(request: WorkRelatedRequest): Promise<WorkRelatedResponse> {
    await this.current();
    const matches = this.index.related(request.title, request.ask ?? '', this.ports.now(), MAX_WORK_RELATED_HITS);
    const hits = await this.masked(matches.map(match => match.hit));
    return { matches: matches.map((match, at) => ({ strength: match.strength, hit: hits[at] ?? match.hit })) };
  }

  /**
   * The answer scrubbed once more, as it leaves: the index was built from scrubbed text, and this covers a value that
   * became known after its document was indexed and before the epoch could say so.
   */
  private async masked(hits: readonly WorkHit[]): Promise<WorkHit[]> {
    if (hits.length === 0) return [];
    return await this.ports.redaction.batch(scrub =>
      hits.map(hit => ({ ...hit, title: scrub(hit.title), match: { ...hit.match, line: scrub(hit.match.line) } })),
    );
  }

  /** A source changed: it is re-read before the next answer. */
  async changed(sourceId: string): Promise<void> {
    this.dirty.add(sourceId);
  }

  /** The index as current as a search must see it. */
  private async current(): Promise<void> {
    await this.ready();
    await this.serial(async () => {
      const epoch = await this.ports.redaction.epoch();
      if (epoch !== this.epoch) await this.rebuild(epoch);
      else await this.refresh(this.ports.sources.filter(source => source.cheap === true || this.dirty.has(source.id)));
    });
    if (this.ports.now() - this.lastSweepMs >= WORK_SEARCH_SWEEP_MS) this.startSweep();
  }

  private ready(): Promise<void> {
    this.built ??= this.serial(async () => await this.rebuild(await this.ports.redaction.epoch())).catch(
      (error: unknown) => {
        this.built = undefined;
        throw error;
      },
    );
    return this.built;
  }

  /** Everything again, from the sources: the first build, and every change of the secret values. */
  private async rebuild(epoch: string): Promise<void> {
    // Not current until it is whole: a build that fails part-way (a vault that will not open) leaves no epoch, so the
    // next search builds everything again instead of answering from half an index.
    this.epoch = undefined;
    for (const key of [...this.index.keys()]) this.index.remove(key);
    this.seen.clear();
    await this.refresh(this.ports.sources);
    this.epoch = epoch;
    this.lastSweepMs = this.ports.now();
  }

  /** Re-reads these sources and re-indexes the pieces whose object changed. */
  private async refresh(sources: readonly WorkSource[]): Promise<void> {
    for (const source of sources) {
      this.dirty.delete(source.id);
      let listed: readonly RawWork[];
      try {
        listed = await source.list();
      } catch (error) {
        // An unreadable source keeps what was indexed from it; its owner reports the damage itself.
        this.ports.warn(`work search could not read ${source.id}: ${message(error)}`);
        continue;
      }
      const before = this.seen.get(source.id) ?? new Map<string, RawWork>();
      const after = new Map(listed.map(work => [work.key, work] as const));
      for (const key of before.keys())
        if (!after.has(key)) {
          this.index.remove(key);
          before.delete(key);
        }
      const changed = listed.filter(work => before.get(work.key) !== work);
      this.seen.set(source.id, before);
      for (const chunk of chunksOf(changed, WORK_SEARCH_INDEX_CHUNK)) {
        const documents = await this.ports.redaction.batch(scrub =>
          chunk.map(work => ({ work, document: workDocument(work, scrub) })),
        );
        for (const { work, document } of documents) {
          before.set(work.key, work);
          this.index.put(document);
        }
        await yieldToLoop();
      }
    }
  }

  /** Every source, in the background: what catches edits made outside this daemon. */
  private startSweep(): void {
    if (this.sweeping !== undefined) return;
    this.lastSweepMs = this.ports.now();
    this.sweeping = this.serial(async () => await this.refresh(this.ports.sources))
      .catch((error: unknown) => this.ports.warn(`work search could not sweep its sources: ${message(error)}`))
      .finally(() => {
        this.sweeping = undefined;
      });
  }

  /** Runs `work` after every update queued before it. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Waits for a sweep in flight. For tests and an orderly shutdown. */
  async settled(): Promise<void> {
    await this.sweeping;
    await this.tail;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
