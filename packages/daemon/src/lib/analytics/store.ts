import { createHash } from 'node:crypto';
import { ANALYTICS_PRICING_RATE_SLOTS, type AnalyticsRawSession } from '@ferretry/protocol';
import type { FoundationPaths } from '../paths.ts';
import type { FileSystemPort } from '../ports.ts';
import type { AnalyticsPricingRate, AnalyticsUsagePricingSnapshot } from './pricing.ts';
import type { AnalyticsUsageRefusal } from './usage-fold.ts';

/**
 * The stored analytics schema this daemon materializes.
 *
 * It is `2` because the shape CHANGED: version 1 was a derivation held in memory for the length of one
 * request, and this one is a durable table of ingested rows carrying an ingest-time price. A client
 * that reads the version can therefore tell a daemon whose costs were computed when the row was
 * written from one that computed them when the query ran, which are different numbers the moment an
 * operator edits the rate catalog.
 */
export const ANALYTICS_INDEX_SCHEMA_VERSION = 2;

/**
 * One session as the analytics index holds it.
 *
 * `usageRefusal` and the token columns in `raw` are TWO HALVES OF ONE FACT and the store keeps them
 * consistent: a refusal means every token column is `null` and the cost is unpriced, and a proven
 * total means the refusal is `null`. Storing the reason rather than only the absence is what lets the
 * daemon answer "this session's transcript could not be found" instead of the flatly wrong "this
 * session used no tokens" — and it is what lets a later pass tell a refusal worth re-attempting from
 * a total that is already final.
 */
export interface AnalyticsStoredSession {
  /** The wire row, priced when it was ingested. */
  readonly raw: AnalyticsRawSession;
  /** The instant the session ended, as the durable state document recorded it. */
  readonly finishedAt: string;
  /** Why this session has no token total, or `null` when it has one. */
  readonly usageRefusal: AnalyticsUsageRefusal | null;
  /** The rate that produced `raw.equivalentApiCostUsdMicros`, or why none did. */
  readonly pricing: AnalyticsUsagePricingSnapshot | null;
  /** The evidence fingerprint this row was built from; see `analyticsIngestSignature`. */
  readonly signature: string;
  /** When this daemon wrote the row. */
  readonly ingestedAt: string;
}

/** What the stored index consists of, as the store itself can count it. */
export interface AnalyticsStoreStatus {
  readonly schemaVersion: number;
  readonly sessions: number;
  /** Rows carrying a proven token total. */
  readonly tokenSessions: number;
  /** Rows whose transcript evidence this daemon refused; never counted as zero-token sessions. */
  readonly refusedUsageSessions: number;
  /** The newest `ingestedAt` in the table, or `null` when nothing is ingested. */
  readonly lastIngestedAt: string | null;
}

/**
 * The durable analytics materialization, behind an interface.
 *
 * DISPOSABLE BY CONTRACT. Nothing here is a source of truth: every row is derived from a session's own
 * durable documents and its own transcript, and `drop` exists so the whole table can be discarded and
 * rebuilt from those records. A store that could not be dropped would be a second authority on what
 * the fleet did, which is the one thing an index must never become.
 *
 * IDEMPOTENT BY KEY. `upsert` is keyed on the session id, so a pass that runs twice — a retry after a
 * crash, two overlapping sweeps — replaces a row rather than adding to it. There is no accumulating
 * column anywhere in the schema, so re-ingestion cannot double-count by construction rather than by
 * the caller remembering not to.
 */
export interface AnalyticsIndexStore {
  /** The evidence fingerprint and usage outcome already stored per session id. */
  ingested(): ReadonlyMap<string, AnalyticsIngestedMarker>;
  /** Write or replace rows. Keyed on session id; never additive. */
  upsert(rows: readonly AnalyticsStoredSession[]): void;
  /** Drop rows for sessions the daemon no longer holds a durable record for. */
  forget(ids: readonly string[]): void;
  /** Every stored row, for the query surface to filter and aggregate. */
  rows(): readonly AnalyticsStoredSession[];
  status(): AnalyticsStoreStatus;
  /** Discard the whole materialization. The next pass rebuilds it from the durable records. */
  drop(): void;
  close(): void;
}

/** What opening the analytics store produced, and whether anything survived the open. */
export interface OpenedAnalyticsIndexStore {
  readonly store: AnalyticsIndexStore;
  /**
   * `true` when the file was created fresh or thrown away on open, so the daemon owes a full pass
   * rather than an incremental one. Reported rather than inferred from an empty table: an index that
   * genuinely holds no finished sessions is not the same as one that was just discarded.
   */
  readonly rebuildRequired: boolean;
}

