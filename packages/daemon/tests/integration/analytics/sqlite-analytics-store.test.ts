import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunSqliteAnalyticsStoreFactory } from '../../../src/adapters/analytics/index.ts';
import { StateFileSystem } from '../../../src/adapters/index.ts';
import {
  ANALYTICS_INDEX_SCHEMA_VERSION,
  analyticsIndexFiles,
  createFoundationPaths,
  resolveStateHome,
  type AnalyticsIndexStore,
  type AnalyticsStoredSession,
  type FoundationPaths,
} from '../../../src/lib/index.ts';

/**
 * The analytics materialization, against a real SQLite file on disk.
 *
 * Nothing here is a stand-in: the factory, the schema, the confinement preflight and the queries are the
 * production ones, and every assertion is about bytes that survived being written and read back. That
 * matters because a store whose rows only round-trip in memory would satisfy every unit test and lose
 * the operator's price the first time the daemon restarted.
 */

const directories = new Set<string>();

async function temporaryPaths(): Promise<FoundationPaths> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-analytics-store-'));
  directories.add(home);
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

const live = new Set<AnalyticsIndexStore>();

/** Closes a store once, so the teardown does not close it a second time and raise on a shut database. */
function closeStore(store: AnalyticsIndexStore): void {
  live.delete(store);
  store.close();
}

async function open(paths: FoundationPaths): Promise<{ store: AnalyticsIndexStore; rebuildRequired: boolean }> {
  const result = await new BunSqliteAnalyticsStoreFactory().open(paths, new StateFileSystem(paths));
  live.add(result.store);
  return result;
}

