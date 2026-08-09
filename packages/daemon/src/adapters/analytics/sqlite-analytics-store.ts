import { Database } from 'bun:sqlite';
import {
  AnalyticsPricingCurrencySchema,
  AnalyticsPricingProviderSchema,
  AnalyticsPricingSourceSchema,
  InstantSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import {
  ANALYTICS_INDEX_SCHEMA_VERSION,
  type AnalyticsIndexStore,
  type AnalyticsIndexStoreFactory,
  type AnalyticsIngestedMarker,
  type AnalyticsPricingCurrency,
  type AnalyticsPricingProvider,
  type AnalyticsPricingRateUnit,
  type AnalyticsPricingSource,
  type AnalyticsPricingUnknownReason,
  type AnalyticsStoredSession,
  type AnalyticsStoreStatus,
  type AnalyticsUsagePricingSnapshot,
  type AnalyticsUsageRefusal,
  analyticsIndexFiles,
  decideAnalyticsIndexSchema,
  type FileSystemPort,
  type FoundationPaths,
  type OpenedAnalyticsIndexStore,
} from '../../lib/index.ts';

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
  readonly time_to_first_output_ms: number | null;
  readonly context_end_percent: number | null;
  readonly stalled: number;
  readonly failed: number;
  readonly migrated: number;
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

const COLUMNS = [
  'id',
  'agent',
  'model',
  'context_window',
  'harness',
  'mode',
  'status',
  'label',
  'cwd',
  'parent',
  'tree',
  'day',
  'week',
  'created_at',
  'finished_at',
  'pricing_model',
  'equivalent_api_cost_usd_micros',
  'tokens',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'cache_write_5m_input_tokens',
  'cache_write_1h_input_tokens',
  'reasoning_tokens',
  'turns',
  'duration_ms',
  'time_to_first_output_ms',
  'context_end_percent',
  'stalled',
  'failed',
  'migrated',
  'completed',
  'usage_refusal',
  'pricing_kind',
  'pricing_reason',
  'pricing_identity_raw',
  'pricing_identity_model_id',
  'pricing_identity_variant',
  'pricing_identity_context_window',
  'pricing_identity_revision',
  'pricing_key',
  'pricing_provider',
  'pricing_currency',
  'pricing_rate_unit',
  'pricing_source_kind',
  'pricing_source_provider',
  'pricing_source_url',
  'pricing_last_synced_at',
  'pricing_verified_at',
  'pricing_valid_from',
  'pricing_valid_through',
  'rate_input',
  'rate_cached_read',
  'rate_cache_write',
  'rate_cache_write_5m',
  'rate_cache_write_1h',
  'rate_reasoning',
  'rate_output',
  'signature',
  'ingested_at',
] as const;

const EXPECTED_TABLES = ['analytics_meta', 'analytics_sessions'] as const;
const EXPECTED_META_COLUMNS = ['id', 'home'] as const;

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
  if (source.data.kind === 'manual' && syncedAt !== null) return null;
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
      timeToFirstOutputMs: row.time_to_first_output_ms,
      contextEndPercent: row.context_end_percent,
      stalled: boolean(row.stalled),
      failed: boolean(row.failed),
      migrated: boolean(row.migrated),
      completed: boolean(row.completed),
    },
    finishedAt: row.finished_at,
    usageRefusal: row.usage_refusal as AnalyticsUsageRefusal | null,
    pricing: pricingFromRow(row),
    signature: row.signature,
    ingestedAt: row.ingested_at,
  };
}

