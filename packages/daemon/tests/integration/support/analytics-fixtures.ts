/** Stored analytics rows for the integration tests: a priced row, and one whose transcript was refused. */
import type { AnalyticsStoredSession } from '../../../src/lib/index.ts';

export function storedSession(overrides: Partial<AnalyticsStoredSession> = {}): AnalyticsStoredSession {
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
      activeDurationMs: 1_200_000,
      machine: null,
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

/** A session whose transcript this daemon could not read: no tokens, no cost, and a stored reason. */
export function refusedSession(id: string): AnalyticsStoredSession {
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
