import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { TurnUsage } from '@ferretry/core-ferrets/contract';
import type { SqliteHandle } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';
import { openAnalyticsIndexStore } from '../../../daemon/adapters/analytics/sqlite-analytics-store.ts';
import { AnalyticsIngestionService, type AnalyticsIngestCandidate } from '../../../daemon/lib/analytics/ingestion.ts';
import type { AnalyticsPricingRate } from '../../../daemon/lib/analytics/pricing.ts';
import { foldAnalyticsTurns, type TurnEvidence } from '../../../daemon/lib/analytics/turn-fold.ts';

/**
 * W-09 upgrade: the `purpose` column is ADDITIVE. An analytics index written before it existed keeps every
 * row — tokens, price snapshot — and reads them as Unlabelled, even when no transcript can be folded again.
 */

const RATES: readonly AnalyticsPricingRate[] = [
  {
    pricingKey: 'operator:claude-opus-5:2026-08',
    modelId: 'claude-opus-5',
    aliases: [],
    provider: 'anthropic',
    currency: 'USD',
    rates: {
      input: 15_000_000,
      output: 75_000_000,
      cachedInput: 1_500_000,
      cacheWrite: null,
      cacheWrite5m: 18_750_000,
      cacheWrite1h: 30_000_000,
      reasoning: null,
      image: null,
      tool: null,
    },
    source: { kind: 'manual' },
    verifiedAt: '2026-08-01T00:00:00.000Z',
    validFrom: '2026-08-01T00:00:00.000Z',
    validThrough: null,
    lastSyncedAt: null,
  },
];

const CANDIDATE: AnalyticsIngestCandidate = {
  id: 'before-the-field',
  agent: 'claude',
  selectedModel: 'claude-opus-5[1m]',
  contextWindow: null,
  harness: 'claude',
  mode: 'auto',
  label: null,
  cwd: '/work',
  parent: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  startedAt: '2026-08-01T00:00:00.000Z',
  finishedAt: '2026-08-01T01:00:00.000Z',
  status: 'completed',
  firstOutputAt: null,
  turns: 1,
  contextEndPercent: 40,
};

// 1,000 input + 500 output tokens of claude-opus-5: 1,000 x 15 + 500 x 75 = 52,500 USD micros.
const SPEND: readonly TurnUsage[] = [
  {
    turn: 1,
    at: instantFromEpochMs(Date.parse('2026-08-01T00:30:00.000Z')),
    model: 'claude-opus-5',
    inputTokens: 1_000,
    outputTokens: 500,
  },
];

const directories = new Set<string>();
const databases = new Set<Database>();

function handleOver(database: Database): SqliteHandle {
  return {
    query: <Row>(sql: string, params: readonly unknown[] = []) =>
      database.query(sql).all(...(params as never[])) as Row[],
    run: (sql, params = []) => ({ changes: database.query(sql).run(...(params as never[])).changes }),
    transaction: fn => database.transaction(fn)(),
    close: () => database.close(),
  };
}

function openDatabase(file: string): Database {
  const database = new Database(file, { create: true, strict: true });
  databases.add(database);
  return database;
}

function ingestionOver(database: Database, evidence: TurnEvidence) {
  const opened = openAnalyticsIndexStore(handleOver(database));
  const service = new AnalyticsIngestionService({
    candidates: { listCandidates: async () => [CANDIDATE] },
    folds: { foldFor: async (_id, aliasGroups) => foldAnalyticsTurns(evidence, aliasGroups) },
    store: opened.store,
    pricing: async () => RATES,
    clock: { now: () => '2026-08-02T00:00:00.000Z' },
    concurrency: 1,
    rebuildRequired: opened.rebuildRequired,
  });
  return { ...opened, service };
}

afterEach(async () => {
  for (const database of databases) database.close();
  databases.clear();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

describe('the analytics index written before the purpose column existed', () => {
  it('should keep its tokens and price as Unlabelled when the transcript can no longer be folded', async () => {
    // Arrange — an index of the previous build: ingested while the transcript was readable, `purpose` absent.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-analytics-purpose-'));
    directories.add(home);
    const file = join(home, 'analytics.sqlite');
    const seeding = openDatabase(file);
    const first = ingestionOver(seeding, SPEND);
    await first.service.ingest();
    should(first.store.rows()[0]?.raw.tokens).equal(1_500);
    seeding.exec('ALTER TABLE analytics_sessions DROP COLUMN purpose');
    seeding.close();

    // Act — the new build opens it with the historical harness gone, so a re-fold can only refuse.
    const upgraded = ingestionOver(openDatabase(file), undefined);
    const summary = await upgraded.service.ingest();

    // Assert
    should(upgraded.rebuildRequired).be.false();
    should(summary.ingested).equal(0);
    const [row] = upgraded.store.rows();
    should(row?.raw.tokens).equal(1_500);
    should(row?.raw.equivalentApiCostUsdMicros).equal(52_500);
    should(row?.raw.purpose).be.null();
    should(row?.usageRefusal).be.null();
  });
});
