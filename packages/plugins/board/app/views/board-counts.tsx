/**
 * THE BOARD'S HEADER NUMBERS: the health chips (stale, orphaned, active) and "N closed hidden", which opens the Archive.
 * What waits on the owner is the Agenda's, so the board draws no To test or Waiting on you pill.
 *
 * Every number is the daemon's own count (`BoardCounts`), summed over the machines read, less the agent cards the
 * board is not showing (so a chip and its cards agree); a chip is also a
 * filter, so pressing it narrows the board to those cards and pressing it again lifts the filter.
 */

import type { BoardActivityFilter, BoardCounts } from '../../contract/index.ts';
import type { BoardIconName } from '../lib/board-present.ts';
import { BoardIcon } from './board-icons.tsx';

export interface BoardCountsProps {
  readonly counts: BoardCounts;
  readonly activity: BoardActivityFilter | null;
  readonly onActivity: (next: BoardActivityFilter | null) => void;
  readonly onOpenArchive: () => void;
}

interface Pill {
  readonly filter: BoardActivityFilter;
  readonly icon: BoardIconName;
  readonly label: string;
  readonly count: number;
  readonly tone: 'pill' | 'chip';
  readonly word: string;
}

const pills = (counts: BoardCounts): readonly Pill[] => [
  { filter: 'stale', icon: 'stale', label: '', count: counts.stale, tone: 'chip', word: 'stale' },
  { filter: 'orphaned', icon: 'orphaned', label: '', count: counts.orphaned, tone: 'chip', word: 'orphaned' },
  { filter: 'active', icon: 'active', label: '', count: counts.active, tone: 'chip', word: 'active' },
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
            <span className="fy-board-count__label">
              <BoardIcon name={pill.icon} size={12} />
              {pill.label}
            </span>
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
