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
  equivalentApiCostUsdMicros: measure,
  turns: measure,
  durationMs: measure,
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
  turns: 12,
  durationMs: 900_000,
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
    ];

    // Act
    const parsedLabels = analytics.ParsedAnalyticsQuerySchema.parse({ ...parsedQuery, groupBy: labels }).groupBy;

    // Assert
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
