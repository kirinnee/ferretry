/**
 * ONE BAR CHART: equivalent cost per day, on one labelled dollar axis.
 *
 * It replaces three line charts on independent, unlabelled scales that repeated one story. What it
 * keeps honest:
 *
 * - A ZERO DAY IS DRAWN AS ZERO — a hairline on the baseline — never as a gap, because a day with no
 *   sessions is known.
 * - A DAY WITH UNPRICED SESSIONS carries a hatched warning cap on its bar, so its height is read as "at
 *   least". A day the daemon could only list in part is marked the same way.
 * - THE TEXT USES TEXT TOKENS. Axis labels are `muted`, never a series colour, so they stay readable on
 *   every theme's dark surface.
 *
 * Bars are plain HTML boxes rather than SVG so the plot stretches to any width while the labels keep
 * their size. Hovering a day shows its figures in the readout line; the same figures are in a table for
 * screen readers.
 */

import { useState } from 'react';

import {
  type AnalyticsDayBucket,
  analyticsAxisTicks,
  formatAxisUsd,
  formatDay,
  formatUsd,
} from './analytics-overview.ts';

const HATCH = 'repeating-linear-gradient(135deg, var(--warn) 0 2px, transparent 2px 4px)';

/**
 * Which x labels to print: every `every`-th day counted back from the last, so today is always labelled
 * and no two labels are closer than `every` bars.
 */
export const chartLabelDays = (days: readonly AnalyticsDayBucket[], every: number): ReadonlySet<string> =>
  new Set(days.filter((_, index) => (days.length - 1 - index) % every === 0).map(bucket => bucket.day));

const dayReadout = (bucket: AnalyticsDayBucket): string =>
  [
    formatDay(bucket.day),
    formatUsd(bucket.costMicros),
    `${bucket.sessions} session${bucket.sessions === 1 ? '' : 's'}`,
    ...(bucket.unpriced > 0 ? [`${bucket.unpriced} unpriced`] : []),
    ...(bucket.partial ? ['only partly listed'] : []),
  ].join(' · ');

function XLabels({
  days,
  every,
  className,
}: {
  readonly days: readonly AnalyticsDayBucket[];
  readonly every: number;
  readonly className: string;
}) {
  const shown = chartLabelDays(days, every);
  return (
    <div aria-hidden="true" className={className}>
      {days.map((bucket, index) => (
        // The end labels grow inward, so the last day never pushes the page sideways.
        <span
          key={bucket.day}
          className={`mono flex min-w-0 flex-1 whitespace-nowrap ${index === 0 ? 'justify-start' : index === days.length - 1 ? 'justify-end' : 'justify-center'}`}
        >
          {shown.has(bucket.day) ? formatDay(bucket.day) : ''}
        </span>
      ))}
    </div>
  );
}

export function AnalyticsCostChart({ days }: { readonly days: readonly AnalyticsDayBucket[] }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const ticks = analyticsAxisTicks(Math.max(0, ...days.map(bucket => bucket.costMicros)) / 1_000_000);
  const top = ticks.at(-1)!;
  const peak = days.reduce<AnalyticsDayBucket | null>(
    (best, bucket) => (bucket.costMicros > (best?.costMicros ?? 0) ? bucket : best),
    null,
  );
  const focus = days.find(bucket => bucket.day === hovered) ?? peak;
  const flagged = days.some(bucket => bucket.unpriced > 0 || bucket.partial);
  const total = days.reduce((sum, bucket) => sum + bucket.costMicros, 0);

  return (
    <figure className="m-0 grid min-w-0 gap-sm" data-analytics-chart="">
      <figcaption className="flex flex-wrap items-center justify-between gap-x-md gap-y-xs">
        <span className="text-cell font-semibold text-fg">Equivalent cost per day</span>
        <span className="flex items-center gap-sm text-meta text-muted">
          {flagged && (
            <span className="inline-flex items-center gap-xs">
              <span aria-hidden="true" className="inline-block h-2 w-3" style={{ background: HATCH }} />
              has unpriced sessions
            </span>
          )}
        </span>
      </figcaption>
      <p className="m-0 min-h-[1.25rem] text-meta text-muted" aria-live="polite" data-chart-readout="">
        {focus ? dayReadout(focus) : 'No cost in this period.'}
      </p>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-sm">
        <div aria-hidden="true" className="relative h-40 w-10 sm:h-48">
          {ticks.map(tick => (
            <span
              key={tick}
              className="mono absolute right-0 translate-y-1/2 text-2xs leading-none text-muted"
              style={{ bottom: `${(100 * tick) / top}%` }}
            >
              {formatAxisUsd(tick)}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={`Equivalent cost per day, ${formatDay(days[0]?.day ?? '')} to ${formatDay(days.at(-1)?.day ?? '')}: ${formatUsd(total)} in total${peak ? `, highest ${formatUsd(peak.costMicros)} on ${formatDay(peak.day)}` : ''}.`}
          className="relative h-40 sm:h-48"
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
            {days.map(bucket => {
              const height = (100 * bucket.costMicros) / 1_000_000 / top;
              const warn = bucket.unpriced > 0 || bucket.partial;
              return (
                <div
                  key={bucket.day}
                  className="relative flex h-full min-w-0 flex-1 flex-col justify-end"
                  title={dayReadout(bucket)}
                  data-chart-day={bucket.day}
                  data-chart-zero={bucket.sessions === 0 ? '' : undefined}
                  onPointerEnter={() => setHovered(bucket.day)}
                  onPointerLeave={() => setHovered(null)}
                >
                  {warn && <span className="mb-px block h-[3px] w-full" style={{ background: HATCH }} />}
                  {bucket.costMicros > 0 ? (
                    <span
                      className={`block w-full rounded-t-xs bg-accent ${focus?.day === bucket.day ? '' : 'opacity-75'}`}
                      style={{ height: `${height}%` }}
                    />
                  ) : (
                    <span className="block h-px w-full bg-faint" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <span />
        <XLabels
          days={days}
          every={Math.ceil(days.length / 5)}
          className="mt-xs flex gap-[2px] text-2xs text-muted sm:hidden"
        />
        <XLabels
          days={days}
          every={Math.ceil(days.length / 10)}
          className="mt-xs hidden gap-[2px] text-2xs text-muted sm:flex"
        />
      </div>
      <table className="sr-only">
        <caption>Equivalent cost per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Cost</th>
            <th scope="col">Sessions</th>
            <th scope="col">Unpriced</th>
          </tr>
        </thead>
        <tbody>
          {days.map(bucket => (
            <tr key={bucket.day}>
              <th scope="row">{formatDay(bucket.day)}</th>
              <td>{formatUsd(bucket.costMicros)}</td>
              <td>{bucket.sessions}</td>
              <td>{bucket.unpriced}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
