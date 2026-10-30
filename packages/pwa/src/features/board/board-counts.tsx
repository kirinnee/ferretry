/**
 * THE BOARD'S HEADER NUMBERS: two one-tap pills for what needs the reader (🧪 To test, 🚧 Waiting on
 * you), the health chips (▲ stale, ⛔ orphaned, ● active) and "N closed hidden", which opens the Archive.
 *
 * Every number is the daemon's own count (`BoardCounts`), summed over the machines read; a pill is also a
 * filter, so pressing it narrows the board to those cards and pressing it again lifts the filter.
 */

import type { BoardActivityFilter, BoardCounts } from '@ferretry/protocol';

export interface BoardCountsProps {
  readonly counts: BoardCounts;
  readonly activity: BoardActivityFilter | null;
  readonly onActivity: (next: BoardActivityFilter | null) => void;
  readonly onOpenArchive: () => void;
}

interface Pill {
  readonly filter: BoardActivityFilter;
  readonly label: string;
  readonly count: number;
  readonly tone: 'pill' | 'chip';
  readonly word: string;
}

const pills = (counts: BoardCounts): readonly Pill[] => [
  { filter: 'to_test', label: '🧪 To test', count: counts.toTest, tone: 'pill', word: 'cards to test' },
  {
    filter: 'waiting_on_you',
    label: '🚧 Waiting on you',
    count: counts.waitingOnYou,
    tone: 'pill',
    word: 'cards waiting on you',
  },
  { filter: 'stale', label: '▲', count: counts.stale, tone: 'chip', word: 'stale' },
  { filter: 'orphaned', label: '⛔', count: counts.orphaned, tone: 'chip', word: 'orphaned' },
  { filter: 'active', label: '●', count: counts.active, tone: 'chip', word: 'active' },
];

export function BoardCountsBar({ counts, activity, onActivity, onOpenArchive }: BoardCountsProps) {
  return (
    <div aria-label="Board totals" className="fy-board-counts" role="toolbar">
      {pills(counts).map(pill => {
        const pressed = activity === pill.filter;
        return (
          <button
            aria-label={`${pill.count} ${pill.word}`}
            aria-pressed={pressed}
            className="fy-board-count"
            data-count={pill.filter}
            data-empty={pill.count === 0 ? '' : undefined}
            data-kind={pill.tone}
            key={pill.filter}
            onClick={() => onActivity(pressed ? null : pill.filter)}
            type="button"
          >
            <span className="fy-board-count__label">{pill.label}</span>
            <span className="fy-board-count__n">{pill.count}</span>
          </button>
        );
      })}
      <button className="fy-board-counts__closed" data-count="closed" onClick={onOpenArchive} type="button">
        {counts.closedHidden} closed hidden
      </button>
    </div>
  );
}
