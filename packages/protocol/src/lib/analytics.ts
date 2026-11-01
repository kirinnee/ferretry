import { z } from 'zod';
import { InstantSchema, NonNegativeFiniteSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const AnalyticsAggregationSchema = z.enum(['sum', 'avg', 'min', 'max', 'count']);
export type AnalyticsAggregation = z.infer<typeof AnalyticsAggregationSchema>;

export const AnalyticsLabelSchema = z.enum([
  'id',
  'agent',
  'model',
  // The model a transcript was PRICED against, which is not always the model a person selected: a
  // selector spelling and a transcript spelling disagree often enough that grouping cost by `model`
  // silently attributes it to the wrong row.
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
  // The v2 vocabulary. Each is a NAME for a fact the row already carries, chosen so a query reads the
  // way the Insights page talks: `runtime` is the session's `agent`, `project` is `repo`, `session`
  // is `id`. `machine` is new evidence — the daemon that answered — and is stamped at query time.
  'runtime',
  'project',
  'session',
  'machine',
]);
export type AnalyticsLabel = z.infer<typeof AnalyticsLabelSchema>;

/**
 * The quantity a query is about. Exactly one measure of the aggregate result answers each, through
 * `ANALYTICS_METRIC_MEASURES`; the unit is the metric's own (USD, seconds, a count), never the
 * measure's storage unit. Definitions: docs/insights-query.md.
 */
export const AnalyticsMetricSchema = z.enum([
  'tokens',
  'tokens_input',
  'tokens_output',
  'tokens_cache_read',
  'tokens_cache_write',
  'tokens_reasoning',
  'cost_usd',
  // The same tokens re-priced at the catalog's CURRENT rates, where `cost_usd` is what the rate in
  // force when each session ran made them cost.
  'cost_now_usd',
  'turns',
  'sessions',
  'duration_active_seconds',
  'duration_wall_seconds',
  // A RATIO OF SUMS — Σ active time ÷ Σ turns over the group — never an average of per-session
  // ratios, which would weigh a one-turn session the same as a hundred-turn one.
  'duration_active_seconds_per_turn',
]);

/**
 * Metrics that are a ratio of two measures. Only `sum` and `avg` answer them, and both give the same
 * number: avg(a) ÷ avg(b) and sum(a) ÷ sum(b) agree whenever both are known for every session.
 */
export const ANALYTICS_RATIO_METRICS: ReadonlySet<AnalyticsMetric> = new Set<AnalyticsMetric>([
  'duration_active_seconds_per_turn',
]);
export type AnalyticsMetric = z.infer<typeof AnalyticsMetricSchema>;

/**
 * Which sessions a query reads, by creation instant.
 *
 * RELATIVE is a rolling window ending when the daemon answers (`[7d]` = the last 7 × 24 h). ABSOLUTE
 * is half-open, `from` inclusive and `to` exclusive, so two adjacent ranges never count a session
 * twice; the date spelling `[2026-10-01..2026-10-20]` includes the whole of its last day.
 */
export const AnalyticsRangeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('relative'), seconds: PositiveIntegerSchema }),
    z.object({ kind: z.literal('absolute'), from: InstantSchema, to: InstantSchema }),
  ])
  .superRefine((value, context) => {
    if (value.kind === 'absolute' && !(Date.parse(value.from) < Date.parse(value.to))) {
      context.addIssue({ code: 'custom', message: 'range must end after it starts', path: ['to'] });
    }
  });
export type AnalyticsRange = z.infer<typeof AnalyticsRangeSchema>;

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
  metric: AnalyticsMetricSchema.optional(),
  groupBy: z.array(AnalyticsLabelSchema),
  matchers: z.array(AnalyticsMatcherSchema),
  range: AnalyticsRangeSchema.optional(),
});
export type ParsedAnalyticsQuery = z.infer<typeof ParsedAnalyticsQuerySchema>;

