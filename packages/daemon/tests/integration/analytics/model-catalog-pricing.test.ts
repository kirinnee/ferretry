import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtInModelCatalogs, type ModelCatalog } from '@ferretry/fleet';
import should from 'should';
import { BunSqliteAnalyticsStoreFactory } from '../../../src/adapters/analytics/index.ts';
import { StateFileSystem } from '../../../src/adapters/index.ts';
import { type AnalyticsIngestCandidate, AnalyticsIngestionService } from '../../../src/lib/analytics/ingestion.ts';
import type { AnalyticsTranscriptEvidence } from '../../../src/lib/analytics/usage-fold.ts';
import {
  type AnalyticsIndexStore,
  createFoundationPaths,
  effectiveAnalyticsPricing,
  type FoundationPaths,
  resolveStateHome,
} from '../../../src/lib/index.ts';

/**
 * A session priced from the model catalog, end to end: the production fold, the catalog-derived
 * pricing, a real SQLite index on disk, and the WIRE row the analytics read serves — because a stored
 * snapshot nobody reads back proves nothing about the number Insights shows.
 */

const directories = new Set<string>();
const live = new Set<AnalyticsIndexStore>();

async function temporaryPaths(): Promise<FoundationPaths> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-catalog-pricing-'));
  directories.add(home);
  return createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/home-must-not-be-used' }));
}

async function open(paths: FoundationPaths): Promise<AnalyticsIndexStore> {
  const { store } = await new BunSqliteAnalyticsStoreFactory().open(paths, new StateFileSystem(paths));
  live.add(store);
  return store;
}

async function close(store: AnalyticsIndexStore): Promise<void> {
  live.delete(store);
  await store.close();
}

const candidate = (id: string, selectedModel: string): AnalyticsIngestCandidate => ({
  id,
  transcriptHarness: 'claude',
  agent: 'claude',
  selectedModel,
  contextWindow: null,
  harness: 'claude',
  mode: 'auto',
  label: null,
  cwd: '/work',
  parent: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  startedAt: '2025-01-01T00:00:00.000Z',
  finishedAt: '2025-01-01T01:00:00.000Z',
  status: 'completed',
  firstOutputAt: null,
  turns: 1,
  contextEndPercent: 10,
  migrated: false,
});

/** One assistant reply on `model`: 1,000 tokens in, 500 out, nothing cached. */
const evidence = (model: string): AnalyticsTranscriptEvidence => ({
  kind: 'read',
  harness: 'claude',
  events: [
    {
      kind: 'usage',
      harness: 'claude',
      role: 'assistant',
      timestamp: '2025-01-01T00:30:00.000Z',
      usage: { model, inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  ],
  issues: [],
  pendingBytes: 0,
});

function ingestion(
  store: AnalyticsIndexStore,
  sessions: readonly { readonly id: string; readonly model: string }[],
  catalogs: () => Readonly<Record<string, ModelCatalog>>,
): AnalyticsIngestionService {
  const models = new Map(sessions.map(session => [session.id, session.model]));
  let tick = 0;
  return new AnalyticsIngestionService({
    candidates: { listCandidates: async () => sessions.map(session => candidate(session.id, `${session.model}[1m]`)) },
    evidence: { evidenceFor: async id => evidence(models.get(id) as string) },
    store,
    pricing: async () => effectiveAnalyticsPricing([], catalogs()),
    clock: {
      now: () => {
        tick += 1;
        return `2026-10-20T00:00:${String(tick).padStart(2, '0')}.000Z`;
      },
    },
    concurrency: 2,
    rebuildRequired: false,
  });
}

afterEach(async () => {
  for (const store of [...live]) await close(store);
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

describe('a session priced from the model catalog', () => {
  it('should serve its catalog cost on the wire after a restart, and not re-ingest it while nothing changed', async () => {
    // Arrange
    const paths = await temporaryPaths();
    const sessions = [
      { id: 'opus', model: 'claude-opus-5-5' },
      { id: 'astra', model: 'gpt-6-astra' },
    ];
    const first = await open(paths);
    const firstPass = await ingestion(first, sessions, builtInModelCatalogs).ingest();
    await close(first);

    // Act — a restarted daemon, the same file.
    const reopened = await open(paths);
    const service = ingestion(reopened, sessions, builtInModelCatalogs);
    const secondPass = await service.ingest();
    const wire = new Map(service.read().rows.map(row => [row.id, row]));

    // Assert: 1,000 × $4 + 500 × $20 per million for Opus 5.5; 1,000 × $10 + 500 × $50 for GPT-6 Astra.
    should(firstPass.ingested).equal(2);
    should(secondPass).match({ ingested: 0, unchanged: 2 });
    should(wire.get('opus')?.equivalentApiCostUsdMicros).equal(14_000);
    should(wire.get('astra')?.equivalentApiCostUsdMicros).equal(35_000);
    should(reopened.rows().find(row => row.raw.id === 'opus')?.pricing).match({
      kind: 'priced',
      rate: {
        source: {
          kind: 'model_catalog',
          catalog: 'anthropic',
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
        },
        lastSyncedAt: null,
      },
    });
  });

  it('should re-price a stored session on the next pass when a published price moves', async () => {
    // Arrange
    const paths = await temporaryPaths();
    const store = await open(paths);
    let catalogs = builtInModelCatalogs();
    const service = ingestion(store, [{ id: 'opus', model: 'claude-opus-5-5' }], () => catalogs);
    await service.ingest();
    const anthropic = catalogs.anthropic as ModelCatalog;
    const half = anthropic.claude as NonNullable<ModelCatalog['claude']>;
    catalogs = {
      ...catalogs,
      anthropic: {
        ...anthropic,
        claude: {
          ...half,
          models: half.models.map(model =>
            model.id === 'claude-opus-5-5' && model.price !== undefined
              ? { ...model, price: { ...model.price, output: 10 } }
              : model,
          ),
        },
      },
    };

    // Act
    const pass = await service.ingest();

    // Assert: 1,000 × $4 + 500 × $10.
    should(pass.ingested).equal(1);
    should(service.read().rows[0]?.equivalentApiCostUsdMicros).equal(9_000);
  });

  it('should drop a stored catalog provenance that names no catalog or claims a sync', async () => {
    // Arrange
    const paths = await temporaryPaths();
    for (const [column, value] of [
      ['pricing_source_provider', null],
      ['pricing_source_url', 'http://plaintext.example/prices'],
      ['pricing_last_synced_at', '2026-10-20T00:00:00.000Z'],
    ] as const) {
      const store = await open(paths);
      await ingestion(store, [{ id: 'opus', model: 'claude-opus-5-5' }], builtInModelCatalogs).ingest();
      await close(store);
      const database = new Database(paths.analyticsIndex, { strict: true });
      database.query(`UPDATE analytics_sessions SET ${column} = ?`).run(value);
      database.close();

      // Act
      const reopened = await open(paths);

      // Assert — the row survives, its unexplainable price does not.
      const [row] = reopened.rows();
      should(row?.raw.id).equal('opus');
      should(row?.pricing).be.null();
      reopened.drop();
      await close(reopened);
    }
  });
});
