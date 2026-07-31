/**
 * The horizontal status filter above every task surface.
 *
 * Ported from kteam `ui/src/components/TaskStatusFilter.tsx`, silhouette and
 * copy intact. Two decisions are load-bearing and were kept verbatim:
 *
 *   * Each chip WEARS ITS OWN STATUS TONE — a dot at rest previewing the rail
 *     colour its rows use, the full tone treatment when selected — so an active
 *     filter reads as "these colours are showing" rather than a generic accent
 *     press. That is `.kt-task-tone` + `.kt-task-chip-active` in the design
 *     sheet; nothing here knows a colour.
 *   * Every chip is at least 44×44. The row scrolls horizontally with
 *     `overscroll-x-contain` so a thumb-swipe on a phone cannot chain out to
 *     the page behind it.
 */

import type { TaskStatus } from '@ferretry/protocol';
import { cn } from '../../lib/class-names.ts';
import { TASK_STATUS_META, orderedTaskStatuses } from './task-presentation.ts';

export interface TaskStatusFilterProps {
  readonly counts: ReadonlyMap<TaskStatus, number>;
  /** `null` is the explicit All state. */
  readonly selected: ReadonlySet<TaskStatus> | null;
  readonly onSelect: (status: TaskStatus) => void;
  readonly onShowAll: () => void;
}

const CHIP = 'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold';
const CHIP_RESTING = 'border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg';

export function TaskStatusFilter({ counts, selected, onSelect, onShowAll }: TaskStatusFilterProps) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return (
    // kteam wrote this as `<div role="group">`. A native <fieldset> carries the
    // same implicit role and satisfies the repo's a11y gate without an explicit
    // role attribute; Tailwind's preflight zeroes fieldset margin, padding and
    // border, so the rendered box is unchanged. Same substitution the ported
    // ViewTabs made, for the same reason.
    <fieldset
      data-task-status-filter
      className="flex gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin"
      aria-label="Filter tasks by status"
    >
      <button
        type="button"
        aria-pressed={selected === null}
        onClick={onShowAll}
        className={cn(CHIP, selected === null ? 'border-accent bg-accent-soft text-accent' : CHIP_RESTING)}
      >
        All <span className="mono text-faint">{total}</span>
      </button>
      {orderedTaskStatuses(counts, selected).map(status => {
        const active = selected?.has(status) ?? false;
        const count = counts.get(status) ?? 0;
        const { label, tone } = TASK_STATUS_META[status];
        return (
          <button
            key={status}
            type="button"
            data-tone={tone}
            aria-pressed={active}
            aria-label={`${label}, ${count} ${count === 1 ? 'task' : 'tasks'}`}
            title={active ? `Remove ${label} from the filter` : `Show ${label} tasks`}
            onClick={() => onSelect(status)}
            className={cn('kt-task-tone', CHIP, active ? 'kt-task-chip-active' : CHIP_RESTING)}
          >
            <span className="kt-task-tone-dot" aria-hidden="true" />
            {label} <span className={cn('mono', active ? 'kt-task-tone-ink' : 'text-faint')}>{count}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
