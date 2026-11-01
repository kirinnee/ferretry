import { describe, it } from 'bun:test';
import should from 'should';
import * as analytics from '../../src/lib/analytics.ts';
import type {
  AnalyticsAggregateResult,
  AnalyticsIndexStatus,
  AnalyticsMatcher,
  AnalyticsMeasure,
  AnalyticsRates,
  AnalyticsRawSession,
  AnalyticsResponse,
  ParsedAnalyticsQuery,
} from '../../src/lib/index.ts';
import { analyticsResponse, INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const measure = { value: 128_000, known: 3, total: 4 } satisfies AnalyticsMeasure;
const unknownMeasure = { value: null, known: 0, total: 2 } satisfies AnalyticsMeasure;
const rates = { stall: 12.5, failure: 25, completion: 62.5 } satisfies AnalyticsRates;

const matcher = { label: 'agent', op: '=', value: 'codex-auto-loge', wildcard: false } satisfies AnalyticsMatcher;
const regexMatcher = { label: 'model', op: '=~', value: 'gpt-.*', wildcard: true } satisfies AnalyticsMatcher;

const parsedQuery = {
  source: 'sum tokens by agent where model=~gpt-.*',
  canonical: 'sum(tokens) by (agent)',
  aggregation: 'sum',
  groupBy: ['agent'],
  matchers: [matcher, regexMatcher],
} satisfies ParsedAnalyticsQuery;

const indexStatus = {
  schemaVersion: 3,
  sessions: 8,
  tokenSessions: 6,
  transcriptSources: 5,
  indexedTranscriptSources: 4,
  pendingTranscriptSources: 1,
  sourceErrors: 0,
  refreshing: true,
  lastTokenRefreshAt: INSTANT,
} satisfies AnalyticsIndexStatus;

const aggregateResult = {
  labels: { agent: 'codex-auto-loge', model: 'gpt-5.6-sol', tree: null },
  sessions: 4,
  rates,
  tokens: measure,
  inputTokens: measure,
  outputTokens: measure,
  cachedInputTokens: measure,
  cacheWriteInputTokens: measure,
  cacheWrite5mInputTokens: measure,
  cacheWrite1hInputTokens: unknownMeasure,
  reasoningTokens: unknownMeasure,
  equivalentApiCostUsdMicros: measure,
  equivalentApiCostCurrentUsdMicros: measure,
  turns: measure,
  durationMs: measure,
  activeDurationMs: measure,
  timeToFirstOutputMs: unknownMeasure,
  contextEndPercent: { value: 74.5, known: 4, total: 4 },
} satisfies AnalyticsAggregateResult;

const rawSession = {
  id: 'session-1',
  agent: 'codex-auto-loge',
  model: 'gpt-5.6-sol',
  contextWindow: 400_000,
  harness: 'codex',
  mode: 'auto',
  status: 'running',
  label: 'port',
  cwd: '/workspace',
  parent: null,
  tree: 'main',
  day: '2026-07-30',
  week: '2026-W31',
  createdAt: INSTANT,
  pricingModel: 'gpt-5.6',
  equivalentApiCostUsdMicros: 12_500,
  tokens: 128_000,
  inputTokens: 96_000,
  outputTokens: 32_000,
  cachedInputTokens: 64_000,
  cacheWriteInputTokens: 8_000,
  cacheWrite5mInputTokens: 6_000,
  cacheWrite1hInputTokens: 2_000,
  reasoningTokens: 4_096,
  turns: 12,
  durationMs: 900_000,
  activeDurationMs: 600_000,
  machine: 'kirin-box',
  timeToFirstOutputMs: 1_500,
  contextEndPercent: 74.5,
  stalled: false,
  failed: false,
  migrated: false,
  completed: true,
} satisfies AnalyticsRawSession;

/** Every nullable column empty — the shape emitted before a transcript is indexed. */
const unindexedRawSession = {
  ...rawSession,
  agent: null,
  model: null,
  contextWindow: null,
  harness: null,
  mode: null,
  status: null,
  label: null,
  cwd: null,
  parent: null,
  day: null,
  week: null,
  createdAt: null,
  pricingModel: null,
  equivalentApiCostUsdMicros: null,
  tokens: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  cacheWrite5mInputTokens: null,
  cacheWrite1hInputTokens: null,
  turns: null,
  durationMs: null,
  activeDurationMs: null,
  machine: null,
  timeToFirstOutputMs: null,
  contextEndPercent: null,
} satisfies AnalyticsRawSession;

const aggregateResponse = {
  query: 'sum tokens by agent',
  parsed: { aggregation: 'sum', groupBy: ['agent'], matchers: [matcher] },
  scope: { allSessions: true, indexed: 8, matched: 4 },
  index: indexStatus,
  kind: 'aggregate',
  aggregation: 'sum',
  results: [aggregateResult],
} satisfies AnalyticsResponse;

const rawResponse = {
  ...analyticsResponse,
  scope: { allSessions: true, indexed: 8, matched: 2 },
  index: indexStatus,
  limit: 50,
  truncated: true,
  results: [rawSession, unindexedRawSession],
} satisfies AnalyticsResponse;

const analyticsCases: SchemaCase[] = [
  { name: 'aggregation', schema: analytics.AnalyticsAggregationSchema, value: 'sum' },
  { name: 'label', schema: analytics.AnalyticsLabelSchema, value: 'agent' },
  { name: 'matcher', schema: analytics.AnalyticsMatcherSchema, value: matcher },
  { name: 'parsed query', schema: analytics.ParsedAnalyticsQuerySchema, value: parsedQuery },
  { name: 'measure', schema: analytics.AnalyticsMeasureSchema, value: measure },
  { name: 'rates', schema: analytics.AnalyticsRatesSchema, value: rates },
  { name: 'aggregate result', schema: analytics.AnalyticsAggregateResultSchema, value: aggregateResult },
  { name: 'raw session', schema: analytics.AnalyticsRawSessionSchema, value: rawSession },
  { name: 'metric', schema: analytics.AnalyticsMetricSchema, value: 'cost_usd' },
  { name: 'relative range', schema: analytics.AnalyticsRangeSchema, value: { kind: 'relative', seconds: 604_800 } },
  { name: 'index status', schema: analytics.AnalyticsIndexStatusSchema, value: indexStatus },
  { name: 'response', schema: analytics.AnalyticsResponseSchema, value: rawResponse },
];

describe('analytics schemas', () => {
  it('should round-trip every public analytics schema', () => {
    // Arrange
    const cases = analyticsCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(analytics, cases);
  });

  it('should resolve every aggregation, label, and matcher operator', () => {
    // Arrange
    const aggregations = ['sum', 'avg', 'min', 'max', 'count'];
    const labels = [
      'id',
      'agent',
      'model',
      'pricing_model',
      'context_window',
      'harness',
      'mode',
      'status',
      'label',
      'cwd',
      'repo',
      'parent',
      'tree',
      'day',
      'week',
      'token_data',
      'runtime',
      'project',
      'session',
      'machine',
    ];

    // Act
    const parsedLabels = analytics.ParsedAnalyticsQuerySchema.parse({ ...parsedQuery, groupBy: labels }).groupBy;

    // Assert
    // Listed here AND checked against the schema, because a list that only proves no wrong member
    // reads exactly the same when a member is missing.
    should([...labels].sort()).deepEqual([...analytics.AnalyticsLabelSchema.options].sort());
    should([...aggregations].sort()).deepEqual([...analytics.AnalyticsAggregationSchema.options].sort());
    for (const value of aggregations) should(analytics.AnalyticsAggregationSchema.parse(value)).equal(value);
    for (const value of labels) should(analytics.AnalyticsLabelSchema.parse(value)).equal(value);
    should(parsedLabels).deepEqual(labels);
    for (const op of ['=', '=~']) should(analytics.AnalyticsMatcherSchema.parse({ ...matcher, op }).op).equal(op);
  });

  it('should resolve both response union members', () => {
    // Arrange
    const values = [aggregateResponse, rawResponse];

    // Act
    const parsed = values.map(value => analytics.AnalyticsResponseSchema.parse(value));

    // Assert
    should(parsed.map(entry => entry.kind)).deepEqual(['aggregate', 'raw']);
    should(parsed[0]).deepEqual(aggregateResponse);
    should(parsed[1]).deepEqual(rawResponse);
  });

  it('should accept an aggregation-free query and an omitted optional column', () => {
    // Arrange
    const bareQuery = { source: 'tokens', canonical: 'tokens', groupBy: [], matchers: [] };
    const { tree: _tree, ...treelessSession } = rawSession;
    const { lastTokenRefreshAt: _refreshedAt, ...unrefreshedIndex } = indexStatus;

    // Act
    const parsedQueryValue = analytics.ParsedAnalyticsQuerySchema.parse(bareQuery);
    const parsedSession = analytics.AnalyticsRawSessionSchema.parse(treelessSession);
    const parsedIndex = analytics.AnalyticsIndexStatusSchema.parse(unrefreshedIndex);

    // Assert
    should(parsedQueryValue.aggregation).be.undefined();
    should(parsedSession).not.have.property('tree');
    should(parsedIndex).not.have.property('lastTokenRefreshAt');
  });

  it('should require reasoning tokens now that the daemon folds them', () => {
    // THE KEY IS NO LONGER OPTIONAL. It was, while nothing counted the figure and a responder had to
    // be able to say "I cannot state this at all". The daemon now folds it on every path that builds
    // a row, so omitting it is not a claim anyone is entitled to make — a reader would keep a
    // fallback for a case that can no longer occur. Unknown is `null`, and a stated zero is the
    // separate claim that this session did no reasoning.
    // Arrange
    const { reasoningTokens: _sessionCount, ...sessionWithoutCount } = rawSession;
    const { reasoningTokens: _aggregateMeasure, ...aggregateWithoutMeasure } = aggregateResult;

    // Act
    const parsedSession = analytics.AnalyticsRawSessionSchema.parse(rawSession);
    const parsedAggregate = analytics.AnalyticsAggregateResultSchema.parse(aggregateResult);

    // Assert
    should(parsedSession.reasoningTokens).equal(4_096);
    should(
      analytics.AnalyticsRawSessionSchema.parse({ ...rawSession, reasoningTokens: null }).reasoningTokens,
    ).be.null();
    should(analytics.AnalyticsRawSessionSchema.parse({ ...rawSession, reasoningTokens: 0 }).reasoningTokens).equal(0);
    should(parsedAggregate.reasoningTokens).deepEqual(unknownMeasure);
    should(analytics.AnalyticsRawSessionSchema.safeParse(sessionWithoutCount).success).be.false();
    should(analytics.AnalyticsAggregateResultSchema.safeParse(aggregateWithoutMeasure).success).be.false();
  });

  it('should accept the inclusive bounds of every percentage and known-count constraint', () => {
    // Arrange
    const boundaryRates = { stall: 0, failure: 100, completion: 0 };
    const exhaustedMeasure = { value: 0, known: 4, total: 4 };
    const boundarySessions = [
      { ...rawSession, contextEndPercent: 0 },
      { ...rawSession, contextEndPercent: 100 },
    ];

    // Act + Assert
    should(analytics.AnalyticsRatesSchema.parse(boundaryRates)).deepEqual(boundaryRates);
    should(analytics.AnalyticsMeasureSchema.parse(exhaustedMeasure)).deepEqual(exhaustedMeasure);
    for (const value of boundarySessions)
      should(analytics.AnalyticsRawSessionSchema.safeParse(value).success).be.true();
  });

  it('should reject measures and rates outside their arithmetic bounds', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'known above total', schema: analytics.AnalyticsMeasureSchema, value: { value: 1, known: 5, total: 4 } },
      {
        name: 'fractional known',
        schema: analytics.AnalyticsMeasureSchema,
        value: { value: 1, known: 1.5, total: 4 },
      },
      { name: 'negative total', schema: analytics.AnalyticsMeasureSchema, value: { value: 1, known: 0, total: -1 } },
      {
        name: 'non-finite value',
        schema: analytics.AnalyticsMeasureSchema,
        value: { value: Number.POSITIVE_INFINITY, known: 1, total: 4 },
      },
      { name: 'rate above 100', schema: analytics.AnalyticsRatesSchema, value: { ...rates, failure: 100.1 } },
      { name: 'negative rate', schema: analytics.AnalyticsRatesSchema, value: { ...rates, stall: -0.5 } },
      { name: 'missing rate', schema: analytics.AnalyticsRatesSchema, value: { stall: 0, failure: 0 } },
      {
        name: 'aggregate result with an out-of-range measure',
        schema: analytics.AnalyticsAggregateResultSchema,
        value: { ...aggregateResult, turns: { value: 1, known: 9, total: 4 } },
      },
      {
        name: 'aggregate result with a non-string label value',
        schema: analytics.AnalyticsAggregateResultSchema,
        value: { ...aggregateResult, labels: { agent: 7 } },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject malformed queries, index status, and raw sessions', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'unknown label', schema: analytics.AnalyticsMatcherSchema, value: { ...matcher, label: 'kernel' } },
      { name: 'unknown operator', schema: analytics.AnalyticsMatcherSchema, value: { ...matcher, op: '!=' } },
      { name: 'non-boolean wildcard', schema: analytics.AnalyticsMatcherSchema, value: { ...matcher, wildcard: 'no' } },
      {
        name: 'unknown group-by label',
        schema: analytics.ParsedAnalyticsQuerySchema,
        value: { ...parsedQuery, groupBy: ['agent', 'kernel'] },
      },
      {
        name: 'unknown aggregation',
        schema: analytics.ParsedAnalyticsQuerySchema,
        value: { ...parsedQuery, aggregation: 'median' },
      },
      {
        name: 'zero schema version',
        schema: analytics.AnalyticsIndexStatusSchema,
        value: { ...indexStatus, schemaVersion: 0 },
      },
      {
        name: 'fractional session count',
        schema: analytics.AnalyticsIndexStatusSchema,
        value: { ...indexStatus, sessions: 1.5 },
      },
      {
        name: 'unanchored refresh instant',
        schema: analytics.AnalyticsIndexStatusSchema,
        value: { ...indexStatus, lastTokenRefreshAt: '2026-07-30T12:00:00' },
      },
      { name: 'empty session id', schema: analytics.AnalyticsRawSessionSchema, value: { ...rawSession, id: '' } },
      {
        name: 'negative token count',
        schema: analytics.AnalyticsRawSessionSchema,
        value: { ...rawSession, tokens: -1 },
      },
      {
        name: 'context percent above 100',
        schema: analytics.AnalyticsRawSessionSchema,
        value: { ...rawSession, contextEndPercent: 100.5 },
      },
      {
        name: 'nullable flag',
        schema: analytics.AnalyticsRawSessionSchema,
        value: { ...rawSession, completed: null },
      },
      {
        name: 'fractional context window',
        schema: analytics.AnalyticsRawSessionSchema,
        value: { ...rawSession, contextWindow: 1.5 },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should reject responses that contradict their own scope or aggregation', () => {
    // Arrange
    const cases: SchemaCase[] = [
      {
        name: 'matched above indexed',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...rawResponse, scope: { allSessions: true, indexed: 1, matched: 2 } },
      },
      {
        name: 'partial scope',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...rawResponse, scope: { allSessions: false, indexed: 8, matched: 2 } },
      },
      {
        name: 'aggregation disagreeing with the parsed query',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...aggregateResponse, aggregation: 'avg' },
      },
      {
        name: 'aggregate without a parsed aggregation',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...aggregateResponse, parsed: { groupBy: ['agent'], matchers: [] } },
      },
      {
        name: 'raw carrying an aggregation',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...rawResponse, parsed: { aggregation: 'count', groupBy: [], matchers: [] } },
      },
      {
        name: 'raw with a non-positive limit',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...rawResponse, limit: 0 },
      },
      {
        name: 'unknown response kind',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...rawResponse, kind: 'top' },
      },
      {
        name: 'raw rows under an aggregate kind',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...aggregateResponse, results: [rawSession] },
      },
      {
        name: 'aggregate rows under a raw kind',
        schema: analytics.AnalyticsResponseSchema,
        value: { ...rawResponse, results: [aggregateResult] },
      },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('analytics metrics', () => {
  it('should answer every metric from its measure in the metric unit', () => {
    // Arrange
    const result = analytics.AnalyticsAggregateResultSchema.parse({
      ...aggregateResult,
      equivalentApiCostUsdMicros: { value: 2_500_000, known: 1, total: 1 },
      durationMs: { value: 90_000, known: 1, total: 1 },
      activeDurationMs: { value: 30_000, known: 1, total: 1 },
      reasoningTokens: { value: null, known: 0, total: 1 },
    });

    // Act
    const values = Object.fromEntries(
      analytics.AnalyticsMetricSchema.options.map(metric => [metric, analytics.analyticsMetricValue(result, metric)]),
    );

    // Assert
    should(values.cost_usd).equal(2.5);
    should(values.duration_wall_seconds).equal(90);
    should(values.duration_active_seconds).equal(30);
    should(values.sessions).equal(result.sessions);
    should(values.tokens_reasoning).be.null();
    should(values.tokens).equal(result.tokens.value);
  });

  it('should answer every metric from one raw session row', () => {
    // Arrange
    const row = analytics.AnalyticsRawSessionSchema.parse({ ...rawSession, equivalentApiCostUsdMicros: 1_000_000 });

    // Act
    const values = Object.fromEntries(
      analytics.AnalyticsMetricSchema.options.map(metric => [metric, analytics.analyticsRawMetricValue(row, metric)]),
    );

    // Assert
    should(values.sessions).equal(1);
    should(values.cost_usd).equal(1);
    should(values.duration_active_seconds).equal(600);
    should(analytics.analyticsRawMetricValue({ ...row, activeDurationMs: null }, 'duration_active_seconds')).be.null();
  });

  it('should default the v2 fields an older daemon does not send', () => {
    // Arrange
    const { activeDurationMs: _measure, ...olderAggregate } = aggregateResult;
    const { activeDurationMs: _active, machine: _machine, ...olderRow } = rawSession;

    // Act
    const aggregate = analytics.AnalyticsAggregateResultSchema.parse(olderAggregate);
    const row = analytics.AnalyticsRawSessionSchema.parse(olderRow);

    // Assert
    should(aggregate.activeDurationMs).deepEqual({ value: null, known: 0, total: 0 });
    should(row.activeDurationMs).be.null();
    should(row.machine).be.null();
  });

  it('should refuse an absolute range that does not end after it starts', () => {
    // Arrange
    const instant = '2026-10-01T00:00:00.000Z';

    // Act
    const empty = analytics.AnalyticsRangeSchema.safeParse({ kind: 'absolute', from: instant, to: instant });
    const ordered = analytics.AnalyticsRangeSchema.safeParse({
      kind: 'absolute',
      from: instant,
      to: '2026-10-02T00:00:00.000Z',
    });

    // Assert
    should(empty.success).be.false();
    should(ordered.success).be.true();
  });
});

