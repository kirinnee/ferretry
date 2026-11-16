import {
  AnalyticsPricingCurrencySchema,
  AnalyticsPricingProviderSchema,
  AnalyticsPricingSourceSchema,
} from '../../../contract/index.ts';
import type { SqliteHandle } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { InstantSchema } from '../../../contract/common.ts';
import {
  ANALYTICS_INDEX_SCHEMA_VERSION,
  type AnalyticsIndexStore,
  type AnalyticsIngestedMarker,
  type AnalyticsStoredSession,
  type AnalyticsStoreStatus,
  decideAnalyticsIndexSchema,
  type OpenedAnalyticsIndexStore,
} from '../../lib/analytics/store.ts';
import { NO_ANALYTICS_WRITES } from '../../lib/analytics/store-writes.ts';
import type {
  AnalyticsPricingCurrency,
  AnalyticsPricingProvider,
  AnalyticsPricingRateUnit,
  AnalyticsPricingSource,
} from '../../../contract/index.ts';
import type { AnalyticsPricingUnknownReason, AnalyticsUsagePricingSnapshot } from '../../lib/analytics/pricing.ts';
import type { AnalyticsUsageRefusal } from '../../lib/analytics/turn-fold.ts';
import { applyAnalyticsWrites, COLUMNS } from './sqlite-analytics-statements.ts';

/** The only denomination a stored snapshot's amounts can be in; see `pricingProvenanceFromRow`. */
const ANALYTICS_STORED_RATE_UNIT_SCHEMA = z.literal('million_tokens');

/**
 * The analytics materialization, in SQLite.
 *
 * COLUMNS, NOT A BLOB. Every measure and label the query grammar can name is its own column, and so is
 * every part of the rate that priced the row. A JSON document in one column would store the same facts
 * while making the store unqueryable, which is the one thing this table exists to be.
 *
 * WHAT THE ROW REMEMBERS BEYOND THE WIRE. Three things the answer does not carry: the evidence
 * signature that decides whether the session must be read again, the reason a token total was refused,
 * and the rate snapshot the cost was computed from. The last is the point of ingest-time pricing — the
 * row states which rates were in force, so an operator can change the catalog without rewriting what
 * last month cost.
 */
interface SessionRow {
  readonly id: string;
  readonly agent: string | null;
  readonly model: string | null;
  readonly context_window: number | null;
  readonly harness: string | null;
  readonly mode: string | null;
  readonly status: string | null;
  readonly label: string | null;
  readonly cwd: string | null;
  readonly parent: string | null;
  readonly tree: string | null;
  readonly day: string | null;
  readonly week: string | null;
  readonly created_at: string | null;
  readonly finished_at: string;
  readonly pricing_model: string | null;
  readonly equivalent_api_cost_usd_micros: number | null;
  readonly tokens: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_write_input_tokens: number | null;
  readonly cache_write_5m_input_tokens: number | null;
  readonly cache_write_1h_input_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly turns: number | null;
  readonly duration_ms: number | null;
  readonly active_duration_ms: number | null;
  readonly time_to_first_output_ms: number | null;
  readonly context_end_percent: number | null;
  readonly stalled: number;
  readonly failed: number;
  readonly completed: number;
  readonly usage_refusal: string | null;
  readonly pricing_kind: string | null;
  readonly pricing_reason: string | null;
  readonly pricing_identity_raw: string | null;
  readonly pricing_identity_model_id: string | null;
  readonly pricing_identity_variant: string | null;
  readonly pricing_identity_context_window: number | null;
  readonly pricing_identity_revision: string | null;
  readonly pricing_key: string | null;
  readonly pricing_provider: string | null;
  readonly pricing_currency: string | null;
  readonly pricing_rate_unit: string | null;
  readonly pricing_source_kind: string | null;
  readonly pricing_source_provider: string | null;
  readonly pricing_source_url: string | null;
  readonly pricing_last_synced_at: string | null;
  readonly pricing_verified_at: string | null;
  readonly pricing_valid_from: string | null;
  readonly pricing_valid_through: string | null;
  readonly rate_input: number | null;
  readonly rate_cached_read: number | null;
  readonly rate_cache_write: number | null;
  readonly rate_cache_write_5m: number | null;
  readonly rate_cache_write_1h: number | null;
  readonly rate_reasoning: number | null;
  readonly rate_output: number | null;
  readonly signature: string;
  readonly ingested_at: string;
}

