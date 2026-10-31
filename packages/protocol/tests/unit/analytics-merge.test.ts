import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnalyticsAggregateResult,
  type AnalyticsAggregation,
  type AnalyticsIndexStatus,
  type AnalyticsLabel,
  type AnalyticsMeasure,
  type AnalyticsMeasureKey,
  type AnalyticsMetric,
  type AnalyticsRawSession,
  type AnalyticsResponse,
  AnalyticsResponseSchema,
  analyticsMetricValue,
} from '../../src/lib/analytics.ts';
import {
  AnalyticsMergeError,
  analyticsGroupSortKey,
  compareAnalyticsRawSessions,
  mergeAnalyticsResponses,
} from '../../src/lib/analytics-merge.ts';

const MEASURES: readonly AnalyticsMeasureKey[] = [
  'tokens',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'cacheWrite5mInputTokens',
  'cacheWrite1hInputTokens',
  'reasoningTokens',
  'equivalentApiCostUsdMicros',
  'equivalentApiCostCurrentUsdMicros',
  'turns',
  'durationMs',
  'activeDurationMs',
  'timeToFirstOutputMs',
  'contextEndPercent',
];
const GROUP_LABELS: readonly AnalyticsLabel[] = ['model', 'runtime', 'day'];

interface Session {
  readonly labels: Readonly<Record<string, string | null>>;
  readonly values: Readonly<Record<AnalyticsMeasureKey, number | null>>;
  readonly status: 'completed' | 'failed' | 'stalled';
}

