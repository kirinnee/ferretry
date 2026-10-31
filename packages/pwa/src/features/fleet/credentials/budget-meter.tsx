/**
 * A login's spend budget as a meter (docs/budgets.md): one bar per period, laid out exactly like the 5h/Week
 * quota bars above it — the same label column, the bar, the words beside it — so the two sets of bars start
 * and end in the same place. The bar reaches a fifth past the higher limit and is filled by the spend; the
 * trigger is a thin mark on it and the hard limit a taller one that stands out of it, so both can be seen
 * however full the bar is. Under everything, what the spend IS and IS NOT.
 *
 * All of the wording and geometry is the pure model's; this is only how it is laid out.
 */

import type { FleetCredentialBudget } from '@ferretry/protocol';
import { cn } from '../../../lib/class-names.ts';
import { budgetMeterRows, budgetScopeNote } from './credentials-model.ts';
import { METER_LABEL, METER_WORDS } from './meter-layout.ts';

/** A login's budget as the Credentials tab shows it, wherever a row or page lists one. */
export function BudgetMeter({
  budget,
  machineName,
}: {
  readonly budget: FleetCredentialBudget;
  readonly machineName: string;
}) {
  return (
    <div className="flex flex-col gap-1" data-credential-budget="">
      {budgetMeterRows(budget).map(row => (
        <div key={row.label} className="flex min-w-0 items-center gap-2 text-meta">
          <span className={METER_LABEL}>{row.label}</span>
          <span
            role="img"
            aria-label={row.words}
            className="relative h-1.5 min-w-0 flex-1 rounded-full bg-surface-2"
            data-budget-bar={row.label}
          >
            <span
              className={cn(
                'absolute inset-y-0 left-0 rounded-full',
                row.level === 'over_hard' ? 'bg-err' : row.level === 'over_trigger' ? 'bg-warn' : 'bg-accent',
              )}
              style={{ width: `${String(row.fillPercent)}%` }}
            />
            {row.triggerPercent === null ? null : (
              <span
                data-budget-trigger=""
                className="absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-warn ring-1 ring-surface"
                style={{ left: `${String(row.triggerPercent)}%` }}
              />
            )}
            {row.hardPercent === null ? null : (
              <span
                data-budget-hard=""
                className="absolute -inset-y-1 w-1 -translate-x-1/2 rounded-full bg-err ring-1 ring-surface"
                style={{ left: `${String(row.hardPercent)}%` }}
              />
            )}
          </span>
          <span className={METER_WORDS}>{row.words}</span>
        </div>
      ))}
      <p className="m-0 text-meta leading-base text-muted" data-budget-scope="">
        {budgetScopeNote(budget, machineName)}
      </p>
    </div>
  );
}
