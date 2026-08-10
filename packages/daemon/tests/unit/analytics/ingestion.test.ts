import { describe, it } from 'bun:test';
import should from 'should';
import {
  AnalyticsIngestionService,
  type AnalyticsIngestCandidate,
  type AnalyticsIngestionParts,
} from '../../../src/lib/analytics/ingestion.ts';
import type { AnalyticsPricingRate } from '../../../src/lib/analytics/pricing.ts';
import type {
  AnalyticsIndexStore,
  AnalyticsIngestedMarker,
  AnalyticsStoredSession,
  AnalyticsStoreStatus,
} from '../../../src/lib/analytics/store.ts';
import { ANALYTICS_INDEX_SCHEMA_VERSION } from '../../../src/lib/analytics/store.ts';
import type { AnalyticsTranscriptEvidence } from '../../../src/lib/analytics/usage-fold.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';

/**
 * The ingestion pass, over a store held in memory.
 *
 * The store is the only stand-in. The terminal-state gate, the transcript fold, the model-identity
 * normaliser, the pricing snapshot and the row derivation are all production code, so what a case
 * asserts about a stored row is what the daemon would store.
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

/** An in-memory analytics store, keyed on session id exactly as the SQLite one is. */
class MemoryStore implements AnalyticsIndexStore {
  readonly saved = new Map<string, AnalyticsStoredSession>();
  drops = 0;
  closed = 0;

  ingested(): ReadonlyMap<string, AnalyticsIngestedMarker> {
    return new Map(
      [...this.saved.values()].map(row => [
        row.raw.id,
        { signature: row.signature, hasUsage: row.usageRefusal === null },
      ]),
    );
  }

  upsert(rows: readonly AnalyticsStoredSession[]): void {
    for (const row of rows) this.saved.set(row.raw.id, row);
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) this.saved.delete(id);
  }

  rows(): readonly AnalyticsStoredSession[] {
    return [...this.saved.values()];
  }

  status(): AnalyticsStoreStatus {
    const rows = this.rows();
    const ingestedAt = rows.map(row => row.ingestedAt).toSorted();
    return {
      schemaVersion: ANALYTICS_INDEX_SCHEMA_VERSION,
      sessions: rows.length,
      tokenSessions: rows.filter(row => row.raw.tokens !== null).length,
      refusedUsageSessions: rows.filter(row => row.usageRefusal !== null).length,
      lastIngestedAt: ingestedAt.at(-1) ?? null,
    };
  }

  drop(): void {
    this.drops += 1;
    this.saved.clear();
  }

  close(): void {
    this.closed += 1;
  }
}

function candidate(overrides: Partial<AnalyticsIngestCandidate> & { readonly id: string }): AnalyticsIngestCandidate {
  return {
    transcriptHarness: 'claude',
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
    turns: 3,
    contextEndPercent: 40,
    migrated: false,
    ...overrides,
  };
}

