/**
 * ONE LANE: a header with the lane's name and card count that folds the lane away, and the cards under it.
 *
 * It is the only lane renderer — a Kanban column on the full page, a collapsible group in the side pane —
 * and it is also a drop target: while a card of the same board is being dragged it accepts the drop and
 * says so. What a drop DOES is the page's (`onDropCard`), because only the page knows about reasons.
 */

import type { LaneCategory } from '@ferretry/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { BoardDensity } from './board-card.tsx';

export interface BoardLaneProps {
  readonly name: string;
  readonly category: LaneCategory | null;
  readonly count: number;
  readonly density: BoardDensity;
  readonly defaultCollapsed?: boolean;
  /** A card of this board is in the air: this lane takes the drop. */
  readonly accepts?: boolean;
  readonly onDropCard?: () => void;
  /** Drawn as a quiet "drop here to close" target rather than a column (the hidden Closed lane). */
  readonly variant?: 'column' | 'target';
  readonly children?: ReactNode;
}

export function BoardLane({
  name,
  category,
  count,
  density,
  defaultCollapsed = false,
  accepts = false,
  onDropCard,
  variant = 'column',
  children,
}: BoardLaneProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [over, setOver] = useState(false);
  const bodyId = useId();
  const droppable = accepts && onDropCard !== undefined;
  return (
    <section
      aria-label={`${name}, ${count} ${count === 1 ? 'card' : 'cards'}`}
      className="fy-board-lane"
      data-category={category ?? 'unplaced'}
      data-density={density}
      data-drop={droppable ? (over ? 'over' : 'ready') : undefined}
      data-variant={variant}
      onDragLeave={() => setOver(false)}
      onDragOver={event => {
        if (!droppable) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDrop={event => {
        if (!droppable) return;
        event.preventDefault();
        setOver(false);
        onDropCard();
      }}
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