function values(session: AnalyticsStoredSession): readonly (string | number | null)[] {
  const { raw, pricing } = session;
  const priced = pricing?.kind === 'priced' ? pricing : null;
  const rates = priced?.rate.ratesUsdMicrosPerMillion;
  const source = priced?.rate.source;
  return [
    raw.id,
    raw.agent,
    raw.model,
    raw.contextWindow,
    raw.harness,
    raw.mode,
    raw.status,
    raw.label,
    raw.cwd,
    raw.parent,
    raw.tree ?? null,
    raw.day,
    raw.week,
    raw.createdAt,
    session.finishedAt,
    raw.pricingModel,
    raw.equivalentApiCostUsdMicros,
    raw.tokens,
    raw.inputTokens,
    raw.outputTokens,
    raw.cachedInputTokens,
    raw.cacheWriteInputTokens,
    raw.cacheWrite5mInputTokens,
    raw.cacheWrite1hInputTokens,
    raw.reasoningTokens ?? null,
    raw.turns,
    raw.durationMs,
    raw.timeToFirstOutputMs,
    raw.contextEndPercent,
    Number(raw.stalled),
    Number(raw.failed),
    Number(raw.migrated),
    Number(raw.completed),
    session.usageRefusal,
    pricing?.kind ?? null,
    pricing?.kind === 'unpriced' ? pricing.reason : null,
    pricing?.identity?.raw ?? null,
    pricing?.identity?.modelId ?? null,
    pricing?.identity?.variant ?? null,
    pricing?.identity?.contextWindow ?? null,
    pricing?.identity?.revision ?? null,
    priced?.rate.pricingKey ?? null,
    priced?.rate.provider ?? null,
    priced?.rate.currency ?? null,
    priced?.rate.rateUnit ?? null,
    source?.kind ?? null,
    source?.kind === 'provider_sync' ? source.provider : null,
    source?.kind === 'provider_sync' ? source.sourceUrl : null,
    priced?.rate.lastSyncedAt ?? null,
    priced?.rate.verifiedAt ?? null,
    priced?.rate.validFrom ?? null,
    priced?.rate.validThrough ?? null,
    rates?.input ?? null,
    rates?.cachedRead ?? null,
    rates?.cacheWrite ?? null,
    rates?.cacheWrite5m ?? null,
    rates?.cacheWrite1h ?? null,
    rates?.reasoning ?? null,
    rates?.output ?? null,
    session.signature,
    session.ingestedAt,
  ];
}

/**
 * Not exported: the factory is the only way in, because opening this file has PREFLIGHT rules — every
 * path walked through the confined port, a foreign index discarded, modes set — and a caller holding a
 * raw `Database` could skip every one of them.
 */
class BunSqliteAnalyticsStore implements AnalyticsIndexStore {
  constructor(private readonly database: Database) {}

  ingested(): ReadonlyMap<string, AnalyticsIngestedMarker> {
    return new Map(
      this.database
        .query<{ id: string; signature: string; usage_refusal: string | null }, []>(
          'SELECT id, signature, usage_refusal FROM analytics_sessions',
        )
        .all()
        .map(row => [row.id, { signature: row.signature, hasUsage: row.usage_refusal === null }]),
    );
  }

  /** One transaction for the whole batch: a partially written pass would report a fleet nobody ran. */
  upsert(rows: readonly AnalyticsStoredSession[]): void {
    const placeholders = COLUMNS.map(() => '?').join(', ');
    const updates = COLUMNS.filter(column => column !== 'id')
      .map(column => `${column} = excluded.${column}`)
      .join(', ');
    const statement = this.database.query(
      `INSERT INTO analytics_sessions (${COLUMNS.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates}`,
    );
    this.database.transaction(() => {
      for (const row of rows) statement.run(...values(row));
    })();
  }

  forget(ids: readonly string[]): void {
    const statement = this.database.query('DELETE FROM analytics_sessions WHERE id = ?');
    this.database.transaction(() => {
      for (const id of ids) statement.run(id);
    })();
  }

  rows(): readonly AnalyticsStoredSession[] {
    return this.database
      .query<SessionRow, []>(
        `SELECT ${COLUMNS.join(', ')} FROM analytics_sessions
         ORDER BY COALESCE(created_at, finished_at) DESC, id ASC`,
      )
      .all()
      .map(storedFromRow);
  }

  status(): AnalyticsStoreStatus {
    const counts = this.database
      .query<{ sessions: number; token_sessions: number; refused: number; last_ingested_at: string | null }, []>(
        `SELECT COUNT(*) AS sessions,
                COUNT(tokens) AS token_sessions,
                COUNT(usage_refusal) AS refused,
                MAX(ingested_at) AS last_ingested_at
           FROM analytics_sessions`,
      )
      .get();
    return {
      schemaVersion: ANALYTICS_INDEX_SCHEMA_VERSION,
      sessions: counts?.sessions ?? 0,
      tokenSessions: counts?.token_sessions ?? 0,
      refusedUsageSessions: counts?.refused ?? 0,
      lastIngestedAt: counts?.last_ingested_at ?? null,
    };
  }