const EXPECTED_TABLES = ['analytics_sessions'] as const;

function boolean(value: number): boolean {
  return value !== 0;
}

/** What a priced row says its numbers mean, once the stored bytes have been read as those facts. */
interface StoredPricingProvenance {
  readonly provider: AnalyticsPricingProvider;
  readonly currency: AnalyticsPricingCurrency;
  readonly rateUnit: AnalyticsPricingRateUnit;
  readonly source: AnalyticsPricingSource;
  readonly lastSyncedAt: string | null;
}

/**
 * The provenance a priced row recorded, PARSED rather than asserted, or `null` when it cannot state it.
 *
 * A CAST IS NOT A READ. These columns are bytes on disk that another process, a restore, or a
 * half-finished write could have left in any state, and `as AnalyticsPricingCurrency` is a claim the
 * compiler believes and the file never had to earn — a row holding `EUR`, or a unit nothing in this
 * build multiplies, would flow onward as a valid price and be totalled in front of an operator. The
 * protocol owns what each of these values may be, so the same schemas decide it here.
 *
 * A `model_catalog` row keeps the catalog id in the provider column (a catalog id, not a maker — the
 * column predates the third provenance, and a schema migration for one label was not worth it) and its
 * pricing page in the address column; it never synced, exactly as a manual row never did.
 *
 * A `provider_sync` row missing its provider or its address is likewise NOT a manual entry: it is a
 * row nobody can explain, and reading it as manual would quietly relabel where a price came from.
 * Every failure returns null, which is the path already taken for unreadable pricing evidence — the
 * row's cost is dropped and the next ingestion pass writes it again from the session's own documents.
 */
function pricingProvenanceFromRow(row: SessionRow): StoredPricingProvenance | null {
  // The manual branch is a strict shape in the shared contract. Do not discard stray feed columns
  // before parsing and thereby relabel contradictory stored bytes as a clean manual provenance.
  if (
    row.pricing_source_kind === 'manual' &&
    (row.pricing_source_provider !== null || row.pricing_source_url !== null)
  ) {
    return null;
  }
  const provider = AnalyticsPricingProviderSchema.safeParse(row.pricing_provider);
  const currency = AnalyticsPricingCurrencySchema.safeParse(row.pricing_currency);
  const source = AnalyticsPricingSourceSchema.safeParse(
    row.pricing_source_kind === 'provider_sync'
      ? { kind: 'provider_sync', provider: row.pricing_source_provider, sourceUrl: row.pricing_source_url }
      : row.pricing_source_kind === 'model_catalog'
        ? { kind: 'model_catalog', catalog: row.pricing_source_provider, sourceUrl: row.pricing_source_url }
        : { kind: row.pricing_source_kind },
  );
  // NARROWER THAN THE PROTOCOL'S OWN UNION, on purpose. `image` and `tool_call` are valid rate units
  // in the catalog, but a stored SNAPSHOT only ever holds slots this build multiplies by a token
  // count — so a row claiming one of the others is not an exotic price, it is a damaged row, and
  // accepting it would put amounts denominated per image into a per-million-token total.
  const rateUnit = ANALYTICS_STORED_RATE_UNIT_SCHEMA.safeParse(row.pricing_rate_unit);
  if (!provider.success || !currency.success || !rateUnit.success || !source.success) return null;

  // PROVENANCE AND ITS EVIDENCE AGREE, the same way the catalog schema demands of an authored entry:
  // a row claiming a provider feed with no instant naming when it synced reads as freshly pulled and
  // cannot be checked, and a manual entry carrying one names a sync that never happened. The instant
  // is PARSED too — "not null" is not the same as "a time anyone can read".
  const syncedAt = row.pricing_last_synced_at === null ? null : InstantSchema.safeParse(row.pricing_last_synced_at);
  if (syncedAt !== null && !syncedAt.success) return null;
  if (source.data.kind !== 'provider_sync' && syncedAt !== null) return null;
  if (source.data.kind === 'provider_sync' && (syncedAt === null || source.data.provider !== provider.data)) {
    return null;
  }
  return {
    provider: provider.data,
    currency: currency.data,
    rateUnit: rateUnit.data,
    source: source.data,
    lastSyncedAt: syncedAt === null ? null : syncedAt.data,
  };
}

