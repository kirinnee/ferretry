import type { AnalyticsIndexStatus, AnalyticsRawSession } from '@ferretry/protocol';
import type { TranscriptHarness } from '../transcript/types.ts';
import { gateAnalyticsIngest, type AnalyticsIngestRefusal } from './ingest.ts';
import type { AnalyticsPricingRate } from './pricing.ts';
import { deriveAnalyticsSessionRecord, type FinishedAnalyticsSession } from './session-record.ts';
import {
  analyticsIngestSignature,
  analyticsPricingCatalogFingerprint,
  type AnalyticsIndexStore,
  type AnalyticsStoredSession,
} from './store.ts';
import { foldAnalyticsSessionUsage, type AnalyticsTranscriptEvidenceSource } from './usage-fold.ts';

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
export interface AnalyticsIngestCandidateSource {
  listCandidates(): Promise<readonly AnalyticsIngestCandidate[]>;
}

export interface AnalyticsIngestClock {
  now(): string;
}

export interface AnalyticsIngestionParts {
  readonly candidates: AnalyticsIngestCandidateSource;
  readonly evidence: AnalyticsTranscriptEvidenceSource;
  readonly store: AnalyticsIndexStore;
  /** Read per pass, never held: an operator may edit the catalog while the daemon runs. */
  readonly pricing: () => readonly AnalyticsPricingRate[];
  readonly clock: AnalyticsIngestClock;
  /** How many transcripts may be folded at once. Each read is bounded on its own; this bounds how
   *  many of those bounds are resident at the same instant. */
  readonly concurrency: number;
  /**
   * Whether the store handed over was created fresh or discarded on open, so nothing carried across.
   *
   * DECLARED rather than inferred from an empty table. A daemon whose index was thrown away — a schema
   * it did not recognise, a file naming another state home — owes a full rebuild, and a daemon that
   * has simply never finished a session owes nothing. Both look like zero rows.
   */
  readonly rebuildRequired: boolean;
}

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
export class AnalyticsIngestionService implements AnalyticsIngestionLoop {
  private pass: AnalyticsIngestSummary | undefined;
  private refreshing = false;
  /** The tail of the pass chain. Always settled, never rejected. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly parts: AnalyticsIngestionParts) {}

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
    return await this.enqueue(async () => await this.sweep());
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
    const next = this.chain.then(async () => {
      this.refreshing = true;
      try {
        const summary = await work();
        this.pass = summary;
        return summary;
      } finally {
        this.refreshing = false;
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
    return {
      rows: this.parts.store.rows().map(row => row.raw),
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
        refreshing: this.refreshing,
        ...(status.lastIngestedAt === null ? {} : { lastTokenRefreshAt: status.lastIngestedAt }),
      },
    };
  }

  private async sweep(): Promise<AnalyticsIngestSummary> {
    const catalog = this.parts.pricing();
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

    // Rows for sessions the daemon no longer holds documents for are dropped rather than kept: the
    // records are authoritative, and an index outliving them would answer for a fleet that is gone.
    const live = new Set(admitted.map(entry => entry.session.id));
    const forgotten = [...stored.keys()].filter(id => !live.has(id));
    if (forgotten.length > 0) this.parts.store.forget(forgotten);

    const pending = admitted.filter(entry => {
      const marker = stored.get(entry.session.id);
      return !(marker?.signature === entry.signature && marker.hasUsage);
    });

    let sourceErrors = 0;
    let usageRefused = 0;
    const rows: AnalyticsStoredSession[] = [];
    for (let start = 0; start < pending.length; start += this.parts.concurrency) {
      const batch = await Promise.all(
        pending.slice(start, start + this.parts.concurrency).map(async entry => await this.materialize(entry, catalog)),
      );
      for (const result of batch) {
        if (result.sourceError) sourceErrors += 1;
        if (result.row.usageRefusal !== null) usageRefused += 1;
        rows.push(result.row);
      }
    }
    if (rows.length > 0) this.parts.store.upsert(rows);

    return {
      examined: candidates.length,
      gateRefused: candidates.length - admitted.length,
      gateRefusals,
      ingested: rows.length,
      unchanged: admitted.length - pending.length,
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
    const evidence = await this.parts.evidence
      .evidenceFor(entry.session.id, entry.candidate.transcriptHarness)
      .catch(() => undefined);
    const fold = foldAnalyticsSessionUsage(evidence ?? { kind: 'unreadable' });
    const derived = deriveAnalyticsSessionRecord(
      { ...entry.session, usage: fold.kind === 'usage' ? fold.usage : null },
      catalog,
    );
    return {
      sourceError: evidence === undefined,
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
