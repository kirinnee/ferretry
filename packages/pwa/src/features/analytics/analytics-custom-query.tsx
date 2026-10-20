/**
 * THE QUERY EDITOR — the text box, its helpers and the inline parse error.
 *
 * The text is the source of truth: the metric picker, aggregation picker, range chips and group-by
 * chips all rewrite it through the protocol grammar (`analytics-query-text.ts`), and typing in it
 * moves the helpers. A text the grammar rejects shows the parser's own sentence under the box and
 * switches the helpers off rather than guessing what was meant.
 */

import {
  ANALYTICS_RATIO_METRICS,
  type AnalyticsAggregation,
  AnalyticsAggregationSchema,
  type AnalyticsLabel,
  type AnalyticsMetric,
  AnalyticsMetricSchema,
  type AnalyticsResponse,
} from '@ferretry/protocol';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useId, useMemo } from 'react';

import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import { AnalyticsQueryAutocomplete } from './analytics-query-autocomplete.tsx';
import { ANALYTICS_RANGE_PRESETS } from './analytics-query-complete.ts';
import {
  activeRangeSource,
  readAnalyticsQuery,
  toggleGroupLabel,
  withAggregation,
  withMetric,
  withRange,
} from './analytics-query-text.ts';
import { ANALYTICS_METRIC_LABELS } from './analytics-result-table.tsx';

/** One analytics read against exactly the supplied daemon; the host decides how it travels. */
export type AnalyticsRequest = (daemon: DaemonConnection, query?: string) => Promise<AnalyticsResponse>;

/** The query the page opens with, and the box's placeholder. */
export const ANALYTICS_QUERY_DEFAULT = 'sum(cost_usd) by (model) [7d]';

/** The labels offered as one-click grouping chips; a subset of the protocol's, typed so it stays valid. */
export const ANALYTICS_GROUP_HELPERS: readonly AnalyticsLabel[] = [
  'runtime',
  'model',
  'harness',
  'machine',
  'project',
  'session',
  'day',
  'week',
];

const NO_METRIC = '';

export interface AnalyticsQueryEditorProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onRun: () => void;
  readonly querying: boolean;
  readonly loadValues: (label: string) => Promise<readonly string[]>;
}

export function AnalyticsQueryEditor({ value, onValueChange, onRun, querying, loadValues }: AnalyticsQueryEditorProps) {
  const queryId = useId();
  const treeIds = useMemo(() => [], []);
  const read = useMemo(() => readAnalyticsQuery(value), [value]);
  const parsed = read.ok ? read.parsed : undefined;
  const showError = !read.ok && value.trim() !== '';
  const range = activeRangeSource(value, ANALYTICS_RANGE_PRESETS);
  const ratio = parsed?.metric !== undefined && ANALYTICS_RATIO_METRICS.has(parsed.metric);

  return (
    <div className="grid min-w-0 gap-3" data-analytics-query-editor="">
      <form
        className="flex min-w-0 gap-2"
        onSubmit={event => {
          event.preventDefault();
          onRun();
        }}
      >
        <label htmlFor={queryId} className="sr-only">
          Analytics query
        </label>
        <AnalyticsQueryAutocomplete
          inputId={queryId}
          value={value}
          onValueChange={onValueChange}
          onRun={onRun}
          disabled={querying}
          sources={{ treeIds }}
          loadValues={loadValues}
          placeholder={ANALYTICS_QUERY_DEFAULT}
        />
        <Button type="submit" variant="primary" disabled={querying || showError} className="min-h-[44px] shrink-0">
          {querying ? (
            <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            'Run'
          )}
          {querying && <span className="sr-only">Running query</span>}
        </Button>
      </form>

      {showError && (
        <p
          role="alert"
          data-analytics-parse-error=""
          className="m-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-cell text-err"
        >
          {read.ok ? '' : read.error}
        </p>
      )}

      <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-2 border-0 p-0 sm:grid-cols-2">
        <legend className="sr-only">Query helpers</legend>
        <label className="grid min-w-0 gap-xs text-meta text-muted">
          Metric
          <select
            className="kt-input min-h-[44px] w-full"
            disabled={!parsed}
            value={parsed?.metric ?? NO_METRIC}
            onChange={event => {
              const next = event.currentTarget.value;
              onValueChange(withMetric(value, next === NO_METRIC ? undefined : (next as AnalyticsMetric)));
            }}
          >
            <option value={NO_METRIC}>Every measure</option>
            {AnalyticsMetricSchema.options.map(metric => (
              <option key={metric} value={metric}>
                {ANALYTICS_METRIC_LABELS[metric]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-xs text-meta text-muted">
          Aggregation
          <select
            className="kt-input min-h-[44px] w-full"
            disabled={!parsed}
            value={parsed?.aggregation ?? ''}
            onChange={event => onValueChange(withAggregation(value, event.currentTarget.value as AnalyticsAggregation))}
          >
            {!parsed?.aggregation && <option value="">Raw sessions</option>}
            {AnalyticsAggregationSchema.options.map(aggregation => (
              <option
                key={aggregation}
                value={aggregation}
                disabled={ratio && aggregation !== 'sum' && aggregation !== 'avg'}
              >
                {aggregation}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <ChipRow label="Range">
        {ANALYTICS_RANGE_PRESETS.map(preset => (
          <Chip
            key={preset}
            pressed={range === preset}
            disabled={!parsed}
            onClick={() => onValueChange(withRange(value, range === preset ? undefined : preset))}
          >
            {preset}
          </Chip>
        ))}
      </ChipRow>

      <ChipRow label="Group by">
        {ANALYTICS_GROUP_HELPERS.map(label => (
          <Chip
            key={label}
            pressed={parsed?.groupBy.includes(label) ?? false}
            disabled={!parsed}
            onClick={() => onValueChange(toggleGroupLabel(value, label))}
          >
            {label}
          </Chip>
        ))}
      </ChipRow>
    </div>
  );
}

function ChipRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-xs border-0 p-0">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="w-16 shrink-0 text-meta text-muted">
        {label}
      </span>
      {children}
    </fieldset>
  );
}

function Chip({
  pressed,
  disabled,
  onClick,
  children,
}: {
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      data-variant={pressed ? undefined : 'ghost'}
      className={cn('kt-btn kt-btn--sm min-h-[44px] min-w-[44px]', pressed ? 'text-accent' : 'text-muted')}
    >
      {children}
    </button>
  );
}