describe('the per-turn active time metric', () => {
  it('should divide summed active time by summed turns, and say nothing it cannot divide', () => {
    // Arrange
    const result = analytics.AnalyticsAggregateResultSchema.parse({
      ...aggregateResult,
      activeDurationMs: { value: 120_000, known: 2, total: 2 },
      turns: { value: 8, known: 2, total: 2 },
    });

    // Act
    const perTurn = analytics.analyticsMetricValue(result, 'duration_active_seconds_per_turn');
    const noTurns = analytics.analyticsMetricValue(
      { ...result, turns: { value: 0, known: 2, total: 2 } },
      'duration_active_seconds_per_turn',
    );
    const partial = analytics.analyticsMetricValue(
      { ...result, activeDurationMs: { value: null, known: 1, total: 2 } },
      'duration_active_seconds_per_turn',
    );

    // Assert
    should(perTurn).equal(15);
    should(noTurns).be.null();
    should(partial).be.null();
    should(analytics.ANALYTICS_RATIO_METRICS.has('duration_active_seconds_per_turn')).be.true();
  });

  it('should answer one session row from its own active time and turns', () => {
    // Arrange
    const row = analytics.AnalyticsRawSessionSchema.parse({ ...rawSession, activeDurationMs: 90_000, turns: 3 });

    // Act
    const perTurn = analytics.analyticsRawMetricValue(row, 'duration_active_seconds_per_turn');
    const unknown = analytics.analyticsRawMetricValue({ ...row, turns: null }, 'duration_active_seconds_per_turn');

    // Assert
    should(perTurn).equal(30);
    should(unknown).be.null();
  });
});
