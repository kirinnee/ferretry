/**
 * THE SESSIONS BAR'S FILTERS: the kind of session, and whether the stopped ones are listed.
 *
 * Interactive · All · Agents — Interactive first, because it is what a new device opens on — each with its
 * count: the length of the list choosing it would draw. "Agents" is the `auto` mode in the reader's words.
 * The labels are written out in full at every width: kteam's squeezed to "A…" and "IN…" in a narrow column, so
 * here a segment never shrinks below its own label and the strip WRAPS onto a second line before it would clip
 * one.
 *
 * "Show stopped" is not drawn here: it is a row of the bar's ⋯ menu (sessions-bar-options.tsx), and an empty
 * list says how many stopped sessions it is hiding and where the switch is.
 */

import type { ModeFilter } from '../lib/controls.ts';
import type { ModeCounts } from '../lib/fleet-grouping.ts';
import type { SessionsListFilter } from './sessions-bar-model.ts';

const MODE_LABEL: Readonly<Record<ModeFilter, string>> = {
  all: 'All',
  auto: 'Agents',
  interactive: 'Interactive',
};

const MODE_HINT: Readonly<Record<ModeFilter, string>> = {
  all: 'Every session',
  auto: 'Agents — autonomous ferrets that work unattended',
  interactive: 'Interactive — a person drives them',
};

const MODE_ORDER: readonly ModeFilter[] = ['interactive', 'all', 'auto'];

export function SessionsBarFilters({
  filter,
  counts,
  onChange,
}: {
  readonly filter: SessionsListFilter;
  readonly counts: ModeCounts;
  readonly onChange: (next: SessionsListFilter) => void;
}) {
  return (
    <div className="fy-sbar__filters">
      <fieldset aria-label="Show sessions" className="fy-sbar__segment">
        {MODE_ORDER.map(mode => (
          <button
            aria-pressed={filter.mode === mode}
            className="fy-sbar__seg"
            data-sbar-filter={mode}
            key={mode}
            onClick={() => onChange({ ...filter, mode })}
            title={`${MODE_HINT[mode]} (${counts[mode]})`}
            type="button"
          >
            <span>{MODE_LABEL[mode]}</span>
            <span className="fy-sbar__count">{counts[mode]}</span>
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/** What an empty list says: which kind found nothing, and how many stopped ones the tick would add. */
export const sessionsBarEmptyMessage = (filter: SessionsListFilter, hiddenStopped: number): string => {
  const kind = filter.mode === 'all' ? '' : `${MODE_LABEL[filter.mode].toLowerCase()} `;
  if (hiddenStopped > 0) return `No live ${kind}sessions — ${hiddenStopped} stopped. Choose ⋯ › Show stopped.`;
  return filter.mode === 'all' ? 'No sessions running.' : `No ${kind}sessions.`;
};
