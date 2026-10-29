/**
 * The Warden's numbers: a period switch, five flat tiles, a line per layer and a seven-day chart.
 * Render-only — `warden-stats-model.ts` owns every figure.
 */

import type { WardenStatusView } from '@ferretry/protocol';
import { useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { AnalyticsMetricChart } from '../analytics/analytics-metric-chart.tsx';
import { ActorMark } from './warden-chips.tsx';
import {
  CHART_SERIES,
  hasHistory,
  layerLines,
  PERIOD_LABEL,
  type StatTile,
  type WardenPeriod,
  wardenDayChart,
  wardenStats,
  wholeNumberTicks,
} from './warden-stats-model.ts';

const PERIODS: readonly WardenPeriod[] = ['today', 'week'];

function Tile({ tile }: { readonly tile: StatTile }) {
  return (
    <div className="flex min-w-0 flex-col gap-xs px-cell-x py-row-y" data-stat={tile.key}>
      <span className="text-meta text-muted">
        {tile.label}
        {tile.qualifier === 'recent' && <span className="text-faint"> (recent)</span>}
      </span>
      <span
        className="text-title font-semibold leading-none text-fg [font-variant-numeric:tabular-nums]"
        role="img"
        aria-label={`${tile.label}: ${tile.value ?? 'no record'}`}
      >
        {tile.value ?? '—'}
      </span>
      {tile.sub !== undefined ? (
        <span className="text-meta leading-base text-muted">{tile.sub}</span>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
          {tile.split.map(entry => (
            <ActorMark key={entry.actor} actor={entry.actor} label={`${entry.label} ${entry.count}`} />
          ))}
        </span>
      )}
    </div>
  );
}

export function WardenStatsPanel({ status, now }: { readonly status: WardenStatusView; readonly now: number }) {
  const [period, setPeriod] = useState<WardenPeriod>('today');
  const history = hasHistory(status);
  const stats = wardenStats(status, history ? period : 'today', now);
  const lines = layerLines(status);
  const chart = wardenDayChart(status, now);
  return (
    <section aria-label="Warden stats" className="flex min-w-0 flex-col gap-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        {history ? (
          <div
            aria-label="Stats period"
            role="toolbar"
            className="flex rounded-control border border-border bg-surface p-0.5"
          >
            {PERIODS.map(key => (
              <button
                key={key}
                type="button"
                aria-pressed={period === key}
                className="kt-tab !px-sm !min-h-8 !min-w-0 sm:!min-h-0"
                onClick={() => setPeriod(key)}
              >
                {PERIOD_LABEL[key]}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-meta text-muted">Recent activity</span>
        )}
        {stats.coverage !== undefined && <span className="text-meta text-faint">{stats.coverage}</span>}
      </div>
      <div
        className="grid grid-cols-2 divide-border-soft rounded-control bg-surface-2 sm:grid-cols-5 sm:divide-x"
        data-warden-tiles={stats.source}
      >
        {stats.tiles.map(tile => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </div>
      {lines.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-sm p-0">
          {lines.map(line => (
            <li key={line.key} className="flex min-w-0 flex-col gap-xs" data-layer={line.key}>
              <p className="m-0 flex flex-wrap items-baseline gap-x-sm text-cell leading-base">
                <b className="font-semibold text-fg">{line.name}</b>
                <span className={line.warn ? 'text-warn' : 'text-fg-soft'}>{line.summary}</span>
                {line.clause !== undefined && <span className="text-meta text-faint">{line.clause}</span>}
              </p>
              {line.ratio !== undefined && (
                <div
                  role="progressbar"
                  aria-label={`${line.name} spend today`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(line.ratio * 100)}
                  className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
                >
                  <div
                    className={cn('h-full rounded-full', line.warn ? 'bg-warn' : 'bg-accent')}
                    style={{ width: `${Math.round(line.ratio * 100)}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {chart !== undefined && (
        <div className="flex min-w-0 flex-col gap-xs">
          <AnalyticsMetricChart
            title="Actions per day"
            series={CHART_SERIES}
            points={chart.points}
            format={value => String(value)}
            axisTicks={wholeNumberTicks}
            emptyText="No actions this week."
            plotClassName="h-28 sm:h-32"
            resting="last"
          />
          {chart.missing > 0 && (
            <p className="m-0 text-meta text-faint">
              A day marked <span className="mono">?</span> has no record; it is not a quiet day.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