/** One assistant usage record, in the shape the Claude parser produces. */
function usageEvent(model: string, inputTokens: number, outputTokens: number): TranscriptEvent {
  return {
    kind: 'usage',
    harness: 'claude',
    role: 'assistant',
    timestamp: '2026-08-01T00:30:00.000Z',
    usage: {
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };
}

const readEvidence = (events: readonly TranscriptEvent[]): AnalyticsTranscriptEvidence => ({
  kind: 'read',
  harness: 'claude',
  events,
  issues: [],
  pendingBytes: 0,
});

interface Harness {
  readonly service: AnalyticsIngestionService;
  readonly store: MemoryStore;
  /** Session ids whose transcript was actually read, in order. */
  readonly reads: string[];
  setCandidates(next: readonly AnalyticsIngestCandidate[]): void;
  setPricing(next: readonly AnalyticsPricingRate[]): void;
}

function harness(
  candidates: readonly AnalyticsIngestCandidate[],
  evidence: (id: string) => Promise<AnalyticsTranscriptEvidence>,
  overrides: Partial<AnalyticsIngestionParts> = {},
): Harness {
  const store = new MemoryStore();
  const reads: string[] = [];
  let current = candidates;
  let pricing = RATES;
  let tick = 0;
  const service = new AnalyticsIngestionService({
    candidates: { listCandidates: async () => current },
    evidence: {
      evidenceFor: async id => {
        reads.push(id);
        return await evidence(id);
      },
    },
    store,
    pricing: async () => pricing,
    clock: {
      now: () => {
        tick += 1;
        return `2026-08-02T00:00:0${tick}.000Z`;
      },
    },
    concurrency: 2,
    rebuildRequired: false,
    ...overrides,
  });
  return {
    service,
    store,
    reads,
    setCandidates: next => {
      current = next;
    },
    setPricing: next => {
      pricing = next;
    },
  };
}

describe('AnalyticsIngestionService.ingest', () => {
  it('should price a session addressed by two spellings the catalog calls one model', async () => {
    // THE WHOLE PATH, not just the pricing step. The catalog's alias groups have to reach the FOLD:
    // that is where two spellings become one identity or a mixed-model refusal, and a refusal decided
    // without them leaves the session permanently unpriced no matter what the catalog says next.
    // Arrange
    const aliased: readonly AnalyticsPricingRate[] = [{ ...RATES[0]!, aliases: ['claude-opus-5-preview'] }];
    const test = harness(
      [candidate({ id: 's1' })],
      async () =>
        readEvidence([usageEvent('claude-opus-5', 1_000, 500), usageEvent('claude-opus-5-preview', 1_000, 500)]),
      { pricing: async () => aliased },
    );

    // Act
    await test.service.ingest();

    // Assert
    const [row] = test.store.rows();
    should(row?.raw.pricingModel).equal('claude-opus-5');
    should(row?.pricing).have.property('kind', 'priced');
    // 2000 input at 15 USD/M and 1000 output at 75 USD/M, in whole micros.
    should(row?.raw.equivalentApiCostUsdMicros).equal(105_000);
  });

  it('should leave a genuinely mixed-model session unpriced with the catalog in hand', async () => {
    // Aliases make one model addressable twice; they do not make two models one.
    const test = harness([candidate({ id: 's1' })], async () =>
      readEvidence([usageEvent('claude-opus-5', 1_000, 500), usageEvent('claude-sonnet-5', 1_000, 500)]),
    );

    await test.service.ingest();

    const [row] = test.store.rows();
    // The token total still stands — a count does not depend on which model produced it.
    should(row?.raw.tokens).equal(3_000);
    should(row?.raw.pricingModel).be.null();
    should(row?.pricing).containDeep({ kind: 'unpriced', reason: 'missing_pricing_model' });
    should(row?.raw.equivalentApiCostUsdMicros).be.null();
  });

  it('should store a finished session with the total folded from its own transcript', async () => {
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () =>
      readEvidence([usageEvent('claude-opus-5', 1_000, 500)]),
    );

    // Act
    const summary = await test.service.ingest();

    // Assert
    should(summary.examined).equal(1);
    should(summary.ingested).equal(1);
    should(summary.usageRefused).equal(0);
    const [row] = test.store.rows();
    should(row?.raw.tokens).equal(1_500);
    should(row?.raw.inputTokens).equal(1_000);
    should(row?.usageRefusal).be.null();
    // 1000 input at 15 USD/M and 500 output at 75 USD/M, in whole micros.
    should(row?.raw.equivalentApiCostUsdMicros).equal(52_500);
    should(row?.pricing?.kind).equal('priced');
  });

  it('should keep the display model distinct from the model the transcript priced', async () => {
    // A selector encodes a context-window choice the underlying model does not, so the display identity
    // and the pricing evidence are two facts. Overwriting one with the other loses which was which.
    // Arrange
    const test = harness([candidate({ id: 's1', selectedModel: 'claude-opus-5[1m]' })], async () =>
      readEvidence([usageEvent('claude-opus-5-20260101', 100, 100)]),
    );

    // Act
    await test.service.ingest();

    // Assert
    const [row] = test.store.rows();
    should(row?.raw.model).equal('claude-opus-5');
    should(row?.raw.contextWindow).equal(1_000_000);
    should(row?.raw.pricingModel).equal('claude-opus-5');
  });

  it('should refuse a session that has not reached a durable terminal state, counting the reason', async () => {
    // Arrange
    const test = harness(
      [
        candidate({ id: 'live', status: 'running' }),
        candidate({ id: 'unstamped', finishedAt: null }),
        candidate({ id: 'unknown', status: 'wrapped-up' }),
      ],
      async () => readEvidence([usageEvent('claude-opus-5', 10, 10)]),
    );

    // Act
    const summary = await test.service.ingest();

    // Assert
    should(summary.gateRefused).equal(3);
    should(summary.gateRefusals).deepEqual({ nonterminal_status: 1, no_finish_instant: 1, unknown_status: 1 });
    should(test.store.rows()).be.empty();
    should(test.reads).be.empty();
  });

  it('should store a session whose transcript could not be read as unknown, never as zero', async () => {
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () => ({ kind: 'unresolved' }));

    // Act
    const summary = await test.service.ingest();

    // Assert
    should(summary.ingested).equal(1);
    should(summary.usageRefused).equal(1);
    should(summary.sourceErrors).equal(0);
    const [row] = test.store.rows();
    should(row?.usageRefusal).equal('transcript_unresolved');
    should(row?.raw.tokens).be.null();
    should(row?.raw.equivalentApiCostUsdMicros).be.null();
    should(row?.pricing).be.null();
  });

  it('should treat a transcript read that raised as unreadable and count it as a source error', async () => {
    // A read that threw is not an empty transcript. Counting it separately is what lets the index report
    // that a source failed instead of reporting a fleet that spent nothing.
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () => {
      throw new Error('the transcript file vanished mid-read');
    });

    // Act
    const summary = await test.service.ingest();

    // Assert
    should(summary.sourceErrors).equal(1);
    should(test.store.rows()[0]?.usageRefusal).equal('transcript_unreadable');
  });

  it('should not read a transcript twice for a session whose total is already proven', async () => {
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () =>
      readEvidence([usageEvent('claude-opus-5', 1_000, 500)]),
    );
    await test.service.ingest();

    // Act
    const second = await test.service.ingest();

    // Assert
    should(second.unchanged).equal(1);
    should(second.ingested).equal(0);
    should(test.reads).deepEqual(['s1']);
  });

  it('should re-attempt a session whose fold was refused, because a refusal is not proof', async () => {
    // A refusal states what this daemon could read at that moment — a transcript not yet resolved, a
    // file mid-write — so the row is corrected as soon as the evidence can be read.
    // Arrange
    let resolvable = false;
    const test = harness([candidate({ id: 's1' })], async () =>
      resolvable ? readEvidence([usageEvent('claude-opus-5', 200, 100)]) : { kind: 'unresolved' },
    );
    await test.service.ingest();

    // Act
    resolvable = true;
    const second = await test.service.ingest();

    // Assert
    should(second.ingested).equal(1);
    should(second.unchanged).equal(0);
    should(test.reads).deepEqual(['s1', 's1']);
    should(test.store.rows()[0]?.raw.tokens).equal(300);
    should(test.store.rows()[0]?.usageRefusal).be.null();
  });

  it('should re-ingest when the operator edits the rate catalog', async () => {
    // THE CATALOG IS READ PER PASS, NEVER HELD. `parts.pricing` is a function the composition root
    // supplies, called at the top of every sweep, so an operator editing prices while the daemon runs
    // is reflected by the NEXT pass — no restart, and no rebuilt ingestion service. The catalog's
    // fingerprint is part of each session's signature, which is what makes the edit re-price rows
    // that were otherwise unchanged.
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () =>
      readEvidence([usageEvent('claude-opus-5', 1_000, 500)]),
    );
    await test.service.ingest();
    const service = test.service;

    // Act — the same service instance, a different catalog.
    test.setPricing([{ ...RATES[0]!, rates: { ...RATES[0]!.rates, output: 150_000_000 } }]);
    const second = await service.ingest();

    // Assert
    should(second.ingested).equal(1);
    should(second.unchanged).equal(0);
    should(test.store.rows()[0]?.raw.equivalentApiCostUsdMicros).equal(90_000);
  });

  it('should re-price a mixed-model refusal when a later catalog edit joins the spellings', async () => {
    // The alias groups reach the fold, and the fold runs per pass — so an operator who adds the
    // missing alias fixes the session that was reported unpriced, on the next pass, without a
    // restart. If the aliases had been read once at construction this row would stay wrong forever.
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () =>
      readEvidence([usageEvent('claude-opus-5', 1_000, 500), usageEvent('claude-opus-5-preview', 1_000, 500)]),
    );
    await test.service.ingest();
    should(test.store.rows()[0]?.raw.pricingModel).be.null();

    // Act — the same service instance, a catalog that now says the two spellings are one model.
    test.setPricing([{ ...RATES[0]!, aliases: ['claude-opus-5-preview'] }]);
    await test.service.ingest();

    // Assert
    should(test.store.rows()[0]?.raw.pricingModel).equal('claude-opus-5');
    should(test.store.rows()[0]?.raw.equivalentApiCostUsdMicros).equal(105_000);
  });

  it('should refuse the pass when the catalog cannot be read, not substitute an empty one', async () => {
    // A pricing provider that REJECTS — the config document unreadable, the provider feed down — refuses
    // the WHOLE pass. With no catalog no row could be priced, and the alternative, reading the rejection
    // as an empty catalog, would store every session as unpriced and report a fleet that spent nothing.
    // The rejection propagates out of the pass, and nothing is written behind it.
    // Arrange
    const test = harness(
      [candidate({ id: 's1' })],
      async () => readEvidence([usageEvent('claude-opus-5', 1_000, 500)]),
      { pricing: async () => Promise.reject(new Error('catalog unavailable')) },
    );

    // Act / Assert
    await should(test.service.ingest()).be.rejectedWith(/catalog unavailable/);
    should(test.store.rows()).be.empty();
  });

  it('should replace rather than accumulate when the same session is ingested twice', async () => {
    // A retry after a crash must not double-count. No column accumulates and the key is the session id,
    // so a second pass over the same evidence produces the same row.
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () =>
      readEvidence([usageEvent('claude-opus-5', 1_000, 500)]),
    );

    // Act
    await test.service.ingest();
    const before = test.store.rows()[0]?.raw;
    await test.service.rebuild();

    // Assert
    should(test.store.rows()).have.length(1);
    should(test.store.rows()[0]?.raw).deepEqual(before!);
    should(test.store.drops).equal(1);
  });

  it('should forget a row whose durable session records are gone', async () => {
    // The records are authoritative; an index outliving them would answer for a fleet that is gone.
    // Arrange
    const test = harness([candidate({ id: 's1' }), candidate({ id: 's2' })], async () =>
      readEvidence([usageEvent('claude-opus-5', 10, 10)]),
    );
    await test.service.ingest();

    // Act
    test.setCandidates([candidate({ id: 's1' })]);
    const second = await test.service.ingest();

    // Assert
    should(second.forgotten).equal(1);
    should(test.store.rows().map(row => row.raw.id)).deepEqual(['s1']);
  });

  it('should forget a row whose session went back to work', async () => {
    // A revive puts a stopped session back to running, so the totals ingested when it ended are no
    // longer its final ones. Keeping the row would report a running session's spend as a finished run's.
    // Arrange
    const test = harness([candidate({ id: 's1', status: 'stopped' })], async () =>
      readEvidence([usageEvent('claude-opus-5', 10, 10)]),
    );
    await test.service.ingest();

    // Act
    test.setCandidates([candidate({ id: 's1', status: 'running' })]);
    const second = await test.service.ingest();

    // Assert
    should(second.forgotten).equal(1);
    should(second.gateRefused).equal(1);
    should(test.store.rows()).be.empty();
  });

  it('should fold every session when there are more of them than the concurrency allows', async () => {
    // Arrange
    const test = harness(
      [candidate({ id: 's1' }), candidate({ id: 's2' }), candidate({ id: 's3' })],
      async () => readEvidence([usageEvent('claude-opus-5', 10, 10)]),
      { concurrency: 2 },
    );

    // Act
    const summary = await test.service.ingest();

    // Assert
    should(summary.ingested).equal(3);
    should(test.reads).have.length(3);
  });

  it('should run passes one at a time so neither re-folds what the other proved', async () => {
    // Two overlapping passes would each read the store's markers before the other wrote its rows.
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () => readEvidence([usageEvent('claude-opus-5', 10, 10)]));

    // Act
    const [first, second] = await Promise.all([test.service.ingest(), test.service.ingest()]);

    // Assert
    should(first.ingested).equal(1);
    should(second.ingested).equal(0);
    should(second.unchanged).equal(1);
    should(test.reads).deepEqual(['s1']);
  });

  it('should keep serving later passes after one of them failed', async () => {
    // A background timer keeps firing; a pass that raised must not wedge the chain behind it.
    // Arrange
    let broken = true;
    const test = harness([candidate({ id: 's1' })], async () => readEvidence([usageEvent('claude-opus-5', 10, 10)]), {
      candidates: {
        listCandidates: async () => {
          if (broken) throw new Error('the state home could not be listed');
          return [candidate({ id: 's1' })];
        },
      },
    });

    // Act
    await test.service.ingest().should.be.rejected();
    broken = false;

    // Assert
    should((await test.service.ingest()).ingested).equal(1);
  });
});

