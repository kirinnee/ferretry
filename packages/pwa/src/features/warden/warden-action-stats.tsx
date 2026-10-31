/**
 * Warden actions by who decided them: revives today / 7 / 30 days, whether they took, and a fourteen-day
 * stacked chart. Render-only — `warden-action-stats-model.ts` owns every figure.
 */

import type { WardenStatusView } from '@ferretry/protocol';
import { useState } from 'react';
import { AnalyticsMetricChart } from '../analytics/analytics-metric-chart.tsx';
import {
  ACTION_CHART_DAYS,
  type ActionFilterKey,
  type ReviveSpan,
  type ReviveSuccess,
  wardenActionChart,
  wardenActionStats,
  wholeNumberTicks,
} from './warden-action-stats-model.ts';
import { ActorMark } from './warden-chips.tsx';
import { CHART_SERIES } from './warden-stats-model.ts';

function SpanTile({ span }: { readonly span: ReviveSpan }) {
  return (
    <div className="flex min-w-0 flex-col gap-xs px-cell-x py-row-y" data-revive-span={span.key}>
      <span className="text-meta text-muted">{span.label}</span>
      <span
        className="text-title font-semibold leading-none text-fg [font-variant-numeric:tabular-nums]"
        role="img"
        aria-label={`Revives ${span.label}: ${span.total ?? 'not recorded'}`}
      >
        {span.total ?? '—'}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
        {span.split.map(entry => (
          <ActorMark key={entry.actor} actor={entry.actor} label={`${entry.label} ${entry.count}`} />
        ))}
      </span>
      {span.coverage !== undefined && <span className="text-meta leading-base text-faint">{span.coverage}</span>}
    </div>
  );
}

function SuccessLine({ success }: { readonly success: ReviveSuccess }) {
  return (
    <div className="flex min-w-0 flex-col gap-xs" data-revive-success={success.percent}>
      <p className="m-0 flex flex-wrap items-baseline gap-x-sm text-cell leading-base">
        <b className="font-semibold text-fg">Revives that took</b>
        <span
          className="text-fg [font-variant-numeric:tabular-nums]"
          role="img"
          aria-label={`Revive success rate: ${success.rate === null ? 'not known yet' : success.percent}`}
        >
          {success.percent}
        </span>
        <span className="text-fg-soft">{success.sentence}</span>
      </p>
      {success.byActor.length > 0 && (
        <p className="m-0 text-meta leading-base text-faint [font-variant-numeric:tabular-nums]">
          {success.byActor.join(' · ')}
        </p>
      )}
    </div>
  );
}

export function WardenActionStats({ status, now }: { readonly status: WardenStatusView; readonly now: number }) {
  const [filter, setFilter] = useState<ActionFilterKey>('revived');
  const stats = wardenActionStats(status, now);
  const chart = wardenActionChart(status, now, filter);
  if (!stats.recorded || chart === undefined) return null;
  return (
    <section aria-label="Warden actions" className="flex min-w-0 flex-col gap-md" data-warden-action-stats>
      <h3 className="m-0 text-cell font-semibold text-fg">Revives</h3>
      <div className="grid grid-cols-3 divide-border-soft rounded-control bg-surface-2 divide-x">
        {stats.revives.map(span => (
          <SpanTile key={span.key} span={span} />
        ))}
      </div>
      <SuccessLine success={stats.success} />
      <div className="flex min-w-0 flex-col gap-xs">
        <div aria-label="Action shown" role="toolbar" className="flex flex-wrap gap-xs">
          {chart.filters.map(option => (
            <button
              key={option.key}
              type="button"
              aria-pressed={filter === option.key}
              className="kt-tab !px-sm !min-h-8 !min-w-0 sm:!min-h-0"
              onClick={() => setFilter(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <AnalyticsMetricChart
          title={chart.title}
          series={CHART_SERIES}
          points={chart.points}
          format={value => String(value)}
          axisTicks={wholeNumberTicks}
          emptyText={`Nothing done in ${ACTION_CHART_DAYS} days.`}
          plotClassName="h-28 sm:h-32"
          resting="last"
        />
        {chart.missing > 0 && (
          <p className="m-0 text-meta text-faint">
            A day marked <span className="mono">?</span> was not tallied; it is not a quiet day.
          </p>
        )}
      </div>
    </section>
  );
}
