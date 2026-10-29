/**
 * THE ANALYTICS TABLE'S SQL, shared by every connection that writes it: the copy in memory the daemon
 * answers from, the writer thread's connection to the file, and the main-thread fallback.
 *
 * Its own module, importing nothing at run time but `bun:sqlite` types and the write shapes, so the writer
 * thread (`analytics-writer-program.ts`) carries none of the store's schema parsing.
 */
import type { Database } from 'bun:sqlite';
import type { AnalyticsStoreWrites, AnalyticsStoredSession } from '../../lib/index.ts';

export const COLUMNS = [
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
  'active_duration_ms',
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
    raw.activeDurationMs,
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
    source?.kind === 'provider_sync' ? source.provider : source?.kind === 'model_catalog' ? source.catalog : null,
    source?.kind === 'provider_sync' || source?.kind === 'model_catalog' ? source.sourceUrl : null,
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

const UPSERT_SQL = `INSERT INTO analytics_sessions (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})
   ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter(column => column !== 'id')
     .map(column => `${column} = excluded.${column}`)
     .join(', ')}`;

/**
 * One batch of writes as ONE transaction: a partially written pass would report a fleet nobody ran, and a
 * batch the file half-took could not be applied again. Empties the table when asked, then forgets, then
 * writes — the order {@link AnalyticsStoreWrites} defines.
 */
export function applyAnalyticsWrites(database: Database, writes: AnalyticsStoreWrites): void {
  const forget = database.query('DELETE FROM analytics_sessions WHERE id = ?');
  const upsert = database.query(UPSERT_SQL);
  database.transaction(() => {
    if (writes.drop) database.exec('DELETE FROM analytics_sessions');
    for (const id of writes.forgets) forget.run(id);
    for (const row of writes.upserts) upsert.run(...values(row));
  })();
}

/** What every connection to the file sets for itself; the file's own journal mode is already WAL. */
export function configureAnalyticsConnection(database: Database): void {
  // The durable session documents are fsynced before a row is derived from them, so the disposable
  // materialization can safely use NORMAL: the worst a lost write costs is one re-ingestion.
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 5000');
}