  drop(): void {
    this.database.exec('DELETE FROM analytics_sessions');
  }

  close(): void {
    try {
      this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.database.close();
    }
  }
}

function tableNames(database: Database): readonly string[] {
  return database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(row => row.name);
}

function columnNames(database: Database, table: string): readonly string[] {
  return database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map(row => row.name);
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

/**
 * The home the file says it belongs to, or `null` when it cannot say.
 *
 * Reading it is wrapped because the query runs against a file whose shape has not been established
 * yet: a database with a completely different `analytics_meta` would raise rather than answer, and
 * that is a file to discard, not an error to take the daemon down with.
 */
function storedHome(database: Database, hasTables: boolean): string | null {
  if (!hasTables) return null;
  try {
    return database.query<{ home: string }, []>('SELECT home FROM analytics_meta WHERE id = 1').get()?.home ?? null;
  } catch {
    return null;
  }
}

function configure(database: Database, home: string): void {
  database.exec('PRAGMA journal_mode = WAL');
  // The durable session documents are fsynced before a row is derived from them, so the disposable
  // materialization can safely use NORMAL: the worst a lost write costs is one re-ingestion.
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS analytics_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      home TEXT NOT NULL
    );
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
      time_to_first_output_ms INTEGER,
      context_end_percent REAL,
      stalled INTEGER NOT NULL CHECK (stalled IN (0, 1)),
      failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
      migrated INTEGER NOT NULL CHECK (migrated IN (0, 1)),
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
    );
    CREATE INDEX IF NOT EXISTS analytics_sessions_recency_idx
      ON analytics_sessions(COALESCE(created_at, finished_at) DESC, id ASC);
    PRAGMA user_version = ${ANALYTICS_INDEX_SCHEMA_VERSION};
  `);
  database
    .query('INSERT INTO analytics_meta (id, home) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET home = ?')
    .run(home, home);
}

/**
 * SQLite opens the database and its `-wal`/`-shm` sidecars itself, outside the port, so each of those
 * paths is walked by the port first. `information` throws on a symbolic link — including the final
 * component — or on a path outside the state home, which is the refusal this preflight is for.
 */
async function openDatabase(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<Database> {
  for (const file of analyticsIndexFiles(paths)) await fileSystem.information(file);
  return new Database(paths.analyticsIndex, { create: true, strict: true });
}

export class BunSqliteAnalyticsStoreFactory implements AnalyticsIndexStoreFactory {
  async open(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<OpenedAnalyticsIndexStore> {
    await fileSystem.ensureDirectory(paths.index, 0o700);
    let database: Database | undefined;
    try {
      database = await openDatabase(paths, fileSystem);
      const hasTables = tableNames(database).length > 0;
      const decision = decideAnalyticsIndexSchema(
        {
          foundVersion: database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0,
          hasTables,
          hasExpectedShape:
            sameNames(tableNames(database), EXPECTED_TABLES) &&
            sameNames(columnNames(database, 'analytics_meta'), EXPECTED_META_COLUMNS) &&
            sameNames(columnNames(database, 'analytics_sessions'), COLUMNS),
          storedHome: storedHome(database, hasTables),
        },
        paths.home,
      );
      if (decision === 'drop-and-rebuild') {
        const obsolete = database;
        database = undefined;
        obsolete.close();
        for (const file of analyticsIndexFiles(paths)) await fileSystem.removeFile(file);
        database = await openDatabase(paths, fileSystem);
      }
      configure(database, paths.home);
      for (const file of analyticsIndexFiles(paths)) {
        if ((await fileSystem.information(file)) !== undefined) await fileSystem.setMode(file, 0o600);
      }
      return { store: new BunSqliteAnalyticsStore(database), rebuildRequired: decision !== 'use' };
    } catch (error) {
      database?.close();
      throw error;
    }
  }
}
