import type { AnalyticsIndexStatus, AnalyticsRawSession } from '@ferretry/protocol';
import type { PassTrigger } from '../runtime/pass-trigger.ts';
import type { TranscriptHarness } from '../transcript/types.ts';
import { type AnalyticsIngestRefusal, analyticsStateEnded, gateAnalyticsIngest } from './ingest.ts';
import { withCostEvidence } from './cost-evidence.ts';
import { type AnalyticsPricingRate, analyticsCatalogAliasGroups } from './pricing.ts';
import { deriveAnalyticsSessionRecord, type FinishedAnalyticsSession } from './session-record.ts';
import {
  type AnalyticsIndexStore,
  type AnalyticsStoredSession,
  analyticsIngestSignature,
  analyticsPricingCatalogFingerprint,
} from './store.ts';
import type { AnalyticsModelAliasGroup } from '@ferretry/protocol';
import {
  type AnalyticsTranscriptEvidenceSource,
  type AnalyticsTranscriptFold,
  foldAnalyticsTranscript,
} from './usage-fold.ts';

/**
 * One session as its durable documents describe it, BEFORE anything has judged whether it ended.
 *
 * The terminality fields are optional-shaped on purpose: deciding them is the gate's job, and a
 * candidate source that pre-filtered them would be a second, unstated copy of that decision.
 */
export type AnalyticsIngestCandidate = Omit<
  FinishedAnalyticsSession,
  'createdAt' | 'finishedAt' | 'status' | 'stalled' | 'failed' | 'completed' | 'usage'
> & {
  /** Which harness's grammar this session's transcript is written in. */
  readonly transcriptHarness: TranscriptHarness;
  readonly createdAt?: string | null;
  readonly finishedAt?: string | null;
  readonly status?: string | null;
};

/** Every session the daemon holds durable documents for, parsed but unjudged. */
/** A session's transcript, read and folded off the event loop: the fold alone comes back. */
export interface AnalyticsTranscriptFoldSource {
  foldFor(
    sessionId: string,
    harness: TranscriptHarness,
    aliasGroups: readonly AnalyticsModelAliasGroup[],
  ): Promise<AnalyticsTranscriptFold>;
}

export interface AnalyticsIngestCandidateSource {
  listCandidates(): Promise<readonly AnalyticsIngestCandidate[]>;
}

export interface AnalyticsIngestClock {
  now(): string;
}

export interface AnalyticsIngestionParts {
  readonly candidates: AnalyticsIngestCandidateSource;
  readonly evidence: AnalyticsTranscriptEvidenceSource;
  /**
   * Reads AND folds a transcript somewhere other than the event loop — a worker thread — and hands back
   * only the fold. Absent, the evidence is read through {@link evidence} and folded here.
   *
   * WHY. A finished session's transcript is read whole (up to 32 MiB) and every event of it is folded;
   * on the event loop that was the largest single block left after parsing yielded, and the fold is
   * all ingestion keeps. A fold that RAISES is a source error, exactly like a read that raises.
   */
  readonly folds?: AnalyticsTranscriptFoldSource;
  readonly store: AnalyticsIndexStore;
  /**
   * The rate catalog, read once at the start of every pass and held for that pass only, so an operator
   * editing prices while the daemon runs is reflected by the next pass — never a restart.
   *
   * ASYNC ON PURPOSE. The composition root's real provider reads a config document that may not be in
   * memory, and a synchronous callback could not represent that read; making the seam async here is what
   * lets the daemon price from a live catalog without the ingestion service knowing how it is stored.
   *
   * A provider that REJECTS refuses the whole pass. With no catalog, no row could be priced, and
   * substituting an empty one would silently store a fleet's worth of unpriced rows — so the rejection
   * propagates out of the pass rather than being caught and counted the way a single transcript read is.
   */
  readonly pricing: () => Promise<readonly AnalyticsPricingRate[]>;
  readonly clock: AnalyticsIngestClock;
  /** How many transcripts may be folded at once. Each read is bounded on its own; this bounds how
   *  many of those bounds are resident at the same instant. */
  readonly concurrency: number;
  /**
   * How many transcripts one pass may read at most; the rest are left for the next pass.
   *
   * A rebuild over a large fleet used to read every finished transcript in one pass — hundreds of
   * megabytes, all at once, every boot. A cap turns that into a few each minute, so ingestion catches up
   * steadily instead of in one burst that holds everything else back. Absent is no cap.
   */
  readonly readsPerPass?: number;
  /**
   * Whether the store handed over was created fresh or discarded on open, so nothing carried across.
   *
   * DECLARED rather than inferred from an empty table. A daemon whose index was thrown away — a schema
   * it did not recognise, a file naming another state home — owes a full rebuild, and a daemon that
   * has simply never finished a session owes nothing. Both look like zero rows.
   */
  readonly rebuildRequired: boolean;
  /**
   * When a pass is due (docs/design/housekeeping-worker.md §4 PR 4): nudged by the events that change
   * what a pass would write, with a slow backstop of its own. Absent, nothing is ever due on its own —
   * passes run only when asked for.
   */
  readonly trigger?: Pick<PassTrigger, 'arm' | 'nudge'>;
}

