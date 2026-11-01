/**
 * ONE BAR CHART for any analytics metric: equivalent cost, tokens, turns, durations — per day, per week
 * or per group — on one labelled axis. The Overview draws it over a period; the Query page draws a
 * result with it.
 *
 * What it keeps honest:
 *
 * - A KNOWN ZERO IS DRAWN AS ZERO — a hairline on the baseline — never as a gap.
 * - A POINT THAT IS A LOWER BOUND (unpriced sessions, a day only partly listed) carries a hatched warning
 *   cap, so its height reads as "at least".
 * - NO LABEL IS CLIPPED. The plot is inset by half a label at the top and the y axis is as wide as its
 *   widest tick, so the top tick and a four-digit amount both stay inside the figure.
 * - THE TEXT USES TEXT TOKENS. Axis labels are `muted`, never a series colour.
 *
 * Several series stack, in the order given, bottom first. Bars are plain HTML boxes so the plot stretches
 * to any width while the labels keep their size. Hovering a bar shows its figures in the readout line;
 * the same figures are in a table for screen readers.
 */

import { useState } from 'react';

import { analyticsAxisTicks } from './analytics-overview.ts';

/** A series colour, drawn from theme tokens only. */
export type MetricChartTone = 'accent' | 'ok' | 'pend' | 'info';

const TONE_CLASS: Readonly<Record<MetricChartTone, string>> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  pend: 'bg-pend',
  info: 'bg-syn-type',
};

export interface MetricChartSeries {
  readonly key: string;
  readonly label: string;
  readonly tone: MetricChartTone;
}

export interface MetricChartPoint {
  /** Unique within the chart: a day, a week or a group's value. */
  readonly key: string;
  /** The x-axis label. */
  readonly label: string;
  /** One value per series, in the series' order, in display units. */
  readonly values: readonly number[];
  /** The value is a lower bound: drawn with a hatched cap. */
  readonly flagged?: boolean;
  /** A known zero — nothing happened — drawn as a hairline. */
  readonly empty?: boolean;
  /** The hover readout; defaults to "label · total". */
  readonly readout?: string;
}

export interface MetricChartProps {
  readonly title: string;
  readonly series: readonly MetricChartSeries[];
  readonly points: readonly MetricChartPoint[];
  /** A full value, for the readout and the screen-reader table. */
  readonly format: (value: number) => string;
  /** A y-axis tick; defaults to `format`. */
  readonly formatAxis?: (value: number) => string;
  /** What the hatch means; shown only when a point is flagged. */
  readonly flagNote?: string;
  /** The readout when every value is zero. */
  readonly emptyText?: string;
  /** Round ticks from zero to at least the largest total; defaults to a 1-2-2.5-5 decimal step. */
  readonly axisTicks?: (max: number) => readonly number[];
  /** The plot's height classes; defaults to the Overview's `h-40 sm:h-48`. */
  readonly plotClassName?: string;
  /**
   * What the readout shows, and which bar is drawn at full strength, while nothing is hovered:
   * `peak` (default) the tallest point, with the others dimmed; `last` the newest point, with no bar
   * dimmed, so nothing looks selected until it is hovered.
   */
  readonly resting?: 'peak' | 'last';
  /**
   * Name every bar, upright reading turned on its side and ended in an ellipsis. For long category
   * names (a model id), which a flat label can only fit by running into its neighbours.
   */
  readonly rotateLabels?: boolean;
}

const HATCH = 'repeating-linear-gradient(135deg, var(--warn) 0 2px, transparent 2px 4px)';

/**
 * Which x labels to print: every `every`-th point counted back from the last, so the newest point is
 * always labelled and no two labels are closer than `every` bars.
 */
export const chartLabelKeys = (points: readonly MetricChartPoint[], every: number): ReadonlySet<string> =>
  new Set(points.filter((_, index) => (points.length - 1 - index) % every === 0).map(point => point.key));

const pointTotal = (point: MetricChartPoint): number => point.values.reduce((sum, value) => sum + value, 0);

function XLabels({
  points,
  every,
  className,
  rotated = false,
}: {
  readonly points: readonly MetricChartPoint[];
  readonly every: number;
  readonly className: string;
  readonly rotated?: boolean;
}) {
  const shown = chartLabelKeys(points, every);
  return (
    <div aria-hidden="true" className={className}>
      {points.map((point, index) => (
        // A thinned axis lets a label spill over its unlabelled neighbours; a full one (every bar named,
        // as a by-model result is) keeps each label to its own bar and ends it in an ellipsis. The end
        // labels align inward either way, so the last never pushes the page sideways.
        <span
          key={point.key}
          data-chart-xlabel={point.key}
          title={rotated ? point.label : undefined}
          className={`mono min-w-0 flex-1 ${rotated ? 'h-24 rotate-180 truncate text-left [writing-mode:vertical-rl]' : every === 1 ? 'truncate' : 'flex whitespace-nowrap'} ${index === 0 ? 'justify-start text-left' : index === points.length - 1 ? 'justify-end text-right' : 'justify-center text-center'}`}
        >
          {shown.has(point.key) ? point.label : ''}
        </span>
      ))}
    </div>
  );
}

