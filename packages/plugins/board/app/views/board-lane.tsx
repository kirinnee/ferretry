/**
 * ONE LANE: a header with the lane's name and card count that folds the lane away, and the cards under it.
 *
 * It is the only lane renderer — a Kanban column on the full page, a collapsible group in the side pane. It is
 * not a drop target: cards are not draggable, the board moves them itself.
 */

import type { LaneCategory } from '../../contract/index.ts';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { BoardDensity } from './board-card.tsx';

export interface BoardLaneProps {
  readonly name: string;
  readonly category: LaneCategory | null;
  readonly count: number;
  readonly density: BoardDensity;
  readonly defaultCollapsed?: boolean;
  readonly children?: ReactNode;
}

export function BoardLane({ name, category, count, density, defaultCollapsed = false, children }: BoardLaneProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = useId();
  return (
    <section
      aria-label={`${name}, ${count} ${count === 1 ? 'card' : 'cards'}`}
      className="fy-board-lane"
      data-category={category ?? 'unplaced'}
      data-density={density}
    >
      <h3 className="fy-board-lane__head">
        <button
          aria-controls={bodyId}
          aria-expanded={!collapsed}
          className="fy-board-lane__toggle"
          onClick={() => setCollapsed(value => !value)}
          type="button"
        >
          {collapsed ? <ChevronRight aria-hidden="true" size={12} /> : <ChevronDown aria-hidden="true" size={12} />}
          <span className="fy-board-lane__name">{name}</span>
          <span className="fy-board-lane__count">{count}</span>
        </button>
      </h3>
      {collapsed ? null : (
        <ul className="fy-board-lane__cards" id={bodyId}>
          {children}
        </ul>
      )}
    </section>
  );
}