/**
 * How long after a session ends its pass runs: long enough for the harness's last transcript lines to
 * land, so the one read of a finished transcript is of the finished one. The sweep this replaced ran
 * once a minute, so a session waited thirty seconds on average for it anyway.
 */
export const ANALYTICS_ENDED_SETTLE_MS = 30_000;

/** How long after the rates may have moved — a pricing edit, a config or catalog change — a pass runs. */
export const ANALYTICS_PRICING_SETTLE_MS = 5_000;

/** How soon a pass that stopped at its read cap is followed by the next, to keep catching up. */
export const ANALYTICS_CATCH_UP_MS = 60_000;

/**
 * The backstop: a pass at least this often, whatever happened. It is what retries a refusal — which
 * stands for exactly this long ({@link REFUSAL_RETRY_MS}) — and what notices a session whose documents
 * were removed, or a pricing document edited behind the daemon's back: inputs with no event to hear.
 */
export const ANALYTICS_BACKSTOP_MS = 15 * 60_000;

/**
 * The ingestion loop as the daemon process arms it.
 *
 * A background pass with no route would be invisible to the reachability gate, which is how a
 * subsystem ships unmounted — so this is a mounted subsystem in its own right rather than a timer the
 * read surface happens to own.
 */
export interface AnalyticsIngestionLoop {
  /** Whether the first pass must be a rebuild rather than an incremental one. */
  readonly rebuildRequired: boolean;
  ingest(): Promise<AnalyticsIngestSummary>;
  rebuild(): Promise<AnalyticsIngestSummary>;
  /** Calls `due` whenever a pass is due, until the answer is called. */
  arm(due: () => void): () => void;
}

/** What one ingestion pass did. Every number is a count of sessions. */
export interface AnalyticsIngestSummary {
  /** Durable session documents examined. */
  readonly examined: number;
  /** Sessions the terminal-state gate refused, with the reasons it gave. */
  readonly gateRefused: number;
  readonly gateRefusals: Readonly<Partial<Record<AnalyticsIngestRefusal, number>>>;
  /** Rows written or replaced. */
  readonly ingested: number;
  /** Sessions already stored whose evidence cannot have changed, so no transcript was read. */
  readonly unchanged: number;
  /**
   * Sessions whose last read was REFUSED and whose evidence has not changed since, left unread this
   * pass because that refusal is younger than {@link REFUSAL_RETRY_MS}. Their stored rows keep saying
   * exactly what they said — refused, never zero.
   */
  readonly deferred: number;
  /** Sessions due a read that this pass left for the next one, because it reached its read cap. */
  readonly postponed: number;
  /** Rows stored with a token total this daemon could not prove. Never stored as zero. */
  readonly usageRefused: number;
  /** Transcript reads that raised rather than answering. */
  readonly sourceErrors: number;
  /** Rows dropped because the daemon no longer holds a durable record for that session. */
  readonly forgotten: number;
  readonly completedAt: string;
}

/** The analytics index as a reader sees it: the rows, and what they consist of. */
export interface AnalyticsIndexRead {
  readonly rows: readonly AnalyticsRawSession[];
  readonly status: AnalyticsIndexStatus;
  /** When this read was taken, by the ingestion clock: the instant a relative range ends at. */
  readonly now: string;
}

interface AdmittedCandidate {
  readonly candidate: AnalyticsIngestCandidate;
  readonly session: Omit<FinishedAnalyticsSession, 'usage'>;
  readonly signature: string;
}

