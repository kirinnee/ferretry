import { describe, it } from 'bun:test';
import should from 'should';
import type { AnalyticsPricingRate } from '../../../src/lib/analytics/pricing.ts';
import {
  deriveAnalyticsSessionRecord,
  type FinishedAnalyticsSession,
} from '../../../src/lib/analytics/session-record.ts';

const catalog: readonly AnalyticsPricingRate[] = [
  {
    pricingKey: 'openai:transcript-model@2026-01-01',
    modelId: 'transcript-model',
    aliases: ['TRANSCRIPT-MODEL-preview'],
    provider: 'openai',
    ratesUsdMicrosPerMillion: {
      input: 1_000_000,
      cachedRead: 100_000,
      cacheWrite: 1_250_000,
      output: 5_000_000,
    },
    verifiedAt: '2026-01-01',
    validFrom: '2026-01-01T00:00:00Z',
  },
];

const finished: FinishedAnalyticsSession = {
  id: 'session-1',
  agent: 'codex-auto-example',
  selectedModel: 'Display-Model[1m]',
  harness: 'codex',
  mode: 'auto',
  status: 'completed',
  label: 'analytics',
  cwd: '/work/repo',
  parent: null,
  createdAt: '2026-07-30T12:00:00+00:00',
  startedAt: '2026-07-30T12:00:01Z',
  finishedAt: '2026-07-30T12:01:01.000Z',
  firstOutputAt: '2026-07-30T12:00:03Z',
  turns: 3,
  contextEndPercent: 42.5,
  stalled: false,
  failed: false,
  migrated: false,
  completed: true,
  usage: {
    pricingModel: 'TRANSCRIPT-MODEL-preview-20260701',
    inputTokens: 1_000,
    cachedInputTokens: 100,
    cacheWriteInputTokens: 50,
    outputTokens: 200,
  },
};

describe('deriveAnalyticsSessionRecord', () => {
  it('should derive metrics while keeping display and pricing evidence distinct', () => {
    // Act
    const actual = deriveAnalyticsSessionRecord(finished, catalog);

    // Assert
    should(actual.raw.model).equal('display-model');
    should(actual.raw.contextWindow).equal(1_000_000);
    should(actual.raw.pricingModel).equal('transcript-model');
    should(actual.displayModelIdentity?.raw).equal('Display-Model[1m]');
    should(actual.pricing?.identity?.raw).equal('TRANSCRIPT-MODEL-preview-20260701');
    should(actual.raw.createdAt).equal('2026-07-30T12:00:00.000Z');
    should(actual.raw.day).equal('2026-07-30');
    should(actual.raw.week).equal('2026-07-27');
    should(actual.raw.tokens).equal(1_200);
    should(actual.raw.durationMs).equal(60_000);
    should(actual.raw.timeToFirstOutputMs).equal(2_000);
    should(actual.raw.equivalentApiCostUsdMicros).equal(1_923);
  });

  it('should honor an explicit context window and persist an effective rate snapshot', () => {
    // Act
    const actual = deriveAnalyticsSessionRecord({ ...finished, contextWindow: 200_000 }, catalog);

    // Assert
    should(actual.raw.contextWindow).equal(200_000);
    should(actual.pricing).have.property('kind', 'priced');
    if (actual.pricing?.kind === 'priced') {
      should(actual.pricing.rate.ratesUsdMicrosPerMillion).deepEqual(catalog[0]!.ratesUsdMicrosPerMillion);
    }
  });

  it('should keep every unknown metric unknown instead of inventing zeroes', () => {
    // Arrange
    const incomplete: FinishedAnalyticsSession = {
      ...finished,
      selectedModel: null,
      startedAt: 'invalid',
      finishedAt: 'also-invalid',
      firstOutputAt: null,
      turns: -1,
      contextEndPercent: 101,
      usage: { ...finished.usage!, outputTokens: null },
    };

    // Act
    const actual = deriveAnalyticsSessionRecord(incomplete, []);

    // Assert
    should(actual.raw.model).be.null();
    should(actual.raw.tokens).be.null();
    should(actual.raw.inputTokens).be.null();
    should(actual.raw.durationMs).be.null();
    should(actual.raw.timeToFirstOutputMs).be.null();
    should(actual.raw.turns).be.null();
    should(actual.raw.contextEndPercent).be.null();
    should(actual.raw.equivalentApiCostUsdMicros).be.null();
    should(actual.pricing).have.property('kind', 'unpriced');
  });

  it('should handle missing usage and clamp negative elapsed metrics', () => {
    // Arrange
    const noUsage: FinishedAnalyticsSession = {
      ...finished,
      startedAt: null,
      firstOutputAt: '2026-07-30T11:59:00Z',
      finishedAt: '2026-07-30T11:58:00Z',
      usage: null,
    };

    // Act
    const actual = deriveAnalyticsSessionRecord(noUsage, catalog);

    // Assert
    should(actual.pricing).be.null();
    should(actual.raw.pricingModel).be.null();
    should(actual.raw.tokens).be.null();
    should(actual.raw.durationMs).equal(0);
    should(actual.raw.timeToFirstOutputMs).equal(0);
  });
});
