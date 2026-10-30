/**
 * ONE BOARD CARD, TWO LINES: the title (truncated), and a meta line of short segments
 * (`&F412 · owner→assignee · ● 4m · PR ✓ · ⛓ 1 · subs 2/3`).
 *
 * It is the only card renderer. The full-page Board, the phone and the per-chat side pane all draw it, and
 * `density` is the only thing that differs: `side` keeps one short line by dropping the segments that
 * are marked optional (who, shipped-in, machine).
 *
 * A card is a real link to its detail (`/d/<id>/board/<taskId>`). When the page can move cards it is also
 * draggable, and a "Move to…" menu does the same job from the keyboard; both end in the same `onMove`.
 */

import type { LaneCategory } from '@ferretry/protocol';
import { Check, ChevronLeft, EllipsisVertical, X } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, useId, useState } from 'react';
import { type FerretNames, cardSegments } from '../../lib/board-present.ts';
import type { BoardCardOf } from '../../lib/board-view.ts';
import type { MoveChoice } from '../../lib/board-move.ts';
import { RouteLink } from '../../shell/route-link.tsx';

export type BoardDensity = 'page' | 'side';

export interface BoardCardMoves {
  /** Every lane the card could go to, for the "Move to…" menu. */
  readonly choices: readonly MoveChoice[];
  readonly onMove: (card: BoardCardOf, laneId: string) => void;
  /** The lane "✓ Works → Close" goes to; `null` when the project has no Closed lane. */
  readonly closeLaneId: string | null;
  /** The lane "✗ Not good" goes back to (asks for a reason); `null` when there is none. */
  readonly reworkLaneId: string | null;
  readonly onDragStart: (card: BoardCardOf) => void;
  readonly onDragEnd: () => void;
}

export interface BoardCardProps {
  readonly card: BoardCardOf;
  readonly density: BoardDensity;
  readonly category: LaneCategory | null;
  readonly names: FerretNames;
  readonly now: number;
  /** More than one machine is on the board: say which machine the card is on. */
  readonly showMachine: boolean;
  /** Where the card opens. */
  readonly href: string;
  readonly onNavigate?: (to: string) => void;
  /** Present when the owner can move this card; absent for a read-only list. */
  readonly moves?: BoardCardMoves;
  readonly dragging?: boolean;
  /** The lane's name, shown first on the meta line (List and Tree, where cards are not under a lane header). */
  readonly lane?: string;
  /** Nesting under a lead, for the Tree. */
  readonly depth?: number;
}

export function BoardCard({
  card,
  density,
  category,
  names,
  now,
  showMachine,
  href,
  onNavigate,
  moves,
  dragging = false,
  lane,
  depth,
}: BoardCardProps) {
  const { task } = card;
  const segments = cardSegments(task, {
    names,
    now,
    category,
    machine: showMachine ? card.machine : null,
  }).filter(segment => density === 'page' || !segment.optional);
  const toTest = moves !== undefined && density === 'page' && category === 'verify';
  return (
    <li
      className="fy-board-card"
      data-activity={task.activity}
      data-category={category ?? 'unplaced'}
      data-density={density}
      data-depth={depth}
      data-dragging={dragging ? '' : undefined}
      data-kind={task.kind}
      data-task={task.id}
      draggable={moves !== undefined}
      style={depth === undefined ? undefined : ({ '--fy-board-depth': depth } as CSSProperties)}
      onDragEnd={moves?.onDragEnd}
      onDragStart={
        moves === undefined
          ? undefined
          : event => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', card.key);
              moves.onDragStart(card);
            }
      }
    >
      <RouteLink
        className="fy-board-card__main"
        draggable={false}
        onNavigate={onNavigate}
        title={task.summary === '' ? task.title : `${task.title} — ${task.summary}`}
        to={href}
      >
        <span className="fy-board-card__title">{task.title}</span>
        <span className="fy-board-card__meta">
          {lane === undefined ? null : (
            <span className="fy-board-seg" data-seg="lane" data-tone="quiet" title="Lane">
              {lane}
            </span>
          )}
          {segments.map(segment => (
            <span
              className="fy-board-seg"
              data-seg={segment.key}
              data-tone={segment.tone}
              key={segment.key}
              title={segment.title}
            >
              {segment.text}
            </span>
          ))}
        </span>
      </RouteLink>
      {moves !== undefined && moves.choices.length > 0 ? <BoardMoveMenu card={card} moves={moves} /> : null}
      {toTest ? <ToTestActions card={card} moves={moves} /> : null}
    </li>
  );
}

/** The two one-tap answers on a card waiting to be tried: it works, or it does not. */
function ToTestActions({ card, moves }: { readonly card: BoardCardOf; readonly moves: BoardCardMoves }) {
  const { closeLaneId, reworkLaneId } = moves;
  if (closeLaneId === null && reworkLaneId === null) return null;
  return (
    <div className="fy-board-card__verdict">
      {closeLaneId === null ? null : (
        <button
          className="fy-board-verdict"
          data-verdict="works"
          onClick={() => moves.onMove(card, closeLaneId)}
          type="button"
        >
          <Check aria-hidden="true" size={11} />
          Works → Close
        </button>
      )}
      {reworkLaneId === null ? null : (
        <button
          className="fy-board-verdict"
          data-verdict="not-good"
          onClick={() => moves.onMove(card, reworkLaneId)}
          type="button"
        >
          <X aria-hidden="true" size={11} />
          Not good
        </button>
      )}
    </div>
  );
}

/** The keyboard route to moving a card: a menu of lanes, a move back marked as needing a reason. */
function BoardMoveMenu({ card, moves }: { readonly card: BoardCardOf; readonly moves: BoardCardMoves }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only listens for Escape on behalf of its buttons
    <div
      className="fy-board-card__menu"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={onKeyDown}
    >
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Move ${card.task.title} to…`}
        className="fy-board-card__more"
        onClick={() => setOpen(value => !value)}
        title="Move to…"
        type="button"
      >
        <EllipsisVertical aria-hidden="true" size={12} />
      </button>
      {open ? (
        <div aria-label="Move to…" className="fy-board-menu" id={menuId} role="menu">
          {moves.choices.map(choice => (
            <button
              className="fy-board-menu__item"
              data-backward={choice.backward ? '' : undefined}
              key={choice.laneId}
              onClick={() => {
                setOpen(false);
                moves.onMove(card, choice.laneId);
              }}
              role="menuitem"
              title={choice.backward ? 'Moving back asks for a reason' : undefined}
              type="button"
            >
              {choice.backward ? <ChevronLeft aria-hidden="true" size={11} /> : null}
              {choice.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