/**
 * Ingestion of finished sessions into the queryable analytics store, and the read over it.
 *
 * WHY A STORE AT ALL. The analytics read used to derive everything per request: every finished
 * session's documents parsed and its whole transcript folded, on every question. That made the cost of
 * one query grow with the entire history of the fleet, and it meant no richer analytics surface could
 * be built on top without paying that cost per panel. Ingesting once at a terminal state and querying
 * the result is the foundation the rest of analytics needs.
 *
 * WHAT IS INGESTED, AND WHEN. Only a session in a durable terminal state — see `gateAnalyticsIngest`.
 * A session still running is not ingested at all, rather than ingested with the totals it happens to
 * have; a session whose transcript this daemon could not read IS ingested, as a row whose token
 * columns are null and whose refusal reason is recorded. Neither is ever stored as a zero.
 *
 * WHY RE-INGESTION IS SAFE. Rows are keyed on the session id and no column accumulates, so a pass that
 * runs twice replaces rather than adds. A crash mid-pass leaves the rows it had already written, and
 * the next pass reproduces exactly the same rows for the same evidence.
 *
 * WHY REFUSALS ARE RE-ATTEMPTED. A signature match skips the transcript read only for a row that
 * already carries a proven total. A refusal says what this daemon could read at that moment — a
 * transcript it had not yet resolved, a file mid-write — so it is retried, and the row is corrected as
 * soon as the evidence can be read. A proven total is never re-read: the session is over and its
 * transcript is final.
 */
/**
 * How long a refused read stands before a pass reads that transcript again, while nothing about the
 * session has changed.
 *
 * A refusal used to be retried on EVERY pass, and the commonest refusal is permanent: a finished
 * transcript bigger than the bounded read is refused as truncated, and stays exactly that big. Each
 * retry re-read 32 MiB from byte zero and parsed it — most of a second of a blocked event loop per
 * session, every minute, for as long as the daemon ran. A refusal that a changed session could clear
 * is still re-read at once, because its signature moves; only an identical one waits.
 */
export const REFUSAL_RETRY_MS = 15 * 60_000;

/**
 * The refusals that waited on a read of the transcript itself — the expensive ones, and the ones a
 * finished session's final transcript will give again. "Unresolved" and "unreadable" are NOT here:
 * neither read the file, and either can clear the moment a transcript is attributed or a disk comes
 * back, so they are retried on every pass as before.
 */
const READ_REFUSALS: ReadonlySet<string> = new Set([
  'transcript_damaged',
  'transcript_incomplete',
  'no_usage_evidence',
  'ambiguous_token_accounting',
]);

export class AnalyticsIngestionService implements AnalyticsIngestionLoop {
  private pass: AnalyticsIngestSummary | undefined;
  /**
   * An ingest pass asked for and not yet started. A second ask while one is waiting joins it instead
   * of queueing another: the waiting pass will read everything the second would have, and a timer that
   * outpaced a slow pass used to grow this queue without bound.
   */
  private waiting: Promise<AnalyticsIngestSummary> | undefined;
  /** When each session's read was last refused, and under which signature. See {@link REFUSAL_RETRY_MS}. */
  private readonly refusals = new Map<string, { readonly signature: string; readonly atMs: number }>();
  /**
   * Passes asked for and not yet finished, including any still queued.
   *
   * COUNTED rather than flagged, because a pass that completes while another is queued behind it has not
   * left the index settled. A boolean set by the finisher would report `refreshing: false` with work
   * still outstanding, which is the reading a caller uses to decide the index is as complete as it gets.
   */
  private pending = 0;
  /** The tail of the pass chain. Always settled, never rejected. */
  private chain: Promise<void> = Promise.resolve();
  /** The sessions the last pass admitted: every one the index holds a row for, or is about to. */
  private admitted: ReadonlySet<string> = new Set();
  /** The catalog the last pass priced with: what "today's rates" means to a read between passes. */
  private catalog: readonly AnalyticsPricingRate[] | undefined;

  constructor(private readonly parts: AnalyticsIngestionParts) {}

  arm(due: () => void): () => void {
    return this.parts.trigger?.arm(due) ?? (() => undefined);
  }

  /** Storage wrote this session's state: a pass follows when the write {@link owes} one. */
  stateWritten(sessionId: string, state: unknown): void {
    if (this.owes(sessionId, state)) this.parts.trigger?.nudge(ANALYTICS_ENDED_SETTLE_MS);
  }

  /**
   * The rates may have moved. Every row's signature carries the catalog's fingerprint, so a pass
   * re-prices exactly the rows a real change touched, and costs nothing when none did.
   */
  pricingChanged(): void {
    this.parts.trigger?.nudge(ANALYTICS_PRICING_SETTLE_MS);
  }

