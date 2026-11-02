/**
 * ONE BOARD CARD: the title (truncated), its one-line summary (truncated, when it has one), and a meta line of
 * short segments (`&F412 · ● 4m · How to test · PR ✓ · ⛓ 1 · subs 2/3 · owner→assignee`; on a card to test, How to
 * test comes before the activity). A card waiting to be tested that says nothing about how wears a quiet "no test
 * steps" instead.
 *
 * It is the only card renderer. The full-page Board, the phone and the per-chat side pane all draw it, and
 * `density` is the only thing that differs: `side` keeps one short line by dropping the summary and the
 * segments that are marked optional (who, shipped-in, machine).
 *
 * A card is a real link to its detail (`/d/<id>/board/<taskId>`). When the page can move cards it is also
 * draggable, and a "Move to…" menu does the same job from the keyboard; both end in the same `onMove`.
 *
 * `touch` is the phone: thumb-sized targets, no drag (a finger scrolls, it does not drag), and the two
 * answers on a card waiting to be tried drawn as full-width **✓ Done** and **✗ Not good** buttons.
 *
 * The owner's "Done ✓" is the shared `BoardDoneAction`: it is the close on a card in To test (next to Not good),
 * its own row on a Released card, and the first item of the ⋯ menu everywhere ("Reopen" on a closed card).
 *
 * While one of the card's answers is in flight (`answer.pressed`), that button spins and every answer on the
 * card is disabled; a refusal is said on the card itself. The answer buttons WRAP rather than spill: at any
 * column width each keeps its whole label inside the card.
 */

import { formatTaskRef, type LaneCategory } from '@ferretry/protocol';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  EllipsisVertical,
  MessageSquarePlus,
  RotateCcw,
} from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, useId, useState } from 'react';
import {
  ANSWER_AT_REST,
  answerRowOf,
  type BoardAnswer,
  type BoardAnswerState,
  type BoardDone,
  doneLabel,
  doneTitle,
} from '../../lib/board-done.ts';
import type { MoveChoice } from '../../lib/board-move.ts';
import { cardSegments, type FerretNames } from '../../lib/board-present.ts';
import type { BoardCardOf } from '../../lib/board-view.ts';
import { plainPreview } from '../../lib/plain-label.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { AnswerIcon, BoardDoneAction } from './board-done-action.tsx';
import { BoardIcon } from './board-icons.tsx';

export type BoardDensity = 'page' | 'side';

export interface BoardCardMoves {
  /** Every lane the card could go to, for the "Move to…" menu. */
  readonly choices: readonly MoveChoice[];
  /** `answer` names the control that asked, so the page spins THAT one and words a move back for it. */
  readonly onMove: (card: BoardCardOf, laneId: string, answer?: BoardAnswer) => void;
  /** The lane Done closes into; `null` when the project has no Closed lane. */
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
  /** The owner's answer in flight on this card, and the last refusal; at rest when absent. */
  readonly answer?: BoardAnswerState;
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
  answer = ANSWER_AT_REST,
}: BoardCardProps) {
  const { task } = card;
  const preview = plainPreview(task.summary);
  const segments = cardSegments(task, {
    names,
    now,
    category,
    machine: showMachine ? card.machine : null,
  }).filter(segment => density === 'page' || !segment.optional);
  const row = answerRowOf({
    category,
    movable: moves !== undefined,
    done: done?.atRelease ? done.done : null,
  });
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
      data-settling={answer.pressed === null ? undefined : answer.pressed}
      data-touch={touch ? '' : undefined}
      draggable={moves !== undefined && !touch && density === 'page' && answer.pressed === null}
      style={depth === undefined ? undefined : ({ '--fy-board-depth': depth } as CSSProperties)}
      onDragEnd={moves?.onDragEnd}
      onDragStart={
        moves === undefined || density !== 'page'
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
        title={preview === '' ? task.title : `${task.title} — ${preview}`}
        to={href}
      >
        <span className="fy-board-card__title">{task.title}</span>
        {density === 'side' || preview === '' ? null : <span className="fy-board-card__summary">{preview}</span>}
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
        <BoardMoveMenu answer={answer} card={card} done={done} moves={moves} />
      ) : null}
      {row === 'verdict' && moves !== undefined ? (
        <ToTestActions answer={answer} card={card} done={done} moves={moves} touch={touch} />
      ) : null}
      {row === 'done' && done !== undefined ? (
        <div className="fy-board-card__verdict" data-touch={touch ? '' : undefined}>
          <BoardDoneAction
            disabled={answer.pressed !== null}
            done={done.done}
            onPress={done.press}
            pending={answer.pressed === done.done.kind}
            title={task.title}
            touch={touch}
          />
        </div>
      ) : null}
      {answer.error === null ? null : (
        <p className="fy-board-card__error" data-answer-error="" role="alert">
          {answer.error}
        </p>
      )}
    </li>
  );
}

/** The two one-tap answers on a card waiting to be tried: it works, or it does not. A Table row wears the same. */
export function ToTestActions({
  answer,
  card,
  done,
  moves,
  touch,
}: {
  readonly answer: BoardAnswerState;
  readonly card: BoardCardOf;
  readonly done: BoardCardDone | undefined;
  readonly moves: BoardCardMoves;
  readonly touch: boolean;
}) {
  const { closeLaneId, reworkLaneId } = moves;
  if (closeLaneId === null && reworkLaneId === null) return null;
  const size = touch ? 16 : 11;
  const settling = answer.pressed !== null;
  return (
    <div className="fy-board-card__verdict" data-touch={touch ? '' : undefined}>
      {reworkLaneId === null ? null : (
        <button
          aria-busy={answer.pressed === 'not-good'}
          aria-label={touch ? `Not good: send back ${card.task.title}` : undefined}
          className="fy-board-verdict"
          data-pending={answer.pressed === 'not-good' ? '' : undefined}
          data-verdict="not-good"
          disabled={settling}
          onClick={() => moves.onMove(card, reworkLaneId, 'not-good')}
          title="Not good → back for rework, with what is wrong"
          type="button"
        >
          <AnswerIcon icon={ArrowLeft} pending={answer.pressed === 'not-good'} size={size} />
          Not good
        </button>
      )}
      {done?.done.kind === 'done' ? (
        <BoardDoneAction
          arrow
          disabled={settling}
          done={done.done}
          onPress={done.press}
          pending={answer.pressed === 'done'}
          title={card.task.title}
          touch={touch}
        />
      ) : closeLaneId === null ? null : (
        <button
          aria-busy={answer.pressed === 'works'}
          aria-label={doneTitle({ kind: 'done', laneId: closeLaneId }, card.task.title)}
          className="fy-board-verdict"
          data-pending={answer.pressed === 'works' ? '' : undefined}
          data-verdict="works"
          disabled={settling}
          onClick={() => moves.onMove(card, closeLaneId, 'works')}
          title={doneTitle({ kind: 'done', laneId: closeLaneId }, card.task.title)}
          type="button"
        >
          Done
          <AnswerIcon icon={ArrowRight} pending={answer.pressed === 'works'} size={size} />
        </button>
      )}
    </div>
  );
}

/** The keyboard route to moving a card: a menu of lanes, a move back marked as needing a reason. */
function BoardMoveMenu({
  answer,
  card,
  done,
  moves,
}: {
  readonly answer: BoardAnswerState;
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
        disabled={answer.pressed !== null}
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
                moves.onMove(card, choice.laneId, 'move');
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
