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
 *
 * `touch` is the phone: thumb-sized targets, no drag (a finger scrolls, it does not drag), and the two
 * answers on a card waiting to be tried drawn as full-width **✓ Works** and **✗ Not good** buttons.
 *
 * The owner's "Done ✓" is the shared `BoardDoneAction`: it is the close on a card in To test (next to Not good),
 * its own row on a Released card, and the first item of the ⋯ menu everywhere ("Reopen" on a closed card).
 */

import { formatTaskRef, type LaneCategory } from '@ferretry/protocol';
import { Check, ChevronLeft, EllipsisVertical, MessageSquarePlus, RotateCcw, X } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, useId, useState } from 'react';
import { type BoardDone, doneLabel, doneTitle } from '../../lib/board-done.ts';
import type { MoveChoice } from '../../lib/board-move.ts';
import { cardSegments, type FerretNames } from '../../lib/board-present.ts';
import type { BoardCardOf } from '../../lib/board-view.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { BoardDoneAction } from './board-done-action.tsx';
import { BoardIcon } from './board-icons.tsx';

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

/** The owner's Done (or Reopen) on a card, and what pressing it does. */
interface BoardCardDone {
  readonly done: BoardDone;
  readonly press: () => void;
  readonly atRelease: boolean;
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
  /** Present where the owner may close (or reopen) this card from the view; never in a ferret's own scope. */
  readonly done?: BoardCardDone;
  readonly dragging?: boolean;
  /** The lane's name, shown first on the meta line (List and Tree, where cards are not under a lane header). */
  readonly lane?: string;
  /** Nesting under a lead, for the Tree. */
  readonly depth?: number;
  /** Present where a card can be pointed at from a chat (the per-chat Tasks tab): puts the card's `&F18` in the draft. */
  readonly onAddToChat?: (card: BoardCardOf) => void;
  /** A phone: bigger targets, the verdict buttons spelled out, no drag. */
  readonly touch?: boolean;
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
  done,
  dragging = false,
  lane,
  depth,
  onAddToChat,
  touch = false,
}: BoardCardProps) {
  const { task } = card;
  const segments = cardSegments(task, {
    names,
    now,
    category,
    machine: showMachine ? card.machine : null,
  }).filter(segment => density === 'page' || !segment.optional);
  const toTest = moves !== undefined && density === 'page' && category === 'verify';
  const released = done !== undefined && done.atRelease && done.done.kind === 'done' && density === 'page';
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
      data-touch={touch ? '' : undefined}
      draggable={moves !== undefined && !touch}
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
              {segment.icon === null ? null : <BoardIcon name={segment.icon} />}
              {segment.text}
            </span>
          ))}
        </span>
      </RouteLink>
      {onAddToChat === undefined ? null : (
        <button
          aria-label={`Add ${formatTaskRef(task)} to chat`}
          className="fy-board-card__chat"
          data-add-to-chat={task.id}
          onClick={() => onAddToChat(card)}
          title="Add to chat"
          type="button"
        >
          <MessageSquarePlus aria-hidden="true" size={12} />
        </button>
      )}
      {moves !== undefined && (moves.choices.length > 0 || done !== undefined) ? (
        <BoardMoveMenu card={card} done={done} moves={moves} />
      ) : null}
      {toTest ? <ToTestActions card={card} done={done} moves={moves} touch={touch} /> : null}
      {released ? (
        <div className="fy-board-card__verdict" data-touch={touch ? '' : undefined}>
          <BoardDoneAction done={done.done} onPress={done.press} title={task.title} touch={touch} />
        </div>
      ) : null}
    </li>
  );
}

/** The two one-tap answers on a card waiting to be tried: it works, or it does not. */
function ToTestActions({
  card,
  done,
  moves,
  touch,
}: {
  readonly card: BoardCardOf;
  readonly done: BoardCardDone | undefined;
  readonly moves: BoardCardMoves;
  readonly touch: boolean;
}) {
  const { closeLaneId, reworkLaneId } = moves;
  if (closeLaneId === null && reworkLaneId === null) return null;
  const size = touch ? 16 : 11;
  return (
    <div className="fy-board-card__verdict" data-touch={touch ? '' : undefined}>
      {done?.done.kind === 'done' ? (
        <BoardDoneAction done={done.done} onPress={done.press} title={card.task.title} touch={touch} />
      ) : closeLaneId === null ? null : (
        <button
          aria-label={touch ? `Works: close ${card.task.title}` : undefined}
          className="fy-board-verdict"
          data-verdict="works"
          onClick={() => moves.onMove(card, closeLaneId)}
          title="Works → Close"
          type="button"
        >
          <Check aria-hidden="true" size={size} />
          {touch ? 'Works' : 'Close'}
        </button>
      )}
      {reworkLaneId === null ? null : (
        <button
          aria-label={touch ? `Not good: send back ${card.task.title}` : undefined}
          className="fy-board-verdict"
          data-verdict="not-good"
          onClick={() => moves.onMove(card, reworkLaneId)}
          title="Not good → back for rework"
          type="button"
        >
          <X aria-hidden="true" size={size} />
          Not good
        </button>
      )}
    </div>
  );
}

/** The keyboard route to moving a card: a menu of lanes, a move back marked as needing a reason. */
function BoardMoveMenu({
  card,
  done,
  moves,
}: {
  readonly card: BoardCardOf;
  readonly done: BoardCardDone | undefined;
  readonly moves: BoardCardMoves;
}) {
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
          {done === undefined ? null : (
            <button
              className="fy-board-menu__item"
              data-done={done.done.kind}
              onClick={() => {
                setOpen(false);
                done.press();
              }}
              role="menuitem"
              title={doneTitle(done.done, card.task.title)}
              type="button"
            >
              {done.done.kind === 'reopen' ? (
                <RotateCcw aria-hidden="true" size={11} />
              ) : (
                <Check aria-hidden="true" size={11} />
              )}
              {doneLabel(done.done)}
            </button>
          )}
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
