/**
 * WORK SEARCH: keeps the {@link WorkIndex} as current as the files it projects, and answers the search
 * and related-check routes from it (docs/work-search.md § Freshness).
 *
 * THE FILES ARE THE TRUTH; the index is a copy that must never be stale where a reader could tell:
 *
 * - **Cards.** The board store already holds every card in memory and replaces a card's object on each
 *   write. Every search walks that list and re-indexes only cards whose object changed — a pointer
 *   comparison per card, no I/O. A card edited on disk by hand is noticed by the board store's own
 *   directory watch, which replaces its object the same way.
 * - **Agenda items.** A committed agenda change names its session ({@link changed}, wired as an agenda
 *   change observer); the next search re-reads that one ledger first. Every
 *   {@link WORK_SEARCH_SWEEP_MS} a search also starts a background sweep of every session's ledger, which
 *   the ledger repository answers from its identity-proved cache, so an edit made outside this daemon is
 *   found within the sweep interval, never later.
 * - **Secrets.** Every text passes the redactor's scrub before it is indexed. When the set of known
 *   values changes (its epoch), the next search rebuilds the whole index before it answers, so a value
 *   registered as a secret after it was written on a card stops being findable at once.
 *
 * The first search waits for the first full build; {@link warm} starts it at boot so it rarely has to.
 */
import type {
  BoardTask,
  BoardProjectId,
  LaneSet,
  WorkHit,
  WorkRelatedRequest,
  WorkRelatedResponse,
  WorkSearchQuery,
  WorkSearchResponse,
} from '@ferretry/protocol';
import { MAX_WORK_RELATED_HITS } from '@ferretry/protocol';
import type { AgendaLedger } from '../agenda/state-machine.ts';
import { cardDocument, ledgerDocuments, type ScrubText, taskKey, type WorkDocument } from './documents.ts';
import { WorkIndex } from './work-index.ts';

/** How stale a sweep of every ledger and every board's lanes may grow before a search starts the next. */
export const WORK_SEARCH_SWEEP_MS = 5_000;

/** The board's cards, as the store holds them now. Each card's object changes exactly when the card does. */
export interface WorkCardSource {
  cards(): Promise<readonly BoardTask[]>;
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
}

/** Every session's agenda ledger. `ledger` returns the same object while the file is unchanged. */
export interface WorkAgendaSource {
  sessions(): Promise<readonly string[]>;
  ledger(sessionId: string): Promise<AgendaLedger | null>;
}

/** The secret redactor, as indexing needs it: a scrub for one batch, and a name for the current values. */
export interface WorkRedaction {
  batch<T>(work: (scrub: ScrubText) => T): Promise<T>;
  /** Changes whenever the set of known secret values may have. */
  epoch(): Promise<string>;
}

export interface WorkSearchDependencies {
  readonly cards: WorkCardSource;
  readonly agenda: WorkAgendaSource;
  readonly redaction: WorkRedaction;
  readonly now: () => number;
  readonly warn: (message: string) => void;
}

interface SeenLedger {
  readonly ledger: AgendaLedger;
  readonly keys: readonly string[];
}

export class WorkSearchService {
  private readonly index = new WorkIndex();
  private readonly seenCards = new Map<string, BoardTask>();
  private readonly seenLedgers = new Map<string, SeenLedger>();
  private readonly laneSets = new Map<BoardProjectId, LaneSet | null>();
  private readonly dirtySessions = new Set<string>();
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

  async search(query: WorkSearchQuery): Promise<WorkSearchResponse> {
    await this.current();
    const { hits, total } = this.index.search(query, this.ports.now());
    return { hits: await this.masked(hits), total, indexed: this.index.size };
  }

  async related(request: WorkRelatedRequest): Promise<WorkRelatedResponse> {
    await this.current();
    const matches = this.index.related(request.title, request.ask ?? '', this.ports.now(), MAX_WORK_RELATED_HITS);
    const hits = await this.masked(matches.map(match => match.hit));
    return { matches: matches.map((match, at) => ({ strength: match.strength, hit: hits[at] ?? match.hit })) };
  }

  /**
   * The answer scrubbed once more, as it leaves: the index was built from scrubbed text, and this covers a
   * value that became known after its document was indexed and before the epoch could say so.
   */
  private async masked(hits: readonly WorkHit[]): Promise<WorkHit[]> {
    if (hits.length === 0) return [];
    return await this.ports.redaction.batch(scrub =>
      hits.map(hit => ({ ...hit, title: scrub(hit.title), match: { ...hit.match, line: scrub(hit.match.line) } })),
    );
  }

  /** An agenda change committed in `sessionId`: its ledger is re-read before the next answer. */
  async changed(sessionId: string): Promise<void> {
    this.dirtySessions.add(sessionId);
  }

