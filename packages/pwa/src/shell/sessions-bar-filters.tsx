/**
 * THE SESSIONS BAR'S FILTERS: the kind of session, and whether the stopped ones are listed.
 *
 * All · Agents · Interactive is kteam's sidebar segment, with its counts — each the length of the list
 * choosing it would draw. "Agents" is the `auto` mode in the reader's words. The labels are written out
 * in full at every width: kteam's squeezed to "A…" and "IN…" in a narrow column, so here a segment never
 * shrinks below its own label and the strip WRAPS onto a second line before it would clip one.
 *
 * "Show stopped" is one line under the segment, with the number it would add, so a reader who sees
 * fewer sessions than they remember is told how many are tucked away and where the tick is.
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

const MODE_ORDER: readonly ModeFilter[] = ['all', 'auto', 'interactive'];

export function SessionsBarFilters({
  filter,
  counts,
  hiddenStopped,
  onChange,
}: {
  readonly filter: SessionsListFilter;
  readonly counts: ModeCounts;
  readonly hiddenStopped: number;
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
      <label className="fy-sbar__stopped" title="Completed, failed, stalled or stopped sessions">
        <input
          checked={filter.showStopped}
          data-sbar-show-stopped=""
          onChange={event => onChange({ ...filter, showStopped: event.target.checked })}
          type="checkbox"
        />
        <span>Show stopped</span>
        {filter.showStopped || hiddenStopped === 0 ? null : (
          <span className="fy-sbar__count" data-sbar-hidden-stopped="">
            {hiddenStopped}
          </span>
        )}
      </label>
    </div>
  );
}

/** What an empty list says: which kind found nothing, and how many stopped ones the tick would add. */
export const sessionsBarEmptyMessage = (filter: SessionsListFilter, hiddenStopped: number): string => {
  const kind = filter.mode === 'all' ? '' : `${MODE_LABEL[filter.mode].toLowerCase()} `;
  if (hiddenStopped > 0) return `No live ${kind}sessions — ${hiddenStopped} stopped. Tick Show stopped.`;
  return filter.mode === 'all' ? 'No sessions running.' : `No ${kind}sessions.`;
};