/**
 * The pricing snapshot the row stored, or `null` when the session carried no usage at all.
 *
 * A row whose `pricing_kind` is absent means no pricing decision was ever taken, which happens only
 * when there was no token evidence to price. It is NOT read as "priced at zero" — the wire cost stays
 * null and the query surface reports the measure as unknown.
 */
function pricingFromRow(row: SessionRow): AnalyticsUsagePricingSnapshot | null {
  const identity =
    row.pricing_identity_raw === null || row.pricing_identity_model_id === null
      ? null
      : {
          raw: row.pricing_identity_raw,
          modelId: row.pricing_identity_model_id,
          variant: row.pricing_identity_variant,
          contextWindow: row.pricing_identity_context_window,
          revision: row.pricing_identity_revision,
        };
  if (row.pricing_kind === 'unpriced' && row.pricing_reason !== null) {
    return { kind: 'unpriced', identity, reason: row.pricing_reason as AnalyticsPricingUnknownReason };
  }
  const provenance = pricingProvenanceFromRow(row);
  if (
    row.pricing_kind !== 'priced' ||
    identity === null ||
    provenance === null ||
    row.pricing_key === null ||
    row.pricing_verified_at === null ||
    row.pricing_valid_from === null ||
    row.rate_input === null ||
    row.rate_cached_read === null ||
    row.rate_output === null ||
    row.equivalent_api_cost_usd_micros === null
  ) {
    return null;
  }
  return {
    kind: 'priced',
    identity,
    rate: {
      pricingKey: row.pricing_key,
      modelId: identity.modelId,
      provider: provenance.provider,
      // What the stored amounts are money IN and money PER, read back from the row rather than
      // reasserted by this build: a row written by an earlier boot states its own denomination.
      currency: provenance.currency,
      rateUnit: provenance.rateUnit,
      ratesUsdMicrosPerMillion: {
        input: row.rate_input,
        cachedRead: row.rate_cached_read,
        output: row.rate_output,
        ...(row.rate_cache_write === null ? {} : { cacheWrite: row.rate_cache_write }),
        ...(row.rate_cache_write_5m === null ? {} : { cacheWrite5m: row.rate_cache_write_5m }),
        ...(row.rate_cache_write_1h === null ? {} : { cacheWrite1h: row.rate_cache_write_1h }),
        ...(row.rate_reasoning === null ? {} : { reasoning: row.rate_reasoning }),
      },
      source: provenance.source,
      lastSyncedAt: provenance.lastSyncedAt,
      verifiedAt: row.pricing_verified_at,
      validFrom: row.pricing_valid_from,
      validThrough: row.pricing_valid_through,
    },
    equivalentApiCostUsdMicros: row.equivalent_api_cost_usd_micros,
  };
}