export function AnalyticsMetricChart({
  title,
  series,
  points,
  format,
  formatAxis = format,
  flagNote,
  emptyText = 'Nothing in this period.',
  axisTicks = analyticsAxisTicks,
  plotClassName = 'h-40 sm:h-48',
  resting = 'peak',
  rotateLabels = false,
}: MetricChartProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const totals = new Map(points.map(point => [point.key, pointTotal(point)]));
  const ticks = axisTicks(Math.max(0, ...totals.values()));
  const top = ticks.at(-1)!;
  const peak = points.reduce<MetricChartPoint | null>(
    (best, point) => (totals.get(point.key)! > (best === null ? 0 : totals.get(best.key)!) ? point : best),
    null,
  );
  const focus = points.find(point => point.key === hovered) ?? (resting === 'last' ? (points.at(-1) ?? null) : peak);
  const dimOthers = resting === 'peak' || hovered !== null;
  const flagged = points.some(point => point.flagged === true);
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const readout = (point: MetricChartPoint): string =>
    point.readout ?? `${point.label} · ${format(totals.get(point.key)!)}`;

  return (
    <figure className="m-0 grid min-w-0 gap-sm" data-analytics-chart="">
      <figcaption className="flex flex-wrap items-center justify-between gap-x-md gap-y-xs">
        <span className="text-cell font-semibold text-fg">{title}</span>
        <span className="flex flex-wrap items-center gap-x-md gap-y-xs text-meta text-muted">
          {series.length > 1 &&
            series.map(entry => (
              <span key={entry.key} className="inline-flex items-center gap-xs" data-chart-legend={entry.key}>
                <span aria-hidden="true" className={`inline-block size-2 rounded-xs ${TONE_CLASS[entry.tone]}`} />
                {entry.label}
              </span>
            ))}
          {flagged && flagNote !== undefined && (
            <span className="inline-flex items-center gap-xs" data-chart-flag-note="">
              <span aria-hidden="true" className="inline-block h-2 w-3" style={{ background: HATCH }} />
              {flagNote}
            </span>
          )}
        </span>
      </figcaption>
      <p className="m-0 min-h-[1.25rem] text-meta tabular-nums text-muted" aria-live="polite" data-chart-readout="">
        {focus ? readout(focus) : emptyText}
      </p>
      {/* `py-2` insets the plot by half a label, so the top tick and the baseline tick sit inside. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-sm py-2">
        <div aria-hidden="true" className={`relative ${plotClassName}`} data-chart-axis="">
          {/* Invisible copies give the axis the width of its widest tick. */}
          {ticks.map(tick => (
            <span key={`w${tick}`} className="mono invisible block h-0 overflow-hidden whitespace-nowrap text-2xs">
              {formatAxis(tick)}
            </span>
          ))}
          {ticks.map(tick => (
            <span
              key={tick}
              className="mono absolute right-0 translate-y-1/2 whitespace-nowrap text-2xs leading-none tabular-nums text-muted"
              style={{ bottom: `${(100 * tick) / top}%` }}
            >
              {formatAxis(tick)}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={`${title}, ${points[0]?.label ?? ''} to ${points.at(-1)?.label ?? ''}: ${format(total)} in total${peak ? `, highest ${format(totals.get(peak.key)!)} at ${peak.label}` : ''}.`}
          className={`relative ${plotClassName}`}
        >
          {ticks.map(tick => (
            <span
              key={tick}
              aria-hidden="true"
              className="absolute inset-x-0 border-t border-border-soft"
              style={{ bottom: `${(100 * tick) / top}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {points.map(point => {
              const pointSum = totals.get(point.key)!;
              return (
                <div
                  key={point.key}
                  className="relative flex h-full min-w-0 flex-1 flex-col justify-end"
                  title={readout(point)}
                  data-chart-point={point.key}
                  data-chart-zero={point.empty === true ? '' : undefined}
                  onPointerEnter={() => setHovered(point.key)}
                  onPointerLeave={() => setHovered(null)}
                >
                  {point.flagged === true && <span className="mb-px block h-1 w-full" style={{ background: HATCH }} />}
                  {pointSum > 0 ? (
                    <span
                      className={`flex w-full flex-col-reverse overflow-hidden rounded-t-xs ${!dimOthers || focus?.key === point.key ? '' : 'opacity-75'}`}
                      style={{ height: `${(100 * pointSum) / top}%` }}
                    >
                      {series.map((entry, index) => (
                        <span
                          key={entry.key}
                          className={`block w-full shrink-0 ${TONE_CLASS[entry.tone]}`}
                          style={{ height: `${(100 * (point.values[index] ?? 0)) / pointSum}%` }}
                        />
                      ))}
                    </span>
                  ) : (
                    <span className="block h-px w-full bg-faint" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <span />
        {rotateLabels ? (
          <XLabels points={points} every={1} rotated className="mt-xs flex gap-[2px] text-2xs text-muted" />
        ) : (
          <>
            <XLabels
              points={points}
              every={Math.max(1, Math.ceil(points.length / 5))}
              className="mt-xs flex gap-[2px] text-2xs text-muted sm:hidden"
            />
            <XLabels
              points={points}
              every={Math.max(1, Math.ceil(points.length / 10))}
              className="mt-xs hidden gap-[2px] text-2xs text-muted sm:flex"
            />
          </>
        )}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Point</th>
            {series.map(entry => (
              <th key={entry.key} scope="col">
                {entry.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map(point => (
            <tr key={point.key}>
              <th scope="row">{point.label}</th>
              {series.map((entry, index) => (
                <td key={entry.key}>{format(point.values[index] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