  /** The index as current as a search must see it. */
  private async current(): Promise<void> {
    await this.ready();
    await this.serial(async () => {
      const epoch = await this.ports.redaction.epoch();
      if (epoch !== this.epoch) await this.rebuild(epoch);
      else {
        await this.refreshCards();
        await this.refreshSessions([...this.dirtySessions]);
      }
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
    // Not current until it is whole: a build that fails part-way (a vault that will not open) leaves no epoch,
    // so the next search builds everything again instead of answering from half an index.
    this.epoch = undefined;
    for (const key of [...this.index.keys()]) this.index.remove(key);
    this.seenCards.clear();
    this.seenLedgers.clear();
    this.laneSets.clear();
    await this.refreshCards();
    await this.refreshSessions(await this.ports.agenda.sessions());
    this.epoch = epoch;
    this.lastSweepMs = this.ports.now();
  }

  private async refreshCards(): Promise<void> {
    const cards = await this.ports.cards.cards();
    const changed = cards.filter(card => this.seenCards.get(card.id) !== card);
    const present = new Set(cards.map(card => card.id));
    for (const id of [...this.seenCards.keys()])
      if (!present.has(id)) {
        this.seenCards.delete(id);
        this.index.remove(taskKey(id));
      }
    if (changed.length === 0) return;
    for (const projectId of new Set(changed.map(card => card.projectId)))
      if (!this.laneSets.has(projectId)) this.laneSets.set(projectId, await this.ports.cards.laneSet(projectId));
    const nowMs = this.ports.now();
    const documents = await this.ports.redaction.batch(scrub =>
      changed.map(card => ({
        card,
        document: cardDocument(card, this.laneSets.get(card.projectId) ?? undefined, scrub, nowMs),
      })),
    );
    for (const { card, document } of documents) {
      this.seenCards.set(card.id, card);
      if (document === undefined) this.index.remove(taskKey(card.id));
      else this.index.put(document);
    }
  }

  /** Re-reads these sessions' ledgers and re-indexes the ones that changed. */
  private async refreshSessions(sessionIds: readonly string[]): Promise<void> {
    const read: { sessionId: string; ledger: AgendaLedger | null }[] = [];
    for (const sessionId of sessionIds) {
      this.dirtySessions.delete(sessionId);
      try {
        const ledger = await this.ports.agenda.ledger(sessionId);
        if (ledger !== this.seenLedgers.get(sessionId)?.ledger) read.push({ sessionId, ledger });
      } catch (error) {
        // An unreadable ledger keeps what was indexed from it; the agenda reports the damage itself.
        this.ports.warn(`work search could not read the agenda of ${sessionId}: ${message(error)}`);
      }
    }
    if (read.length === 0) return;
    const nowMs = this.ports.now();
    const documents = await this.ports.redaction.batch(scrub =>
      read.map(({ sessionId, ledger }) => ({
        sessionId,
        ledger,
        documents: ledger === null ? [] : ledgerDocuments(ledger, scrub, nowMs),
      })),
    );
    for (const { sessionId, ledger, documents: found } of documents) this.replaceSession(sessionId, ledger, found);
  }

  private replaceSession(sessionId: string, ledger: AgendaLedger | null, documents: readonly WorkDocument[]): void {
    for (const key of this.seenLedgers.get(sessionId)?.keys ?? []) this.index.remove(key);
    for (const document of documents) this.index.put(document);
    if (ledger === null) this.seenLedgers.delete(sessionId);
    else this.seenLedgers.set(sessionId, { ledger, keys: documents.map(document => document.key) });
  }

  /** Every ledger and every board's lanes, in the background: what catches edits made outside this daemon. */
  private startSweep(): void {
    if (this.sweeping !== undefined) return;
    this.lastSweepMs = this.ports.now();
    this.sweeping = this.serial(async () => {
      const lanesBefore = new Map(this.laneSets);
      this.laneSets.clear();
      const sessions = await this.ports.agenda.sessions();
      const present = new Set(sessions);
      for (const sessionId of [...this.seenLedgers.keys()])
        if (!present.has(sessionId)) this.replaceSession(sessionId, null, []);
      await this.refreshSessions(sessions);
      // A board whose lanes changed (a rename, a lane made closed) re-indexes its cards with the new names.
      for (const [projectId, before] of lanesBefore) {
        const now = await this.ports.cards.laneSet(projectId);
        this.laneSets.set(projectId, now);
        if (laneKey(now) !== laneKey(before))
          for (const [id, card] of this.seenCards) if (card.projectId === projectId) this.seenCards.delete(id);
      }
      await this.refreshCards();
    })
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

const laneKey = (laneSet: LaneSet | null | undefined): string =>
  laneSet === null || laneSet === undefined
    ? ''
    : `${laneSet.version}:${laneSet.lanes.map(lane => `${lane.id}=${lane.name}/${lane.category}`).join(',')}`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