function storedFromRow(row: SessionRow): AnalyticsStoredSession {
  return {
    raw: {
      id: row.id,
      agent: row.agent,
      model: row.model,
      contextWindow: row.context_window,
      harness: row.harness,
      mode: row.mode,
      status: row.status,
      label: row.label,
      cwd: row.cwd,
      parent: row.parent,
      tree: row.tree,
      day: row.day,
      week: row.week,
      createdAt: row.created_at,
      pricingModel: row.pricing_model,
      equivalentApiCostUsdMicros: row.equivalent_api_cost_usd_micros,
      tokens: row.tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheWriteInputTokens: row.cache_write_input_tokens,
      cacheWrite5mInputTokens: row.cache_write_5m_input_tokens,
      cacheWrite1hInputTokens: row.cache_write_1h_input_tokens,
      reasoningTokens: row.reasoning_tokens,
      turns: row.turns,
      durationMs: row.duration_ms,
      activeDurationMs: row.active_duration_ms,
      machine: null,
      timeToFirstOutputMs: row.time_to_first_output_ms,
      contextEndPercent: row.context_end_percent,
      stalled: boolean(row.stalled),
      failed: boolean(row.failed),
      completed: boolean(row.completed),
    },
    finishedAt: row.finished_at,
    usageRefusal: row.usage_refusal as AnalyticsUsageRefusal | null,
    pricing: pricingFromRow(row),
    signature: row.signature,
    ingestedAt: row.ingested_at,
  };
}

/**
 * The store over one kernel SQLite handle (`state.sqlite(INSIGHTS_STATE)`).
 *
 * The handle is the kernel's: it owns the file, its mode, its journal and the cache rule (a file the kernel cannot
 * recognise is dropped and recreated before this sees it). What is checked here is the SHAPE — the version and the
 * column list — because a build that adds a column must rebuild the rows it cannot read.
 */
class SqliteAnalyticsStore implements AnalyticsIndexStore {
  constructor(private readonly database: SqliteHandle) {}

  ingested(): ReadonlyMap<string, AnalyticsIngestedMarker> {
    return new Map(
      this.database
        .query<{ id: string; signature: string; usage_refusal: string | null }>(
          'SELECT id, signature, usage_refusal FROM analytics_sessions',
        )
        .map(row => [row.id, { signature: row.signature, hasUsage: row.usage_refusal === null }]),
    );
  }

  /** One transaction for the whole batch: a partially written pass would report a fleet nobody ran. */
  upsert(rows: readonly AnalyticsStoredSession[]): void {
    applyAnalyticsWrites(this.database, { ...NO_ANALYTICS_WRITES, upserts: rows });
  }

  forget(ids: readonly string[]): void {
    applyAnalyticsWrites(this.database, { ...NO_ANALYTICS_WRITES, forgets: ids });
  }

  rows(): readonly AnalyticsStoredSession[] {
    return this.database
      .query<SessionRow>(
        `SELECT ${COLUMNS.join(', ')} FROM analytics_sessions
         ORDER BY COALESCE(created_at, finished_at) DESC, id ASC`,
      )
      .map(storedFromRow);
  }

  status(): AnalyticsStoreStatus {
    const counts = this.database.query<{
      sessions: number;
      token_sessions: number;
      refused: number;
      last_ingested_at: string | null;
    }>(
      `SELECT COUNT(*) AS sessions,
              COUNT(tokens) AS token_sessions,
              COUNT(usage_refusal) AS refused,
              MAX(ingested_at) AS last_ingested_at
         FROM analytics_sessions`,
    )[0];
    return {
      schemaVersion: ANALYTICS_INDEX_SCHEMA_VERSION,
      sessions: counts?.sessions ?? 0,
      tokenSessions: counts?.token_sessions ?? 0,
      refusedUsageSessions: counts?.refused ?? 0,
      lastIngestedAt: counts?.last_ingested_at ?? null,
    };
  }

  drop(): void {
    applyAnalyticsWrites(this.database, { ...NO_ANALYTICS_WRITES, drop: true });
  }
}

function tableNames(database: SqliteHandle): readonly string[] {
  return database
    .query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map(row => row.name);
}

