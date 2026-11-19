/**
 * A login's spend budget as a meter (docs/budgets.md): one bar per period, laid out exactly like the 5h/Week
 * quota bars above it — the same label column, the bar, the words beside it — so the two sets of bars start
 * and end in the same place. The bar reaches a fifth past the higher limit and is filled by the spend; the
 * trigger is a thin mark on it and the hard limit a taller one that stands out of it, so both can be seen
 * however full the bar is. Under everything, what the spend IS and IS NOT.
 *
 * All of the wording and geometry is the pure model's; this is only how it is laid out.
 */

import { cn } from '@ferretry/app/ui';
import type { LoginBudget } from '@ferretry/plugin-logins/contract';
import { budgetMeterRows, budgetScopeNote } from '../../lib/budget-model.ts';

/**
 * The columns every meter on a login shares — its 5h/Week quota bars and its spend budget bars — so the bars
 * start and end in the same place: a label column, the bar, and a words column of one fixed width.
 */
const METER_LABEL = 'w-12 shrink-0 whitespace-nowrap text-muted';
// In a narrow block the words sit beside the label and the bar takes the full width below them (as Logins' quota bars do). The
// block asks about ITS OWN width (`.fy-meter`, settings-layout.css), not the viewport: a 768px window leaves a 212px panel.
// `basis-0` keeps the words on the label's line (they wrap inside their share) rather than dropping to a line of their own.
const METER_ROW = 'fy-meter-row flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta';
const METER_BAR = 'fy-meter-bar order-last basis-full';
const METER_WORDS = 'fy-meter-words min-w-0 flex-1 basis-0 text-right text-muted';

/** A login's budget as the Budgets tab shows it, wherever a row or page lists one. */
export function BudgetMeter({ budget, machineName }: { readonly budget: LoginBudget; readonly machineName: string }) {
  return (
    <div className="fy-meter flex flex-col gap-1" data-credential-budget="">
      {budgetMeterRows(budget).map(row => (
        <div key={row.label} className={METER_ROW}>
          <span className={METER_LABEL}>{row.label}</span>
          <span
            role="img"
            aria-label={row.words}
            className={cn('relative h-1.5 min-w-0 flex-1 rounded-full bg-surface-2', METER_BAR)}
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