/** Where the analytics store comes from. Implemented only by adapters. */
export interface AnalyticsIndexStoreFactory {
  open(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<OpenedAnalyticsIndexStore>;
}

/** What the store remembers about a session it has already ingested. */
export interface AnalyticsIngestedMarker {
  readonly signature: string;
  /** `true` when the stored row carries a proven token total, so its transcript need not be read again. */
  readonly hasUsage: boolean;
}

/** Opening an existing analytics index: keep it, or throw it away and rebuild. */
export type AnalyticsIndexSchemaDecision = 'create' | 'use' | 'drop-and-rebuild';

/** The state of an analytics index file as an adapter finds it on disk. */
export interface AnalyticsIndexShape {
  readonly foundVersion: number;
  readonly hasTables: boolean;
  readonly hasExpectedShape: boolean;
  /**
   * The state home the file's own metadata claims it was built for, or `null` when it claims none.
   *
   * ONE DAEMON'S ANALYTICS MUST NEVER BE READ AS ANOTHER'S. The file lives under a state home, but a
   * copied, restored or hand-moved index would still open, and every row in it would then be reported
   * as this daemon's fleet. So the home is written into the file and checked on open.
   */
  readonly storedHome: string | null;
}

/**
 * Whether an analytics index found on disk may be served.
 *
 * FAIL CLOSED ON AMBIGUOUS EVIDENCE. An unrecognised version, a shape that does not match, or a file
 * that names a different home — or names none at all — is DROPPED rather than read as far as it
 * parses. Dropping costs one re-ingestion pass; serving it reports another daemon's spend, or this
 * daemon's spend under a derivation nobody can name, as fact.
 */
export function decideAnalyticsIndexSchema(shape: AnalyticsIndexShape, home: string): AnalyticsIndexSchemaDecision {
  if (!shape.hasTables) return 'create';
  return shape.foundVersion === ANALYTICS_INDEX_SCHEMA_VERSION && shape.hasExpectedShape && shape.storedHome === home
    ? 'use'
    : 'drop-and-rebuild';
}

/**
 * A hash over a list of values, where ABSENT AND EMPTY ARE DIFFERENT VALUES.
 *
 * An absent part is spelled with a byte no value can contain, and the separator is another, so two
 * different lists can never hash the same. Joining on a space instead would make a cleared label and an
 * empty one the same evidence, and the row for a session whose label was removed would never be
 * rewritten.
 */
function fingerprint(parts: readonly (string | number | boolean | null | undefined)[]): string {
  const absent = '\u0001';
  const separator = '\u0000';
  return createHash('sha256')
    .update(parts.map(part => (part === null || part === undefined ? absent : String(part))).join(separator))
    .digest('hex')
    .slice(0, 32);
}

/**
 * A fingerprint of the operator's rate catalog.
 *
 * It is part of every session's signature, so editing the catalog re-prices the index on the next pass
 * instead of leaving rows priced by rates the operator has withdrawn. That is not the same as history
 * mutating silently: each stored row carries the rate snapshot it was priced with, and a correctly
 * authored catalog change is bounded by `validFrom`/`validThrough`, so re-pricing a past session
 * resolves the same rate it resolved before.
 *
 * Order-insensitive, because a catalog that lists the same rates in a different order is the same
 * catalog and must not force the whole fleet to be re-ingested.
 */
export function analyticsPricingCatalogFingerprint(catalog: readonly AnalyticsPricingRate[]): string {
  const entries = catalog
    .map(rate =>
      fingerprint([
        rate.pricingKey,
        rate.modelId,
        [...rate.aliases].sort().join(','),
        rate.provider,
        rate.currency,
        // Every slot, read through the protocol's own list: a rate the catalog grows must change the
        // fingerprint, and a hand-written field list is exactly how one would silently stop doing so.
        ...ANALYTICS_PRICING_RATE_SLOTS.map(slot => rate.rates[slot]),
        rate.source.kind,
        rate.source.kind === 'provider_sync' ? rate.source.sourceUrl : null,
        rate.verifiedAt,
        rate.validFrom,
        rate.validThrough,
        rate.lastSyncedAt,
      ]),
    )
    .sort();
  return fingerprint([ANALYTICS_INDEX_SCHEMA_VERSION, ...entries]);
}

/** The session facts a stored row is derived from, for signing. */
export interface AnalyticsSignedEvidence {
  readonly id: string;
  readonly createdAt: string;
  readonly finishedAt: string;
  readonly status: string;
  readonly agent?: string | null;
  readonly selectedModel?: string | null;
  readonly contextWindow?: number | null;
  readonly harness?: string | null;
  readonly mode?: string | null;
  readonly label?: string | null;
  readonly cwd?: string | null;
  readonly parent?: string | null;
  readonly startedAt?: string | null;
  readonly turns?: number | null;
  readonly contextEndPercent?: number | null;
  readonly migrated: boolean;
}

/**
 * A cheap fingerprint of everything outside the transcript that decides a row.
 *
 * WHAT IT BUYS. A session that has already been ingested and whose signature has not changed does not
 * have its transcript read again. Before the store existed, every analytics query folded every
 * finished session's whole transcript, so the cost of one question grew with the whole history of the
 * fleet. The signature is what turns that into a one-time cost per session.
 *
 * WHY THE TRANSCRIPT IS NOT IN IT. Fingerprinting the transcript would mean reading the transcript,
 * which is the exact work the signature exists to avoid. It is sound to leave out because a session
 * only reaches here with a durable terminal state, and a finished session's transcript is final — but
 * that soundness is why a REFUSED fold is re-attempted on later passes anyway: a refusal is a
 * statement about what this daemon could read, not proof about what the session spent.
 */
export function analyticsIngestSignature(evidence: AnalyticsSignedEvidence, pricingFingerprint: string): string {
  return fingerprint([
    ANALYTICS_INDEX_SCHEMA_VERSION,
    pricingFingerprint,
    evidence.id,
    evidence.createdAt,
    evidence.finishedAt,
    evidence.status,
    evidence.agent,
    evidence.selectedModel,
    evidence.contextWindow,
    evidence.harness,
    evidence.mode,
    evidence.label,
    evidence.cwd,
    evidence.parent,
    evidence.startedAt,
    evidence.turns,
    evidence.contextEndPercent,
    evidence.migrated,
  ]);
}