function columnNames(database: SqliteHandle, table: string): readonly string[] {
  return database.query<{ name: string }>(`PRAGMA table_info(${table})`).map(row => row.name);
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function configure(database: SqliteHandle): void {
  database.run(`
      CREATE TABLE IF NOT EXISTS analytics_sessions (
        id TEXT PRIMARY KEY,
        agent TEXT,
        model TEXT,
        context_window INTEGER,
        harness TEXT,
        mode TEXT,
        status TEXT,
        label TEXT,
        cwd TEXT,
        parent TEXT,
        tree TEXT,
        day TEXT,
        week TEXT,
        created_at TEXT,
        finished_at TEXT NOT NULL,
        pricing_model TEXT,
        equivalent_api_cost_usd_micros INTEGER,
        tokens INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        cache_write_5m_input_tokens INTEGER,
        cache_write_1h_input_tokens INTEGER,
        reasoning_tokens INTEGER,
        turns INTEGER,
        duration_ms INTEGER,
        active_duration_ms INTEGER,
        time_to_first_output_ms INTEGER,
        context_end_percent REAL,
        stalled INTEGER NOT NULL CHECK (stalled IN (0, 1)),
        failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
        completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
        usage_refusal TEXT,
        pricing_kind TEXT,
        pricing_reason TEXT,
        pricing_identity_raw TEXT,
        pricing_identity_model_id TEXT,
        pricing_identity_variant TEXT,
        pricing_identity_context_window INTEGER,
        pricing_identity_revision TEXT,
        pricing_key TEXT,
        pricing_provider TEXT,
        -- What the stored rates are money IN and money PER. Recorded per row rather than assumed by
        -- the reader, so a row stays explicable after this build learns a second currency or unit.
        pricing_currency TEXT,
        pricing_rate_unit TEXT,
        -- Where the price came from: a person, or a named provider feed at a recorded address.
        pricing_source_kind TEXT,
        pricing_source_provider TEXT,
        pricing_source_url TEXT,
        pricing_last_synced_at TEXT,
        pricing_verified_at TEXT,
        pricing_valid_from TEXT,
        pricing_valid_through TEXT,
        rate_input INTEGER,
        rate_cached_read INTEGER,
        rate_cache_write INTEGER,
        rate_cache_write_5m INTEGER,
        rate_cache_write_1h INTEGER,
        rate_reasoning INTEGER,
        rate_output INTEGER,
        signature TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        -- A refused token total and a stored token count are mutually exclusive by SCHEMA, not by
        -- convention: the one thing this table must never hold is a session reported as having spent
        -- nothing when its evidence could not be read.
        CHECK ((usage_refusal IS NULL) OR (tokens IS NULL))
      )
  `);
  database.run(`
      CREATE INDEX IF NOT EXISTS analytics_sessions_recency_idx
        ON analytics_sessions(COALESCE(created_at, finished_at) DESC, id ASC)
  `);
}

/**
 * Opens the insights index on the kernel's handle: keeps it when its version and columns are this build's, otherwise
 * drops the tables and starts again. `rebuildRequired` says so, so the daemon owes a full pass rather than an
 * incremental one (a table that merely holds no finished ferret yet is not the same thing).
 */
export function openAnalyticsIndexStore(database: SqliteHandle): OpenedAnalyticsIndexStore {
  const hasTables = tableNames(database).length > 0;
  const decision = decideAnalyticsIndexSchema({
    foundVersion: database.query<{ user_version: number }>('PRAGMA user_version')[0]?.user_version ?? 0,
    hasTables,
    hasExpectedShape:
      sameNames(tableNames(database), EXPECTED_TABLES) &&
      sameNames(columnNames(database, 'analytics_sessions'), COLUMNS),
  });
  if (decision === 'drop-and-rebuild') {
    for (const table of tableNames(database)) database.run(`DROP TABLE IF EXISTS "${table.replaceAll('"', '""')}"`);
  }
  configure(database);
  database.run(`PRAGMA user_version = ${String(ANALYTICS_INDEX_SCHEMA_VERSION)}`);
  return { store: new SqliteAnalyticsStore(database), rebuildRequired: decision !== 'use' };
}
