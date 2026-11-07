import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { SqliteHandle } from '@ferretry/kernel/contract';
import { openAnalyticsIndexStore } from '../../../daemon/adapters/analytics/sqlite-analytics-store.ts';
import {
  ANALYTICS_INDEX_SCHEMA_VERSION,
  type AnalyticsIndexStore,
  type AnalyticsStoredSession,
} from '../../../daemon/lib/analytics/store.ts';
import { refusedSession, storedSession } from '../../support/analytics-fixtures.ts';

/**
 * The analytics materialization, against a real SQLite file on disk.
 *
 * Nothing here is a stand-in: the factory, the schema, the confinement preflight and the queries are the
 * production ones, and every assertion is about bytes that survived being written and read back. That
 * matters because a store whose rows only round-trip in memory would satisfy every unit test and lose
 * the operator's price the first time the daemon restarted.
 */

const directories = new Set<string>();

interface Paths {
  readonly analyticsIndex: string;
}

async function temporaryPaths(): Promise<Paths> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-analytics-store-'));
  directories.add(home);
  return { analyticsIndex: join(home, 'analytics.sqlite') };
}

/** A kernel SQLite handle over a real file, the way the kernel hands one to the half. */
function handleOver(database: Database): SqliteHandle {
  return {
    query: <Row,>(sql: string, params: readonly unknown[] = []) => database.query(sql).all(...(params as never[])) as Row[],
    run: (sql, params = []) => ({ changes: database.query(sql).run(...(params as never[])).changes }),
    transaction: fn => database.transaction(fn)(),
    close: () => database.close(),
  };
}

const databases = new WeakMap<AnalyticsIndexStore, Database>();

const live = new Set<AnalyticsIndexStore>();

/** Closes a store once, so the teardown does not close it a second time and raise on a shut database. */
async function closeStore(store: AnalyticsIndexStore): Promise<void> {
  live.delete(store);
  databases.get(store)?.close();
}

async function open(paths: Paths): Promise<{ store: AnalyticsIndexStore; rebuildRequired: boolean }> {
  const database = new Database(paths.analyticsIndex, { create: true, strict: true });
  const result = openAnalyticsIndexStore(handleOver(database));
  databases.set(result.store, database);
  live.add(result.store);
  return result;
}

/** The same row priced from a provider feed rather than by hand, with a reasoning rate applied. */
function syncedSession(): AnalyticsStoredSession {
  const base = storedSession();
  if (base.pricing?.kind !== 'priced') throw new Error('expected a priced fixture');
  return {
    ...base,
    raw: { ...base.raw, reasoningTokens: 120 },
    pricing: {
      ...base.pricing,
      rate: {
        ...base.pricing.rate,
        ratesUsdMicrosPerMillion: { ...base.pricing.rate.ratesUsdMicrosPerMillion, reasoning: 30_000_000 },
        source: { kind: 'provider_sync', provider: 'anthropic', sourceUrl: 'https://prices.example/anthropic.json' },
        lastSyncedAt: '2026-08-01T12:00:00.000Z',
      },
    },
  };
}