function storedSession(overrides: Partial<AnalyticsStoredSession> = {}): AnalyticsStoredSession {
  return {
    raw: {
      id: 's1',
      agent: 'claude',
      model: 'claude-opus-5',
      contextWindow: 1_000_000,
      harness: 'claude',
      mode: 'auto',
      status: 'completed',
      label: 'batch',
      cwd: '/work',
      parent: null,
      tree: null,
      day: '2026-08-01',
      week: '2026-07-27',
      createdAt: '2026-08-01T00:00:00.000Z',
      pricingModel: 'claude-opus-5',
      equivalentApiCostUsdMicros: 52_500,
      tokens: 1_500,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      reasoningTokens: null,
      turns: 3,
      durationMs: 3_600_000,
      timeToFirstOutputMs: null,
      contextEndPercent: 40,
      stalled: false,
      failed: false,
      migrated: false,
      completed: true,
      ...overrides.raw,
    },
    finishedAt: '2026-08-01T01:00:00.000Z',
    usageRefusal: null,
    pricing: {
      kind: 'priced',
      identity: {
        raw: 'claude-opus-5',
        modelId: 'claude-opus-5',
        variant: null,
        contextWindow: null,
        revision: null,
      },
      rate: {
        pricingKey: 'operator:claude-opus-5:2026-08',
        modelId: 'claude-opus-5',
        provider: 'anthropic',
        currency: 'USD',
        rateUnit: 'million_tokens',
        ratesUsdMicrosPerMillion: {
          input: 15_000_000,
          cachedRead: 1_500_000,
          cacheWrite5m: 18_750_000,
          cacheWrite1h: 30_000_000,
          output: 75_000_000,
        },
        source: { kind: 'manual' },
        lastSyncedAt: null,
        verifiedAt: '2026-08-01T00:00:00.000Z',
        validFrom: '2026-08-01T00:00:00.000Z',
        validThrough: null,
      },
      equivalentApiCostUsdMicros: 52_500,
    },
    signature: 'signature-1',
    ingestedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
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

/** A session whose transcript this daemon could not read: no tokens, no cost, and a stored reason. */
function refusedSession(id: string): AnalyticsStoredSession {
  const base = storedSession();
  return {
    ...base,
    raw: {
      ...base.raw,
      id,
      tokens: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      cacheWrite5mInputTokens: null,
      cacheWrite1hInputTokens: null,
      reasoningTokens: null,
      equivalentApiCostUsdMicros: null,
      pricingModel: null,
    },
    usageRefusal: 'transcript_unresolved',
    pricing: null,
    signature: `signature-${id}`,
  };
}

afterEach(async () => {
  for (const store of [...live]) closeStore(store);
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
    closeStore(first.store);

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

  it('should refuse at the schema to hold a token count beside a refusal', async () => {
    // The one row this table must never contain is a session reported as having spent nothing when its
    // evidence could not be read. That is a CHECK constraint, not a convention the writer remembers.
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);
    const contradiction = { ...storedSession(), usageRefusal: 'transcript_damaged' as const };

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
    closeStore(first.store);

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
      closeStore(store);
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
      closeStore(reopened.store);
    }
  });

  it('should discard an index whose rows predate the columns this build writes', async () => {
    // The real upgrade path for a disposable index: no migration is written for it, the file is
    // thrown away and one re-ingestion pass reproduces every row from the durable session documents.
    // Arrange
    const paths = await temporaryPaths();
    const first = await open(paths);
    first.store.upsert([storedSession()]);
    closeStore(first.store);
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
    closeStore(first.store);
    const database = new Database(paths.analyticsIndex, { strict: true });
    database.exec(`PRAGMA user_version = ${ANALYTICS_INDEX_SCHEMA_VERSION + 1}`);
    database.close();

    // Act
    const second = await open(paths);

    // Assert
    should(second.rebuildRequired).be.true();
    should(second.store.rows()).be.empty();
  });

  it('should discard an index that names another state home rather than serving its rows', async () => {
    // ONE DAEMON'S ANALYTICS MUST NEVER BE READ AS ANOTHER'S. A copied or restored file opens perfectly
    // well, and every row in it would then be reported as this daemon's fleet.
    // Arrange
    const paths = await temporaryPaths();
    const first = await open(paths);
    first.store.upsert([storedSession()]);
    closeStore(first.store);
    const database = new Database(paths.analyticsIndex, { strict: true });
    database.query('UPDATE analytics_meta SET home = ?').run('/somewhere/else');
    database.close();

    // Act
    const second = await open(paths);

    // Assert
    should(second.rebuildRequired).be.true();
    should(second.store.rows()).be.empty();
  });

  it('should discard a foreign database at the index path without reading it', async () => {
    // A valid SQLite file the daemon does not own: whatever it holds is not this daemon's fleet.
    // Arrange
    const paths = await temporaryPaths();
    closeStore((await open(paths)).store);
    const database = new Database(paths.analyticsIndex, { strict: true });
    database.exec('DROP TABLE analytics_sessions');
    database.exec('CREATE TABLE somebody_elses_rows (value TEXT NOT NULL)');
    database.close();

    // Act
    const opened = await open(paths);

    // Assert
    should(opened.rebuildRequired).be.true();
    should(opened.store.rows()).be.empty();
  });

  it('should refuse a symlinked index file rather than following it out of the state home', async () => {
    // SQLite opens the database and its sidecars itself, outside the port, so all three are walked first.
    // Arrange
    const paths = await temporaryPaths();
    const outside = await mkdtemp(join(tmpdir(), 'ferretry-analytics-elsewhere-'));
    directories.add(outside);
    await new StateFileSystem(paths).ensureDirectory(paths.index, 0o700);
    await symlink(join(outside, 'planted.sqlite'), paths.analyticsIndex);

    // Act / Assert
    await new BunSqliteAnalyticsStoreFactory().open(paths, new StateFileSystem(paths)).should.be.rejected();
  });

  it('should leave the index and its sidecars readable only by the owner', async () => {
    // Arrange
    const paths = await temporaryPaths();
    const { store } = await open(paths);

    // Act
    store.upsert([storedSession()]);

    // Assert
    for (const file of analyticsIndexFiles(paths)) {
      const information = await stat(file).catch(() => undefined);
      if (information !== undefined) should(information.mode & 0o777).equal(0o600);
    }
  });
});