  /**
   * Whether a state document just written for `sessionId` could change what the index holds, so a pass
   * is owed for it.
   *
   * A session that has ENDED is owed one: it may be new to the index, or its row's evidence may have
   * moved. A session that has not ended is owed one only when the index holds it — a revive, whose
   * row the next pass must drop. Every other write — a running session's turn, its usage, its
   * attention — changes nothing a pass would write, which is what lets ingestion wait for an event
   * instead of sweeping every minute.
   */
  owes(sessionId: string, state: unknown): boolean {
    return analyticsStateEnded(state) || this.admitted.has(sessionId);
  }

  get rebuildRequired(): boolean {
    return this.parts.rebuildRequired;
  }

  /** Discard the whole materialization and rebuild it from the durable records. */
  async rebuild(): Promise<AnalyticsIngestSummary> {
    return await this.enqueue(async () => {
      this.parts.store.drop();
      return await this.sweep();
    });
  }

  /** One pass over every session the daemon holds durable documents for. */
  async ingest(): Promise<AnalyticsIngestSummary> {
    if (this.waiting !== undefined) return await this.waiting;
    const pass = this.enqueue(async () => {
      this.waiting = undefined;
      return await this.sweep();
    });
    this.waiting = pass;
    return await pass;
  }

  /**
   * Passes run one at a time, in the order they were asked for.
   *
   * Two overlapping passes would each read the store's markers before the other wrote its rows, so the
   * loser would re-fold transcripts the winner had just proved — and a rebuild interleaved with a pass
   * would drop rows that pass was about to count as unchanged. The timer keeps firing regardless of how
   * long a pass takes, which is exactly the case this serializes.
   */
  private async enqueue(work: () => Promise<AnalyticsIngestSummary>): Promise<AnalyticsIngestSummary> {
    // Counted the moment the pass is ASKED FOR, not when it starts running: between those two instants
    // there is outstanding work, and a read that called the index settled would be wrong.
    this.pending += 1;
    const next = this.chain.then(async () => {
      try {
        const summary = await work();
        this.pass = summary;
        return summary;
      } finally {
        this.pending -= 1;
      }
    });
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  /** The stored rows and an honest account of what they are. */
  read(): AnalyticsIndexRead {
    const status = this.parts.store.status();
    const now = this.parts.clock.now();
    return {
      now,
      rows: this.parts.store.rows().map(row => withCostEvidence(row, this.catalog, now)),
      status: {
        schemaVersion: status.schemaVersion,
        sessions: status.sessions,
        tokenSessions: status.tokenSessions,
        // One transcript per stored row: every ingested session's total was folded from its own.
        transcriptSources: status.sessions,
        indexedTranscriptSources: status.tokenSessions,
        // A row whose fold was refused is PENDING, not indexed — the next pass re-attempts it.
        pendingTranscriptSources: status.refusedUsageSessions,
        sourceErrors: this.pass?.sourceErrors ?? 0,
        refreshing: this.pending > 0,
        ...(status.lastIngestedAt === null ? {} : { lastTokenRefreshAt: status.lastIngestedAt }),
      },
    };
  }

  private async sweep(): Promise<AnalyticsIngestSummary> {
    const catalog = await this.parts.pricing();
    this.catalog = catalog;
    const pricingFingerprint = analyticsPricingCatalogFingerprint(catalog);
    const candidates = await this.parts.candidates.listCandidates();
    const stored = this.parts.store.ingested();
    const gateRefusals: Partial<Record<AnalyticsIngestRefusal, number>> = {};
    const admitted: AdmittedCandidate[] = [];

    for (const candidate of candidates) {
      const gate = gateAnalyticsIngest(candidate);
      if (gate.kind === 'refused') {
        gateRefusals[gate.reason] = (gateRefusals[gate.reason] ?? 0) + 1;
        continue;
      }
      const session = {
        ...candidate,
        createdAt: gate.createdAt,
        finishedAt: gate.finishedAt,
        status: gate.status,
        stalled: gate.status === 'stalled',
        failed: gate.status === 'failed',
        completed: gate.status === 'completed',
      };
      admitted.push({ candidate, session, signature: analyticsIngestSignature(session, pricingFingerprint) });
    }

    /**
     * A stored row whose session is no longer an ingestable one is DROPPED, for two different reasons
     * that both come down to the records being authoritative.
     *
     * The session's documents are gone — an index outliving them would answer for a fleet that is not
     * there. Or the session is no longer finished: a revive puts a stopped session back to work, and
     * the totals ingested when it ended are no longer its final ones. Keeping that row would report a
     * running session's spend as a completed run's, and the next pass will ingest it again when it
     * ends for real.
     */
    const live = new Set(admitted.map(entry => entry.session.id));
    this.admitted = live;
    const forgotten = [...stored.keys()].filter(id => !live.has(id));
    if (forgotten.length > 0) this.parts.store.forget(forgotten);

    const stale = admitted.filter(entry => {
      const marker = stored.get(entry.session.id);
      return !(marker?.signature === entry.signature && marker.hasUsage);
    });
    // Read only when something could be deferred, so a pass with nothing stale reads the clock once.
    const nowMs = stale.length === 0 ? 0 : Date.parse(this.parts.clock.now());
    const pending = stale.filter(entry => {
      const marker = stored.get(entry.session.id);
      const refused = this.refusals.get(entry.session.id);
      return !(
        marker?.signature === entry.signature &&
        refused?.signature === entry.signature &&
        nowMs - refused.atMs < REFUSAL_RETRY_MS
      );
    });

    const due = pending.slice(0, Math.max(1, this.parts.readsPerPass ?? pending.length));
    let sourceErrors = 0;
    let usageRefused = 0;
    const rows: AnalyticsStoredSession[] = [];
    // At least one per batch, so a misconfigured concurrency is a slow pass rather than a loop that
    // never advances.
    const batchSize = Math.max(1, this.parts.concurrency);
    for (let start = 0; start < due.length; start += batchSize) {
      const batch = await Promise.all(
        due.slice(start, start + batchSize).map(async entry => await this.materialize(entry, catalog)),
      );
      for (const [index, result] of batch.entries()) {
        if (result.sourceError) sourceErrors += 1;
        if (result.row.usageRefusal !== null) usageRefused += 1;
        rows.push(result.row);
        const entry = due[start + index];
        if (entry === undefined) continue;
        if (result.row.usageRefusal !== null && READ_REFUSALS.has(result.row.usageRefusal))
          this.refusals.set(entry.session.id, { signature: entry.signature, atMs: nowMs });
        else this.refusals.delete(entry.session.id);
      }
    }
    if (rows.length > 0) this.parts.store.upsert(rows);
    // A pass that stopped at its read cap is followed soon by the next, until the backlog is read.
    if (pending.length > due.length) this.parts.trigger?.nudge(ANALYTICS_CATCH_UP_MS);

    return {
      examined: candidates.length,
      gateRefused: candidates.length - admitted.length,
      gateRefusals,
      ingested: rows.length,
      unchanged: admitted.length - stale.length,
      deferred: stale.length - pending.length,
      postponed: pending.length - due.length,
      usageRefused,
      sourceErrors,
      forgotten: forgotten.length,
      completedAt: this.parts.clock.now(),
    };
  }

  /**
   * One session's row, priced at the instant it is written.
   *
   * THE PRICE IS SNAPSHOTTED HERE, not computed when a query runs, and the rate that produced it is
   * stored beside the cost. That is what stops an operator's later catalog edit from silently rewriting
   * what last month cost.
   *
   * A transcript read that RAISES is treated as an unreadable transcript, not as an empty one, and it
   * is counted separately so the index can report that a source failed rather than reporting a fleet
   * that spent nothing.
   */
  private async materialize(
    entry: AdmittedCandidate,
    catalog: readonly AnalyticsPricingRate[],
  ): Promise<{ readonly row: AnalyticsStoredSession; readonly sourceError: boolean }> {
    // The catalog's alias groups have to reach the FOLD, not just the pricing step after it: the fold
    // is where two spellings become one identity or a mixed-model refusal, and a refusal decided
    // without them is one nothing downstream can reverse.
    const aliasGroups = analyticsCatalogAliasGroups(catalog);
    const { id } = entry.session;
    const harness = entry.candidate.transcriptHarness;
    const folded = await (
      this.parts.folds === undefined
        ? this.parts.evidence.evidenceFor(id, harness).then(evidence => foldAnalyticsTranscript(evidence, aliasGroups))
        : this.parts.folds.foldFor(id, harness, aliasGroups)
    ).catch(() => undefined);
    const { usage: fold, activity } = folded ?? foldAnalyticsTranscript({ kind: 'unreadable' }, aliasGroups);
    const derived = deriveAnalyticsSessionRecord(
      {
        ...entry.session,
        usage: fold.kind === 'usage' ? fold.usage : null,
        activity,
      },
      catalog,
    );
    return {
      sourceError: folded === undefined,
      row: {
        raw: derived.raw,
        finishedAt: entry.session.finishedAt,
        usageRefusal: fold.kind === 'refused' ? fold.reason : null,
        pricing: derived.pricing,
        signature: entry.signature,
        ingestedAt: this.parts.clock.now(),
      },
    };
  }
}