export const AnalyticsMeasureSchema = z
  .object({
    value: z.number().finite().nullable(),
    known: NonNegativeIntegerSchema,
    total: NonNegativeIntegerSchema,
    /**
     * A `sum`'s lower bound: the total of the sessions that stated a figure, present only when some
     * did not (`value` is then null, because a partial sum is not the group's total). A reader shows it
     * as "at least", never as the value. Absent from a daemon older than this field and from complete or
     * non-sum measures.
     */
    knownSum: z.number().finite().nonnegative().optional(),
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
  /**
   * Reasoning tokens, which are billed at their own rate.
   *
   * REQUIRED, because this is now a fact the contract OWNS. It was optional while nothing folded the
   * figure and a responder had to be able to say "I cannot count these at all" — but a build that
   * counts them and still admits omission leaves every reader writing a fallback for a case that can
   * no longer happen. Unknown is said with `{ value: null }`, a measure that was attempted and came
   * back empty, which is what a session whose harness names no reasoning figure produces.
   */
  reasoningTokens: AnalyticsMeasureSchema,
  equivalentApiCostUsdMicros: AnalyticsMeasureSchema,
  /**
   * The same sessions' tokens priced at the catalog's current rates, in USD micros. DEFAULTED on read
   * for the reason `activeDurationMs` is: an older daemon says nothing about it, which is a measure
   * with no evidence and never a zero.
   */
  equivalentApiCostCurrentUsdMicros: AnalyticsMeasureSchema.default({ value: null, known: 0, total: 0 }),
  turns: AnalyticsMeasureSchema,
  /** Wall time: session finish − session start, in milliseconds. */
  durationMs: AnalyticsMeasureSchema,
  /**
   * Active time: Σ over the session's turns of (last record − prompt), in milliseconds, from the
   * transcript's own timestamps. DEFAULTED on read, not required: a daemon older than this field
   * answers without it, and a merged fleet view must still parse that machine's answer — as a measure
   * with no evidence (`known: 0, total: 0`), never as a zero.
   */
  activeDurationMs: AnalyticsMeasureSchema.default({ value: null, known: 0, total: 0 }),
  timeToFirstOutputMs: AnalyticsMeasureSchema,
  contextEndPercent: AnalyticsMeasureSchema,
  /**
   * Why the sessions without a cost have none: a count per reason (a pricing reason such as
   * `unknown_pricing_model`, or a transcript refusal such as `transcript_damaged`). Sums to the group's
   * `equivalentApiCostUsdMicros.total - known`. Absent from an older daemon, and empty-or-absent when
   * every session is priced.
   */
  costGaps: z.record(z.string(), PositiveIntegerSchema).optional(),
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
  /**
   * This session's tokens priced at the catalog's current rates, stamped when the query ran and never
   * stored. Null when the session has no token evidence or the catalog holds no current rate for its
   * model; absent from a daemon older than this field.
   */
  equivalentApiCostCurrentUsdMicros: z.number().finite().nonnegative().nullable().optional(),
  tokens: z.number().finite().nonnegative().nullable(),
  inputTokens: z.number().finite().nonnegative().nullable(),
  outputTokens: z.number().finite().nonnegative().nullable(),
  cachedInputTokens: z.number().finite().nonnegative().nullable(),
  cacheWriteInputTokens: z.number().finite().nonnegative().nullable(),
  cacheWrite5mInputTokens: z.number().finite().nonnegative().nullable(),
  cacheWrite1hInputTokens: z.number().finite().nonnegative().nullable(),
  /**
   * The part of `outputTokens` a harness named as reasoning, or null when it named none.
   *
   * A SUBSET, NOT AN ADDITION: it is already counted in `outputTokens` and in `tokens`, exactly as
   * `cachedInputTokens` is already counted in `inputTokens`. Null is not zero — a harness that
   * reports no reasoning figure has said nothing, and a stated zero says the session did none.
   */
  reasoningTokens: z.number().finite().nonnegative().nullable(),
  /**
   * Why this session has no cost (see `costGaps` on the aggregate); absent when it has one, and from a
   * daemon older than this field, which reads as "no reason given", never as "priced".
   */
  costGap: z.string().nullable().optional(),
  turns: z.number().finite().nonnegative().nullable(),
  durationMs: z.number().finite().nonnegative().nullable(),
  /** See the aggregate measure. Defaulted on read for the same older-daemon reason. */
  activeDurationMs: z.number().finite().nonnegative().nullable().default(null),
  /** The daemon that answered for this row, stamped when the query ran. Defaulted for older daemons. */
  machine: z.string().nullable().default(null),
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
    metric: AnalyticsMetricSchema.optional(),
    groupBy: z.array(AnalyticsLabelSchema),
    matchers: z.array(AnalyticsMatcherSchema),
    range: AnalyticsRangeSchema.optional(),
  }),
  scope: z.object({
    allSessions: z.literal(true),
    indexed: NonNegativeIntegerSchema,
    matched: NonNegativeIntegerSchema,
    /**
     * The instants a range resolved to when the daemon answered, half-open. Present exactly when the
     * query carried a range, so a relative `[7d]` can be drawn on an axis without guessing the clock.
     */
    window: z.object({ from: InstantSchema, to: InstantSchema }).optional(),
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

/** Every aggregate measure field, derived from the schema so a new measure cannot be missed. */
export type AnalyticsMeasureKey = {
  [K in keyof AnalyticsAggregateResult]-?: NonNullable<AnalyticsAggregateResult[K]> extends AnalyticsMeasure
    ? K
    : never;
}[keyof AnalyticsAggregateResult];

/**
 * Which result field answers each metric, and the factor that turns its stored unit into the metric's.
 *
 * `sessions` is the group's session count rather than a measure, so it has no measure key. A ratio
 * metric names its denominator in `per`. A MAPPED TYPE over the metric enum: a metric the grammar
 * grows without an answer here is a compile error.
 */
export const ANALYTICS_METRIC_MEASURES: {
  readonly [M in AnalyticsMetric]: {
    readonly measure: AnalyticsMeasureKey | 'sessions';
    readonly per?: AnalyticsMeasureKey;
    readonly scale: number;
  };
} = {
  tokens: { measure: 'tokens', scale: 1 },
  tokens_input: { measure: 'inputTokens', scale: 1 },
  tokens_output: { measure: 'outputTokens', scale: 1 },
  tokens_cache_read: { measure: 'cachedInputTokens', scale: 1 },
  tokens_cache_write: { measure: 'cacheWriteInputTokens', scale: 1 },
  tokens_reasoning: { measure: 'reasoningTokens', scale: 1 },
  cost_usd: { measure: 'equivalentApiCostUsdMicros', scale: 1e-6 },
  cost_now_usd: { measure: 'equivalentApiCostCurrentUsdMicros', scale: 1e-6 },
  turns: { measure: 'turns', scale: 1 },
  sessions: { measure: 'sessions', scale: 1 },
  duration_active_seconds: { measure: 'activeDurationMs', scale: 1e-3 },
  duration_wall_seconds: { measure: 'durationMs', scale: 1e-3 },
  duration_active_seconds_per_turn: { measure: 'activeDurationMs', per: 'turns', scale: 1e-3 },
};

/** `numerator ÷ denominator × scale`, or null when either is unknown or there is nothing to divide by. */
function ratio(numerator: number | null, denominator: number | null, scale: number): number | null {
  return numerator === null || denominator === null || denominator === 0 ? null : (numerator / denominator) * scale;
}

/** One aggregate row's value for a metric, in the metric's unit, or `null` when it is not known. */
export function analyticsMetricValue(result: AnalyticsAggregateResult, metric: AnalyticsMetric): number | null {
  const { measure, per, scale } = ANALYTICS_METRIC_MEASURES[metric];
  if (measure === 'sessions') return result.sessions;
  if (per !== undefined) {
    // Both sides must speak for the same sessions: a numerator covering fewer sessions than its
    // denominator (an older machine that sent no active time) would divide part by whole.
    if (result[measure].total !== result[per].total) return null;
    return ratio(result[measure].value, result[per].value, scale);
  }
  // A measure a machine did not send (one older than the today-price figure) is unknown, never zero.
  const value = (result[measure] as AnalyticsMeasure | undefined)?.value ?? null;
  return value === null ? null : value * scale;
}

/** The raw-row field that answers each metric, in its stored unit; `sessions` is one per row. */
const RAW_METRIC_FIELDS = {
  tokens: 'tokens',
  tokens_input: 'inputTokens',
  tokens_output: 'outputTokens',
  tokens_cache_read: 'cachedInputTokens',
  tokens_cache_write: 'cacheWriteInputTokens',
  tokens_reasoning: 'reasoningTokens',
  cost_usd: 'equivalentApiCostUsdMicros',
  cost_now_usd: 'equivalentApiCostCurrentUsdMicros',
  turns: 'turns',
  sessions: null,
  duration_active_seconds: 'activeDurationMs',
  duration_wall_seconds: 'durationMs',
  duration_active_seconds_per_turn: 'activeDurationMs',
} as const satisfies { readonly [M in AnalyticsMetric]: keyof AnalyticsRawSession | null };

/** One session row's value for a metric, in the metric's unit, or `null` when it is not known. */
export function analyticsRawMetricValue(row: AnalyticsRawSession, metric: AnalyticsMetric): number | null {
  const field = RAW_METRIC_FIELDS[metric];
  if (field === null) return 1;
  const value = row[field] ?? null;
  if (ANALYTICS_RATIO_METRICS.has(metric)) return ratio(value, row.turns, ANALYTICS_METRIC_MEASURES[metric].scale);
  return value === null ? null : value * ANALYTICS_METRIC_MEASURES[metric].scale;
}