describe('AnalyticsIngestionService.read', () => {
  it('should report an unproven fold as a pending source rather than an indexed one', async () => {
    // Arrange
    const test = harness([candidate({ id: 's1' }), candidate({ id: 's2' })], async id =>
      id === 's1' ? readEvidence([usageEvent('claude-opus-5', 10, 10)]) : { kind: 'unresolved' },
    );

    // Act
    await test.service.ingest();
    const read = test.service.read();

    // Assert
    should(read.rows).have.length(2);
    should(read.status).deepEqual({
      schemaVersion: ANALYTICS_INDEX_SCHEMA_VERSION,
      sessions: 2,
      tokenSessions: 1,
      transcriptSources: 2,
      indexedTranscriptSources: 1,
      pendingTranscriptSources: 1,
      sourceErrors: 0,
      refreshing: false,
      lastTokenRefreshAt: test.store.status().lastIngestedAt!,
    });
  });

  it('should say a pass is in flight while one is running', async () => {
    // An index that is mid-refresh and one that has nothing to say look identical from the outside and
    // are completely different states.
    // Arrange
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const test = harness([candidate({ id: 's1' })], async () => {
      await gate;
      return readEvidence([usageEvent('claude-opus-5', 10, 10)]);
    });

    // Act
    const pass = test.service.ingest();

    // Assert
    should(test.service.read().status.refreshing).be.true();
    release();
    await pass;
    should(test.service.read().status.refreshing).be.false();
  });

  it('should omit the last refresh instant while nothing is ingested rather than inventing one', async () => {
    // Arrange
    const test = harness([], async () => ({ kind: 'unresolved' }));

    // Act
    const read = test.service.read();

    // Assert
    should(read.status).not.have.property('lastTokenRefreshAt');
    should(read.status.sessions).equal(0);
    should(read.rows).be.empty();
  });

  it('should carry the last pass‘s source errors into the account it reports', async () => {
    // Arrange
    const test = harness([candidate({ id: 's1' })], async () => {
      throw new Error('unreadable');
    });

    // Act
    await test.service.ingest();

    // Assert
    should(test.service.read().status.sourceErrors).equal(1);
  });
});

describe('AnalyticsIngestionService.rebuildRequired', () => {
  it('should report what the store said when it was opened', async () => {
    // DECLARED rather than inferred from an empty table: an index that was thrown away and one that has
    // simply never seen a finished session both hold no rows.
    // Arrange / Act / Assert
    should(
      harness([], async () => ({ kind: 'unresolved' }), { rebuildRequired: true }).service.rebuildRequired,
    ).be.true();
    should(harness([], async () => ({ kind: 'unresolved' })).service.rebuildRequired).be.false();
  });
});