afterEach(async () => {
  for (const store of [...live]) await closeStore(store);
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

describe('the analytics store on disk', () => {
  it('should round-trip a priced row, rate snapshot included', async () => {
    // The rate is the point of ingest-time pricing: the row has to state which numbers charged it, or a
    // later catalog edit makes every historical cost unexplainable.
    // Arrange
    const paths = await temporaryPaths();
    const first = await open(paths);
    first.store.upsert([storedSession()]);
    await closeStore(first.store);

    // Act — a SECOND open of the same file, as a restarted daemon would do.
    const second = await open(paths);

    // Assert
    should(second.rebuildRequired).be.false();
    should(second.store.rows()).deepEqual([storedSession()]);
  });

  it('should keep a refused token total as unknown rather than as a free session', async () => {
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);

    // Act
    store.upsert([refusedSession('s9')]);

    // Assert
    const [row] = store.rows();
    should(row?.usageRefusal).equal('transcript_unresolved');
    should(row?.raw.tokens).be.null();
    should(row?.raw.equivalentApiCostUsdMicros).be.null();
    should(row?.pricing).be.null();
    should(store.status()).deepEqual({
      schemaVersion: ANALYTICS_INDEX_SCHEMA_VERSION,
      sessions: 1,
      tokenSessions: 0,
      refusedUsageSessions: 1,
      lastIngestedAt: '2026-08-02T00:00:00.000Z',
    });
  });

  it('should round-trip an unpriced session with its stated reason, with or without a model identity', async () => {
    // "Unpriced" is a result an operator can act on, so the reason has to survive a restart rather than
    // collapse into a free session or a lost price.
    // Arrange
    const paths = await temporaryPaths();
    const first = await open(paths);
    const base = storedSession();
    const named: AnalyticsStoredSession = {
      ...base,
      raw: { ...base.raw, id: 'named', equivalentApiCostUsdMicros: null },
      pricing: {
        kind: 'unpriced',
        identity: {
          raw: 'claude-opus-5',
          modelId: 'claude-opus-5',
          variant: null,
          contextWindow: null,
          revision: null,
        },
        reason: 'unknown_pricing_model',
      },
      signature: 'signature-named',
    };
    const anonymous: AnalyticsStoredSession = {
      ...base,
      raw: { ...base.raw, id: 'anonymous', pricingModel: null, equivalentApiCostUsdMicros: null },
      pricing: { kind: 'unpriced', identity: null, reason: 'missing_pricing_model' },
      signature: 'signature-anonymous',
    };
    first.store.upsert([named, anonymous]);
    closeStore(first.store);

    // Act — a restarted daemon reads the file back.
    const second = await open(paths);

    // Assert
    const byId = new Map(second.store.rows().map(row => [row.raw.id, row.pricing]));
    should(byId.get('named')).deepEqual(named.pricing);
    should(byId.get('anonymous')).deepEqual(anonymous.pricing);
  });

  it('should refuse at the schema to hold a token count beside a refusal', async () => {
    // The one row this table must never contain is a session reported as having spent nothing when its
    // evidence could not be read. That is a CHECK constraint, not a convention the writer remembers.
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);
    const contradiction = { ...storedSession(), usageRefusal: 'transcript_unresolved' as const };

    // Act / Assert
    should(() => store.upsert([contradiction])).throw(/CHECK constraint failed/);
    should(store.rows()).be.empty();
  });

  it('should replace rather than duplicate when the same session is written twice', async () => {
    // A retry after a crash cannot double-count: the key is the session id and no column accumulates.
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);

    // Act
    store.upsert([storedSession()]);
    store.upsert([
      { ...storedSession(), raw: { ...storedSession().raw, tokens: 99, inputTokens: 99, outputTokens: 0 } },
    ]);

    // Assert
    should(store.rows()).have.length(1);
    should(store.rows()[0]?.raw.tokens).equal(99);
  });

  it('should roll back a whole batch when one row in it is impossible', async () => {
    // A partially written pass would report a fleet nobody ran.
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);

    // Act / Assert
    should(() =>
      store.upsert([storedSession(), { ...refusedSession('s2'), raw: { ...refusedSession('s2').raw, tokens: 5 } }]),
    ).throw();
    should(store.rows()).be.empty();
  });

  it('should report the signature and usage outcome of every ingested session', async () => {
    // This map is what lets a pass skip a transcript it has already proved without skipping one whose
    // fold was refused.
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);

    // Act
    store.upsert([storedSession(), refusedSession('s2')]);

    // Assert
    should([...store.ingested()]).deepEqual([
      ['s1', { signature: 'signature-1', hasUsage: true }],
      ['s2', { signature: 'signature-s2', hasUsage: false }],
    ]);
  });

  it('should forget a row on request and drop every row on a rebuild', async () => {
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);
    store.upsert([storedSession(), refusedSession('s2')]);

    // Act
    store.forget(['s2']);

    // Assert
    should(store.rows().map(row => row.raw.id)).deepEqual(['s1']);

    // Act — the disposable index thrown away in full.
    store.drop();

    // Assert
    should(store.rows()).be.empty();
    should(store.status().lastIngestedAt).be.null();
  });

  it('should return rows newest first so a raw answer needs no second sort', async () => {
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);

    // Act
    store.upsert([
      { ...storedSession(), raw: { ...storedSession().raw, id: 'older', createdAt: '2026-07-01T00:00:00.000Z' } },
      { ...storedSession(), raw: { ...storedSession().raw, id: 'newer', createdAt: '2026-08-01T00:00:00.000Z' } },
    ]);

    // Assert
    should(store.rows().map(row => row.raw.id)).deepEqual(['newer', 'older']);
  });

  it('should round-trip the reasoning measure and provider-sync provenance', async () => {
    // The row has to survive a restart carrying WHERE its price came from and WHAT its numbers are
    // denominated in, not just the amounts. A rate that round-trips without its provenance is a
    // number an operator cannot check against anything.
    // Arrange
    const paths = await temporaryPaths();
    const first = await open(paths);
    first.store.upsert([syncedSession()]);
    await closeStore(first.store);

    // Act — a SECOND open of the same file, as a restarted daemon would do.
    const second = await open(paths);

    // Assert
    should(second.store.rows()).deepEqual([syncedSession()]);
  });

  it('should drop a priced row whose stored provenance is not a fact the protocol allows', async () => {
    // A CAST IS NOT A READ. These columns are bytes another process, a restore or a half-finished
    // write could have left in any state, and a row claiming EUR, a unit nothing multiplies, or a
    // provider feed it cannot name is not a price — it is a number that would total up regardless.
    // Arrange
    const paths = await temporaryPaths();
    const corruptions = [
      { column: 'pricing_currency', value: 'EUR', synced: false },
      { column: 'pricing_rate_unit', value: 'per_word', synced: false },
      // A unit the CATALOG may legitimately use, but a stored snapshot never can: this table only
      // holds slots multiplied by a token count, so amounts denominated per image or per tool call
      // would be summed into a per-million-token total by everything downstream.
      { column: 'pricing_rate_unit', value: 'image', synced: false },
      { column: 'pricing_rate_unit', value: 'tool_call', synced: false },
      { column: 'pricing_provider', value: 'somebody-else', synced: false },
      { column: 'pricing_source_kind', value: 'guessed', synced: false },
      // A manual branch carries neither provider nor URL. Stray feed columns must not be silently
      // discarded while reconstructing it and thereby relabelled as clean manual provenance.
      { column: 'pricing_source_provider', value: 'openai', synced: false },
      { column: 'pricing_source_url', value: 'https://prices.example/openai.json', synced: false },
      // A manual entry carrying a sync instant names a sync that never happened.
      { column: 'pricing_last_synced_at', value: '2026-08-01T12:00:00.000Z', synced: false },
      // Provenance whose own evidence contradicts it: a feed with no address, a feed with no instant
      // saying when it ran, and a feed naming a different provider than the rate it priced.
      { column: 'pricing_source_url', value: null, synced: true },
      { column: 'pricing_last_synced_at', value: null, synced: true },
      { column: 'pricing_source_provider', value: 'openai', synced: true },
      // "Not null" is not "a time anyone can read": a sync instant nobody can parse cannot support
      // the freshness claim an operator would read off it.
      { column: 'pricing_last_synced_at', value: 'last thursday', synced: true },
    ] as const;

    for (const { column, value, synced } of corruptions) {
      const { store } = await open(paths);
      store.upsert([synced ? syncedSession() : storedSession()]);
      await closeStore(store);
      const database = new Database(paths.analyticsIndex, { strict: true });
      database.query(`UPDATE analytics_sessions SET ${column} = ?`).run(value);
      database.close();

      // Act
      const reopened = await open(paths);

      // Assert — the row survives, its unexplainable price does not.
      const [row] = reopened.store.rows();
      should(row?.raw.id).equal('s1');
      should(row?.pricing).be.null();
      reopened.store.drop();
      await closeStore(reopened.store);
    }
  });

  it('should discard an index whose rows predate the columns this build writes', async () => {
    // The real upgrade path for a disposable index: no migration is written for it, the file is
    // thrown away and one re-ingestion pass reproduces every row from the durable session documents.
    // Arrange
    const paths = await temporaryPaths();
    const first = await open(paths);
    first.store.upsert([storedSession()]);
    await closeStore(first.store);
    const database = new Database(paths.analyticsIndex, { strict: true });
    database.exec('ALTER TABLE analytics_sessions DROP COLUMN reasoning_tokens');
    database.close();

    // Act
    const second = await open(paths);

    // Assert
    should(second.rebuildRequired).be.true();
    should(second.store.rows()).be.empty();
  });

  it('should discard an index written under another schema version', async () => {
    // Arrange
    const paths = await temporaryPaths();
    const first = await open(paths);
    first.store.upsert([storedSession()]);
    await closeStore(first.store);
    const database = new Database(paths.analyticsIndex, { strict: true });
    database.exec(`PRAGMA user_version = ${ANALYTICS_INDEX_SCHEMA_VERSION + 1}`);
    database.close();

    // Act
    const second = await open(paths);

    // Assert
    should(second.rebuildRequired).be.true();
    should(second.store.rows()).be.empty();
  });
});