const INDEX: AnalyticsIndexStatus = {
  schemaVersion: 4,
  sessions: 0,
  tokenSessions: 0,
  transcriptSources: 0,
  indexedTranscriptSources: 0,
  pendingTranscriptSources: 0,
  sourceErrors: 0,
  refreshing: false,
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function sessions(next: () => number, count: number): Session[] {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  return Array.from({ length: count }, () => ({
    labels: { model: pick(['a', 'b', null]), runtime: pick(['r1', 'r2']), day: pick(['2026-10-01', '2026-10-02']) },
    values: Object.fromEntries(MEASURES.map(key => [key, next() < 0.1 ? null : Math.floor(next() * 1_000)])) as Record<
      AnalyticsMeasureKey,
      number | null
    >,
    status: pick(['completed', 'failed', 'stalled'] as const),
  }));
}

/** The daemon's fold, restated: the reference a merge of partial answers must agree with. */
function measure(values: readonly (number | null)[], aggregation: AnalyticsAggregation): AnalyticsMeasure {
  if (aggregation === 'count') return { value: null, known: 0, total: 0 };
  const known = values.filter((value): value is number => value !== null);
  if (known.length !== values.length || known.length === 0) {
    const lowerBound =
      aggregation === 'sum' && known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
    return {
      value: null,
      known: known.length,
      total: values.length,
      ...(lowerBound === null ? {} : { knownSum: lowerBound }),
    };
  }
  const sum = known.reduce((total, value) => total + value, 0);
  const value =
    aggregation === 'sum'
      ? sum
      : aggregation === 'avg'
        ? sum / known.length
        : aggregation === 'min'
          ? Math.min(...known)
          : Math.max(...known);
  return { value, known: known.length, total: values.length };
}

function answer(rows: readonly Session[], groupBy: readonly AnalyticsLabel[], aggregation: AnalyticsAggregation) {
  const groups = new Map<string, Session[]>();
  for (const row of rows) {
    const key = JSON.stringify(groupBy.map(label => row.labels[label] ?? null));
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const results: AnalyticsAggregateResult[] = [...groups.values()].map(group => ({
    labels: Object.fromEntries(groupBy.map(label => [label, group[0]!.labels[label] ?? null])),
    sessions: group.length,
    rates: {
      stall: (100 * group.filter(row => row.status === 'stalled').length) / group.length,
      failure: (100 * group.filter(row => row.status === 'failed').length) / group.length,
      completion: (100 * group.filter(row => row.status === 'completed').length) / group.length,
    },
    ...(Object.fromEntries(
      MEASURES.map(key => [
        key,
        measure(
          group.map(row => row.values[key]),
          aggregation,
        ),
      ]),
    ) as Record<AnalyticsMeasureKey, AnalyticsMeasure>),
  }));
  results.sort((a, b) =>
    analyticsGroupSortKey(a.labels, groupBy).localeCompare(analyticsGroupSortKey(b.labels, groupBy)),
  );
  return AnalyticsResponseSchema.parse({
    query: 'q',
    parsed: { aggregation, groupBy, matchers: [] },
    scope: { allSessions: true, indexed: rows.length, matched: rows.length },
    index: { ...INDEX, sessions: rows.length },
    kind: 'aggregate',
    aggregation,
    results,
  });
}

/** Deep equality, with numbers compared to a relative tolerance: avg is exact only up to rounding. */
function close(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    should(Math.abs(actual - expected)).be.belowOrEqual(1e-9 * Math.max(1, Math.abs(expected)), path);
    return;
  }
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') {
    should(actual).equal(expected, path);
    return;
  }
  should(Object.keys(actual).sort()).deepEqual(Object.keys(expected).sort(), path);
  for (const key of Object.keys(expected)) {
    close((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

function raw(id: string, overrides: Partial<AnalyticsRawSession> = {}): AnalyticsRawSession {
  return {
    id,
    agent: null,
    model: null,
    contextWindow: null,
    harness: null,
    mode: null,
    status: 'completed',
    label: null,
    cwd: null,
    parent: null,
    day: null,
    week: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    pricingModel: null,
    equivalentApiCostUsdMicros: null,
    tokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    cacheWrite5mInputTokens: null,
    cacheWrite1hInputTokens: null,
    reasoningTokens: null,
    turns: null,
    durationMs: null,
    activeDurationMs: null,
    machine: null,
    timeToFirstOutputMs: null,
    contextEndPercent: null,
    stalled: false,
    failed: false,
    migrated: false,
    completed: true,
    ...overrides,
  };
}

function rawAnswer(rows: readonly AnalyticsRawSession[], limit: number, extra: Partial<AnalyticsResponse> = {}) {
  return AnalyticsResponseSchema.parse({
    query: 'q',
    parsed: { groupBy: [], matchers: [] },
    scope: { allSessions: true, indexed: rows.length, matched: rows.length },
    index: INDEX,
    kind: 'raw',
    limit,
    truncated: rows.length > limit,
    results: rows.slice(0, limit),
    ...extra,
  });
}

const AGGREGATIONS: readonly AnalyticsAggregation[] = ['sum', 'avg', 'min', 'max', 'count'];
const SEEDS = Array.from({ length: 60 }, (_, index) => 7_000 + index);

describe('merging analytics answers across machines', () => {
  describe('properties', () => {
    it('should agree with one answer over every machine’s sessions, however they are split', () => {
      for (const seed of SEEDS) {
        // Arrange
        const next = random(seed);
        const all = sessions(next, 1 + Math.floor(next() * 30));
        const machines = 1 + Math.floor(next() * 4);
        const parts = Array.from({ length: machines }, (_, machine) =>
          all.filter((_, index) => index % machines === machine),
        ).filter(part => part.length > 0);
        const aggregation = AGGREGATIONS[seed % AGGREGATIONS.length]!;
        const groupBy = GROUP_LABELS.slice(0, seed % 4);

        // Act
        const merged = mergeAnalyticsResponses(parts.map(part => answer(part, groupBy, aggregation)));

        // Assert
        close(merged, answer(all, groupBy, aggregation), `seed ${seed}`);
        should(AnalyticsResponseSchema.safeParse(merged).success).be.true();
      }
    });

    it('should be commutative exactly and associative up to rounding', () => {
      for (const seed of SEEDS) {
        // Arrange
        const next = random(seed);
        const aggregation = AGGREGATIONS[seed % AGGREGATIONS.length]!;
        const groupBy = GROUP_LABELS.slice(0, 1 + (seed % 3));
        const [a, b, c] = [1, 2, 3].map(() =>
          answer(sessions(next, 1 + Math.floor(next() * 12)), groupBy, aggregation),
        );

        // Act
        const ab = mergeAnalyticsResponses([a!, b!]);
        const ba = mergeAnalyticsResponses([b!, a!]);
        const left = mergeAnalyticsResponses([ab, c!]);
        const right = mergeAnalyticsResponses([a!, mergeAnalyticsResponses([b!, c!])]);

        // Assert
        should(JSON.stringify(ab.results)).equal(JSON.stringify(ba.results), `seed ${seed}`);
        close(left, right, `seed ${seed}`);
      }
    });

    it('should read a ratio metric from merged parts, never by averaging per-machine ratios', () => {
      // Arrange — one machine: 100 s over 1 turn; the other: 100 s over 9 turns
      const row = (active: number, turns: number) => ({
        labels: {},
        values: {
          ...(Object.fromEntries(MEASURES.map(key => [key, 0])) as Record<AnalyticsMeasureKey, number>),
          activeDurationMs: active,
          turns,
        },
        status: 'completed' as const,
      });
      const left = answer([row(100_000, 1)], [], 'sum');
      const right = answer([row(100_000, 9)], [], 'sum');

      // Act
      const merged = mergeAnalyticsResponses([left, right]);
      const result = merged.kind === 'aggregate' ? merged.results[0]! : undefined;

      // Assert — 200 s / 10 turns = 20 s, where averaging the two ratios would say 55.6 s
      should(analyticsMetricValue(result!, 'duration_active_seconds_per_turn')).equal(20);
    });

    it('should merge raw rows into one ordered, bounded list', () => {
      for (const seed of SEEDS) {
        // Arrange
        const next = random(seed);
        const rows = Array.from({ length: 1 + Math.floor(next() * 20) }, (_, index) =>
          raw(`s${Math.floor(index / 3)}`, {
            machine: `m${index % 3}`,
            createdAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(next() * 5))).toISOString(),
            tokens: next() < 0.2 ? null : Math.floor(next() * 100),
          }),
        );
        const metric: AnalyticsMetric | undefined = seed % 2 === 0 ? 'tokens' : undefined;
        const limit = 1 + Math.floor(next() * 25);
        const order = compareAnalyticsRawSessions(metric);
        const parsed = { groupBy: [], matchers: [], ...(metric === undefined ? {} : { metric }) };
        const byMachine = [0, 1, 2]
          .map(machine => rows.filter(row => row.machine === `m${machine}`).sort(order))
          .map(part => rawAnswer(part, 1_000, { parsed }));
        const expected = [...rows].sort(order);

        // Act
        const merged = mergeAnalyticsResponses(byMachine.map(part => ({ ...part, limit })));

        // Assert
        should(merged.kind).equal('raw');
        if (merged.kind !== 'raw') continue;
        should(merged.results).deepEqual(expected.slice(0, limit), `seed ${seed}`);
        should(merged.truncated).equal(expected.length > limit);
        should(merged.scope.matched).equal(rows.length);
      }
    });
  });

  describe('examples', () => {
    it("should merge an older daemon's missing measure as unknown for its sessions, never as nothing", () => {
      // Arrange — machine A (new): one session, 10 turns, 600 s active. Machine B (older): one session,
      // 10 turns, and no active-time field, which the schema defaults to { null, 0, 0 }.
      const zero = Object.fromEntries(MEASURES.map(key => [key, 0])) as Record<AnalyticsMeasureKey, number>;
      const session = (active: number) => ({
        labels: {},
        values: { ...zero, activeDurationMs: active, turns: 10 },
        status: 'completed' as const,
      });
      const fresh = answer([session(600_000)], [], 'sum');
      const older = answer([session(0)], [], 'sum');
      const defaulted = AnalyticsResponseSchema.parse({
        ...older,
        results: (older.kind === 'aggregate' ? older.results : []).map(({ activeDurationMs: _, ...row }) => row),
      });

      // Act
      const merged = mergeAnalyticsResponses([fresh, defaulted]);
      const reversed = mergeAnalyticsResponses([defaulted, fresh]);
      const row = merged.kind === 'aggregate' ? merged.results[0]! : undefined;

      // Assert — the fleet's active time is unknown for B's session, and so is the per-turn ratio
      should(row!.activeDurationMs).deepEqual({ value: null, known: 1, total: 2, knownSum: 600_000 });
      should(row!.turns).deepEqual({ value: 20, known: 2, total: 2 });
      should(analyticsMetricValue(row!, 'duration_active_seconds_per_turn')).be.null();
      should(reversed.kind === 'aggregate' && reversed.results[0]!.activeDurationMs).deepEqual(row!.activeDurationMs);
    });

    it('should carry a sum lower bound across machines instead of dropping what each one stated', () => {
      // Arrange — A states 100 for one session and 5 for a gap; B states 40 outright
      const part = (cost: AnalyticsMeasure, costGaps?: Record<string, number>): AnalyticsResponse => {
        const base = answer(
          [
            {
              labels: {},
              values: Object.fromEntries(MEASURES.map(key => [key, 0])) as Record<AnalyticsMeasureKey, number>,
              status: 'completed',
            },
          ],
          [],
          'sum',
        );
        return AnalyticsResponseSchema.parse({
          ...base,
          results: (base.kind === 'aggregate' ? base.results : []).map(row => ({
            ...row,
            equivalentApiCostUsdMicros: cost,
            ...(costGaps === undefined ? {} : { costGaps }),
          })),
        });
      };
      const a = part({ value: null, known: 1, total: 2, knownSum: 100 }, { unknown_pricing_model: 1 });
      const b = part({ value: 40, known: 3, total: 3 });
      const c = part({ value: null, known: 0, total: 1 }, { transcript_damaged: 1, unknown_pricing_model: 2 });

      // Act
      const merged = mergeAnalyticsResponses([a, b, c]);
      const reversed = mergeAnalyticsResponses([c, b, a]);
      const row = merged.kind === 'aggregate' ? merged.results[0]! : undefined;

      // Assert
      should(row!.equivalentApiCostUsdMicros).deepEqual({ value: null, known: 4, total: 6, knownSum: 140 });
      should(row!.costGaps).deepEqual({ unknown_pricing_model: 3, transcript_damaged: 1 });
      should(reversed.kind === 'aggregate' && reversed.results[0]!.equivalentApiCostUsdMicros).deepEqual(
        row!.equivalentApiCostUsdMicros,
      );
    });

    it('should leave a complete merged sum without a lower bound', () => {
      // Arrange
      const zero = Object.fromEntries(MEASURES.map(key => [key, 3])) as Record<AnalyticsMeasureKey, number>;
      const one = answer([{ labels: {}, values: zero, status: 'completed' }], [], 'sum');

      // Act
      const merged = mergeAnalyticsResponses([one, one]);

      // Assert
      const row = merged.kind === 'aggregate' ? merged.results[0]! : undefined;
      should(row!.equivalentApiCostUsdMicros).deepEqual({ value: 6, known: 2, total: 2 });
      should(row!.costGaps).be.undefined();
    });

    it('should read the per-turn ratio as unknown when an unmerged answer lacks active time', () => {
      // Arrange — an older daemon's answer on its own
      const zero = Object.fromEntries(MEASURES.map(key => [key, 0])) as Record<AnalyticsMeasureKey, number>;
      const older = answer([{ labels: {}, values: { ...zero, turns: 10 }, status: 'completed' }], [], 'sum');
      const row = older.kind === 'aggregate' ? older.results[0]! : undefined;

      // Act
      const perTurn = analyticsMetricValue(
        { ...row!, activeDurationMs: { value: null, known: 0, total: 0 } },
        'duration_active_seconds_per_turn',
      );

      // Assert
      should(perTurn).be.null();
    });

    it('should combine the index accounts and the resolved windows', () => {
      // Arrange
      const left = rawAnswer([raw('a')], 10, {
        index: { ...INDEX, schemaVersion: 3, sourceErrors: 1, lastTokenRefreshAt: '2026-10-02T00:00:00.000Z' },
        scope: {
          allSessions: true,
          indexed: 1,
          matched: 1,
          window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
        },
      });
      const right = rawAnswer([raw('b')], 10, {
        index: { ...INDEX, refreshing: true, lastTokenRefreshAt: '2026-10-03T00:00:00.000Z' },
        scope: {
          allSessions: true,
          indexed: 4,
          matched: 1,
          window: { from: '2026-09-30T23:00:00.000Z', to: '2026-10-07T23:00:00.000Z' },
        },
      });
      const windowless = rawAnswer([raw('c')], 10);

      // Act
      const merged = mergeAnalyticsResponses([left, right]);
      const reversed = mergeAnalyticsResponses([right, left]);
      const withWindowless = mergeAnalyticsResponses([windowless, left, windowless]);

      // Assert
      should(merged.index).deepEqual({
        ...INDEX,
        schemaVersion: 3,
        sourceErrors: 1,
        refreshing: true,
        lastTokenRefreshAt: '2026-10-03T00:00:00.000Z',
      });
      should(merged.scope).deepEqual({
        allSessions: true,
        indexed: 5,
        matched: 2,
        window: { from: '2026-09-30T23:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
      });
      should(reversed.scope).deepEqual(merged.scope);
      should(reversed.index).deepEqual(merged.index);
      should(withWindowless.scope.window).deepEqual(left.scope.window);
      should(mergeAnalyticsResponses([windowless, windowless]).index.lastTokenRefreshAt).be.undefined();
      should(mergeAnalyticsResponses([windowless, left]).index.lastTokenRefreshAt).equal('2026-10-02T00:00:00.000Z');
    });

    it('should order raw ties by id and then by machine, and unknown metrics last', () => {
      // Arrange
      const order = compareAnalyticsRawSessions('cost_usd');
      const rows = [
        raw('b', { machine: 'm2' }),
        raw('b', { machine: 'm1' }),
        raw('a', { machine: null }),
        raw('a', { machine: null }),
        raw('z', { equivalentApiCostUsdMicros: 5 }),
        raw('y', { equivalentApiCostUsdMicros: 9, createdAt: null }),
      ];

      // Act
      const sorted = [...rows].sort(order).map(row => `${row.id}${row.machine ?? ''}`);

      // Assert
      should(sorted).deepEqual(['y', 'z', 'a', 'a', 'bm1', 'bm2']);
    });

    it.each([
      { name: 'an empty list', responses: () => [], message: 'there is no answer to merge' },
      {
        name: 'mixed kinds',
        responses: () => [rawAnswer([], 1), answer([], [], 'sum')],
        message: 'cannot merge a raw answer with a aggregate one',
      },
      {
        name: 'different aggregations',
        responses: () => [answer([], [], 'sum'), answer([], [], 'avg')],
        message: 'aggregated differently',
      },
      {
        name: 'different metrics',
        responses: () => [
          rawAnswer([], 1, { parsed: { groupBy: [], matchers: [], metric: 'tokens' } }),
          rawAnswer([], 1),
        ],
        message: 'different metrics',
      },
      {
        name: 'different groupings',
        responses: () => [answer([], ['model'], 'sum'), answer([], ['day'], 'sum')],
        message: 'grouped differently',
      },
    ])('should refuse $name', ({ responses, message }) => {
      // Act
      let actual: unknown;
      try {
        mergeAnalyticsResponses(responses());
      } catch (error) {
        actual = error;
      }

      // Assert
      should(actual).be.instanceof(AnalyticsMergeError);
      should((actual as Error).message).containEql(message);
    });
  });
});
