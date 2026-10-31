/**
 * One line above the per-daemon Warden sections: today's five numbers added across the daemons shown.
 * Render-only — `combinedTodayTotals` owns the arithmetic. A daemon that could not say is left out and
 * the line says how many it covers; it never counts an unknown as zero.
 */

import { Fragment } from 'react';
import { INSIGHTS_COLUMN_CLASS } from '../../shell/insights-frame.tsx';
import type { CombinedTotals } from './warden-stats-model.ts';

export function WardenCombinedTotals({ totals }: { readonly totals: CombinedTotals }) {
  if (totals.counted === 0) return null;
  const partial = totals.counted < totals.of;
  return (
    <p
      className={`${INSIGHTS_COLUMN_CLASS} m-0 flex min-w-0 flex-wrap items-baseline gap-x-md gap-y-xs pt-3 text-meta leading-base text-muted`}
      data-warden-combined=""
    >
      <span className="font-semibold text-fg">All daemons today</span>{' '}
      {totals.tiles.map(tile => (
        <Fragment key={tile.key}>
          <span data-combined-tile={tile.key} className="[font-variant-numeric:tabular-nums]">
            {tile.label} <span className="font-semibold text-fg">{tile.value ?? '—'}</span>
          </span>{' '}
        </Fragment>
      ))}
      {partial && (
        <span className="text-faint">
          from {totals.counted} of {totals.of} daemons
        </span>
      )}
    </p>
  );
}
