import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const AnalyticsAggregationSchema = z.enum(['sum', 'avg', 'min', 'max', 'count']);
export type AnalyticsAggregation = z.infer<typeof AnalyticsAggregationSchema>;

export const AnalyticsLabelSchema = z.enum([
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
]);
export type AnalyticsLabel = z.infer<typeof AnalyticsLabelSchema>;

export const AnalyticsMatcherSchema = z.object({
  label: AnalyticsLabelSchema,
  op: z.enum(['=', '=~']),
  value: z.string(),
  wildcard: z.boolean(),
});
export type AnalyticsMatcher = z.infer<typeof AnalyticsMatcherSchema>;

export const ParsedAnalyticsQuerySchema = z.object({
  source: z.string(),
  canonical: z.string(),
  aggregation: AnalyticsAggregationSchema.optional(),
  groupBy: z.array(AnalyticsLabelSchema),
  matchers: z.array(AnalyticsMatcherSchema),
});
export type ParsedAnalyticsQuery = z.infer<typeof ParsedAnalyticsQuerySchema>;

export const AnalyticsMeasureSchema = z
  .object({
    value: z.number().finite().nullable(),
    known: NonNegativeIntegerSchema,
    total: NonNegativeIntegerSchema,
  })
  .superRefine((value, context) => {
    if (value.known > value.total) {
      context.addIssue({ code: 'custom', message: 'known may not exceed total', path: ['known'] });
    }
  });
export type AnalyticsMeasure = z.infer<typeof AnalyticsMeasureSchema>;

export const AnalyticsRatesSchema = z.object({
  stall: NonNegativeFiniteSchema.max(100),
  failure: NonNegativeFiniteSchema.max(100),
  completion: NonNegativeFiniteSchema.max(100),
});
export type AnalyticsRates = z.infer<typeof AnalyticsRatesSchema>;

export const AnalyticsAggregateResultSchema = z.object({
  labels: z.record(z.string(), z.string().nullable()),
  sessions: NonNegativeIntegerSchema,
  rates: AnalyticsRatesSchema,
  tokens: AnalyticsMeasureSchema,
  inputTokens: AnalyticsMeasureSchema,
  outputTokens: AnalyticsMeasureSchema,
  cachedInputTokens: AnalyticsMeasureSchema,
  cacheWriteInputTokens: AnalyticsMeasureSchema,
  cacheWrite5mInputTokens: AnalyticsMeasureSchema,
  cacheWrite1hInputTokens: AnalyticsMeasureSchema,
  equivalentApiCostUsdMicros: AnalyticsMeasureSchema,
  turns: AnalyticsMeasureSchema,
  durationMs: AnalyticsMeasureSchema,
  timeToFirstOutputMs: AnalyticsMeasureSchema,
  contextEndPercent: AnalyticsMeasureSchema,
});
export type AnalyticsAggregateResult = z.infer<typeof AnalyticsAggregateResultSchema>;

export const AnalyticsRawSessionSchema = z.object({
  id: z.string().min(1),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  contextWindow: NonNegativeIntegerSchema.nullable(),
  harness: z.string().nullable(),
  mode: z.string().nullable(),
  status: z.string().nullable(),
  label: z.string().nullable(),
  cwd: z.string().nullable(),
  parent: z.string().nullable(),
  tree: z.string().nullable().optional(),
  day: z.string().nullable(),
  week: z.string().nullable(),
  createdAt: InstantSchema.nullable(),
  pricingModel: z.string().nullable(),
  equivalentApiCostUsdMicros: z.number().finite().nonnegative().nullable(),
  tokens: z.number().finite().nonnegative().nullable(),
  inputTokens: z.number().finite().nonnegative().nullable(),
  outputTokens: z.number().finite().nonnegative().nullable(),
  cachedInputTokens: z.number().finite().nonnegative().nullable(),
  cacheWriteInputTokens: z.number().finite().nonnegative().nullable(),
  cacheWrite5mInputTokens: z.number().finite().nonnegative().nullable(),
  cacheWrite1hInputTokens: z.number().finite().nonnegative().nullable(),
  turns: z.number().finite().nonnegative().nullable(),
  durationMs: z.number().finite().nonnegative().nullable(),
  timeToFirstOutputMs: z.number().finite().nonnegative().nullable(),
  contextEndPercent: z.number().finite().min(0).max(100).nullable(),
  stalled: z.boolean(),
  failed: z.boolean(),
  migrated: z.boolean(),
  completed: z.boolean(),
});
export type AnalyticsRawSession = z.infer<typeof AnalyticsRawSessionSchema>;

export const AnalyticsIndexStatusSchema = z.object({
  schemaVersion: z.number().int().positive(),
  sessions: NonNegativeIntegerSchema,
  tokenSessions: NonNegativeIntegerSchema,
  transcriptSources: NonNegativeIntegerSchema,
  indexedTranscriptSources: NonNegativeIntegerSchema,
  pendingTranscriptSources: NonNegativeIntegerSchema,
  sourceErrors: NonNegativeIntegerSchema,
  refreshing: z.boolean(),
  lastTokenRefreshAt: InstantSchema.optional(),
});
export type AnalyticsIndexStatus = z.infer<typeof AnalyticsIndexStatusSchema>;

const AnalyticsResponseBaseShape = {
  query: z.string(),
  parsed: z.object({
    aggregation: AnalyticsAggregationSchema.optional(),
    groupBy: z.array(AnalyticsLabelSchema),
    matchers: z.array(AnalyticsMatcherSchema),
  }),
  scope: z.object({
    allSessions: z.literal(true),
    indexed: NonNegativeIntegerSchema,
    matched: NonNegativeIntegerSchema,
  }),
  index: AnalyticsIndexStatusSchema,
};

export const AnalyticsResponseSchema = z
  .discriminatedUnion('kind', [
    z.object({
      ...AnalyticsResponseBaseShape,
      kind: z.literal('aggregate'),
      aggregation: AnalyticsAggregationSchema,
      results: z.array(AnalyticsAggregateResultSchema),
    }),
    z.object({
      ...AnalyticsResponseBaseShape,
      kind: z.literal('raw'),
      limit: PositiveIntegerSchema,
      truncated: z.boolean(),
      results: z.array(AnalyticsRawSessionSchema),
    }),
  ])
  .superRefine((value, context) => {
    if (value.scope.matched > value.scope.indexed) {
      context.addIssue({ code: 'custom', message: 'matched may not exceed indexed', path: ['scope', 'matched'] });
    }
    if (value.kind === 'aggregate' && value.parsed.aggregation !== value.aggregation) {
      context.addIssue({ code: 'custom', message: 'parsed aggregation must match aggregation', path: ['parsed'] });
    }
    if (value.kind === 'raw' && value.parsed.aggregation !== undefined) {
      context.addIssue({ code: 'custom', message: 'raw responses may not carry an aggregation', path: ['parsed'] });
    }
  });
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;
