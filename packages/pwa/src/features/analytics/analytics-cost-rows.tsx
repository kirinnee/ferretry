/**
 * The pieces every cost surface shares: a split rendered as label, bar and amount, and the chip that
 * names what a dollar figure does not cover.
 *
 * NO TABLE. A row is a label, a proportional bar and an amount, and the amount never shrinks, so it is
 * the one thing still on screen at a 320px side pane — the failure the old ledger had at 440px, where
 * the cost column was the eighth of eight and sat off screen.
 */

import { Badge } from '../../shell/primitives.tsx';
import { type AnalyticsModelShare, formatUsd } from './analytics-overview.ts';

/** "14 unpriced" — the part of a period a dollar figure does not include. Nothing when there is none. */
export function UnpricedChip({ count, className }: { readonly count: number; readonly className?: string }) {
  if (count === 0) return null;
  return (
    <Badge
      tone="warn"
      className={className}
      title={`${count} session${count === 1 ? '' : 's'} could not be priced, so the amount leaves ${count === 1 ? 'it' : 'them'} out`}
      data-unpriced={count}
    >
      {count} unpriced
    </Badge>
  );
}

export interface CostSplitProps {
  readonly shares: readonly AnalyticsModelShare[];
  /** Sessions the amounts leave out; drawn as a last row with a count instead of a bar. */
  readonly unpriced?: number;
  /** Fold rows past this many into "other N". */
  readonly limit?: number;
  readonly label: string;
}

/** Cost per model, most expensive first, each bar scaled to the largest. */
export function CostSplit({ shares, unpriced = 0, limit, label }: CostSplitProps) {
  const shown = limit !== undefined && shares.length > limit ? shares.slice(0, limit - 1) : shares;
  const folded = shares.slice(shown.length);
  const rows =
    folded.length > 0
      ? [
          ...shown,
          {
            model: `other ${folded.length}`,
            costMicros: folded.reduce((sum, share) => sum + share.costMicros, 0),
            sessions: folded.reduce((sum, share) => sum + share.sessions, 0),
          },
        ]
      : shown;
  const largest = Math.max(1, ...rows.map(row => row.costMicros));
  if (rows.length === 0 && unpriced === 0)
    return <p className="m-0 text-cell text-muted">Nothing was priced in this period.</p>;
  return (
    <ul aria-label={label} className="m-0 grid list-none gap-sm p-0">
      {rows.map(row => (
        <li
          key={row.model}
          className="grid grid-cols-[minmax(0,9rem)_minmax(2rem,1fr)_auto] items-center gap-sm text-cell"
          data-cost-row={row.model}
        >
          <span className="mono truncate text-fg-soft" title={row.model}>
            {row.model}
          </span>
          <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.max(2, (100 * row.costMicros) / largest)}%` }}
            />
          </span>
          <span className="mono text-right tabular-nums text-fg">{formatUsd(row.costMicros)}</span>
        </li>
      ))}
      {unpriced > 0 && (
        <li
          className="grid grid-cols-[minmax(0,9rem)_minmax(2rem,1fr)_auto] items-center gap-sm text-cell"
          data-cost-row="unpriced"
        >
          <span className="truncate text-warn">unpriced</span>
          <span aria-hidden="true" className="h-2 rounded-full border border-dashed border-warn-border" />
          <span className="mono text-right tabular-nums text-muted">
            {`${unpriced} ${unpriced === 1 ? 'session' : 'sess.'}`}
          </span>
        </li>
      )}
    </ul>
  );
}
