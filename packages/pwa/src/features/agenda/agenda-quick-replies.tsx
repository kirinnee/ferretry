/**
 * THE ANSWER ROW OF AN OPEN AGENDA CARD — ONE ROW, at most THREE buttons, in DIRECTION order: the ← answer, the ↑
 * (recommended) one, the → one, each the swipe that sends it. A direction with no answer draws NOTHING: the buttons
 * there share the width, never a hole. Each is SHORT: the option's one-word name or its letter (`cardLettered`), one
 * way per row, never wrapped; the full label is its accessible name and its title. The recommended one is in the
 * accent. A tap answers at once. Options past the three are chosen from the card's options list, never a second row.
 * "Not needed" is the ↓ swipe and the pill in the card's top bar, not a button here. Answering is replying, so there
 * is no text field: the composer below the card is the one box, and what is typed in it rides an answer as its note.
 *
 * On touch the row swipes (← ↑ →) exactly as the Inbox deck does (`swipeIntent`), and ↓ is `onDown` — Not needed.
 * An item linked to a card the owner may close also draws "Done · closes &F12" in the → slot when it is free; with
 * all three taken it is the one button under the row, tap only — a swipe never closes a card.
 * A card answered in words (an open question, several questions, a mix) draws NO buttons here: the composer is the
 * answer. A review's "Request changes" is a button, never a swipe: it takes the composer's words, or puts the owner
 * in the composer when it is empty. A notice's one button is Got it.
 */

import type { AgendaAskOption, AgendaCardAnswer } from '@ferretry/protocol';
import { GOT_IT_LABEL } from '@ferretry/protocol';
import { Check } from 'lucide-react';
import { type PointerEvent, useRef } from 'react';
import { type AnswerDirection, answerAction, CLEAR_ACTION } from '../../lib/agenda-answers.ts';
import type { CardModel } from '../../lib/agenda-card-model.ts';
import { type InboxAction, SWIPE_SLOP_PX, type SwipeMap, swipeIntent } from '../../lib/agenda-inbox.ts';
import { cardLettered, letterOf } from '../../lib/agenda-options.ts';
import { DoneCloseChip, DoneCloseConfirm, DoneCloseError } from './agenda-done-close.tsx';
import type { DoneCloseView } from './use-done-close-flow.ts';
import { isDownSwipe } from './use-down-swipe.ts';

const SWIPE_WORD: Readonly<Record<AnswerDirection, string>> = {
  left: 'swipe left',
  up: 'swipe up',
  right: 'swipe right',
};

/** The swipe (and the arrow key) each slot answers to, drawn on its button. */
const ARROW: Readonly<Record<AnswerDirection, string>> = { left: '←', up: '↑', right: '→' };

const sameLabel = (a: string, b: string | undefined): boolean =>
  b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A review's Request changes: drawn in its own direction's slot, tapped only. */
export interface RequestChanges {
  readonly answer: AgendaCardAnswer;
  readonly onTap: () => void;
}

export interface AgendaQuickRepliesProps {
  readonly model: CardModel;
  /** The item's options in ask order: a button's letter is its place here, the same letter the Options section shows. */
  readonly options?: readonly AgendaAskOption[];
  /** What each swipe sends, by direction. */
  readonly map: SwipeMap;
  readonly busy: boolean;
  readonly error: string | null;
  /** The ferret's name, for "With Piper — it will update this." Absent: the item is not waiting on it. */
  readonly waitingOn?: string;
  /** The primary pointer is touch: chips swipe and say their direction. */
  readonly swipeable: boolean;
  /** A review's Request changes, when the host can take the owner to the composer. */
  readonly requestChanges?: RequestChanges;
  /** "Done · closes &F12": absent when the item offers no card to close. */
  readonly doneClose?: DoneCloseView;
  /** One answer; the host adds the composer's text as its note. */
  readonly onAct: (action: InboxAction) => void;
  /** The ↓ swipe: Not needed (the host dismisses), or nothing where the item cannot be dismissed. */
  readonly onDown?: (() => void) | undefined;
}

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  moved: boolean;
  dx: number;
  dy: number;
}

interface ChipProps {
  readonly label: string;
  readonly letter: string | undefined;
  /** The options are named by letter (`cardLettered`), so an option's button says its letter. */
  readonly lettered: boolean;
  readonly recommended: boolean;
  readonly busy: boolean;
  readonly arrow?: AnswerDirection | undefined;
  readonly swipeable: boolean;
  readonly primary?: boolean;
  readonly onTap: () => void;
}

/** What a screen reader says: the full label, then whether it is the pick and which way it swipes. */
const chipName = (label: string, recommended: boolean, swipe: string | null): string =>
  [label, recommended ? 'recommended' : null, swipe === null ? null : `or ${swipe}`].filter(Boolean).join(', ');

function Chip({ label, letter, lettered, recommended, busy, arrow, swipeable, primary = false, onTap }: ChipProps) {
  return (
    <button
      aria-label={chipName(label, recommended, arrow !== undefined && swipeable ? SWIPE_WORD[arrow] : null)}
      className="kt-btn fy-qr__chip"
      data-agenda-answer={arrow}
      data-agenda-option={label}
      data-recommended={recommended || undefined}
      data-variant={primary ? 'primary' : undefined}
      disabled={busy}
      onClick={onTap}
      title={label}
      type="button"
    >
      {arrow === undefined ? null : (
        <span aria-hidden="true" className="fy-qr__arrow">
          {ARROW[arrow]}
        </span>
      )}
      <span className="fy-qr__label">{lettered && letter !== undefined ? letter : label}</span>
    </button>
  );
}

/** One button of the row: an answer the card gives, in the slot of its swipe direction. */
interface Reply {
  readonly label: string;
  readonly letter: string | undefined;
  readonly answer: AgendaCardAnswer;
  /** Tapped only, with its own handling (Request changes); absent: the answer is sent as it is. */
  readonly onTap?: () => void;
}

/** Where a direction sits in the row, read left to right: ← ↑ →. */
const ROW_ORDER: Readonly<Record<string, number>> = { left: 0, up: 1, right: 2 };

/** The row's buttons, in ← ↑ → order: the card's answers (three at most), each with its letter among the item's options. */
const repliesOf = (
  model: CardModel,
  options: readonly AgendaAskOption[],
  requestChanges: RequestChanges | undefined,
): readonly Reply[] =>
  [
    ...model.answers.map(answer => ({ label: answer.label, letter: letterOf(options, answer.label), answer })),
    ...(requestChanges === undefined
      ? []
      : [
          {
            label: requestChanges.answer.label,
            letter: undefined,
            answer: requestChanges.answer,
            onTap: requestChanges.onTap,
          },
        ]),
  ].toSorted((a, b) => (ROW_ORDER[a.answer.direction] ?? 3) - (ROW_ORDER[b.answer.direction] ?? 3));

/** Whether the row has anything to draw: chips, a Got it, a waiting line or an error. */
const hasReplies = (model: CardModel, requestChanges: RequestChanges | undefined): boolean =>
  model.notice || requestChanges !== undefined || model.answers.length > 0;

export function AgendaQuickReplies({
  model,
  options = [],
  map,
  busy,
  error,
  waitingOn,
  swipeable,
  requestChanges,
  doneClose,
  onAct,
  onDown,
}: AgendaQuickRepliesProps) {
  const gesture = useRef<Drag | null>(null);
  const swallow = useRef(false);
  const give = (action: InboxAction): void => {
    if (!busy) onAct(action);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!swipeable || busy || event.pointerType === 'mouse') return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: event.currentTarget.getBoundingClientRect().width,
      moved: false,
      dx: 0,
      dy: 0,
    };
    swallow.current = false;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < SWIPE_SLOP_PX) return;
    current.moved = true;
    current.dx = dx;
    current.dy = dy;
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!current.moved) return;
    swallow.current = true;
    if (isDownSwipe(current.dx, current.dy, current.width)) {
      onDown?.();
      return;
    }
    const intent = swipeIntent(current.dx, current.dy, current.width, map);
    const action = intent.committed && intent.direction !== null ? map[intent.direction] : undefined;
    if (action !== undefined) give(action);
  };
  const onPointerCancel = (): void => {
    gesture.current = null;
  };

  const recommended = model.recommended;
  const replies = repliesOf(model, options, requestChanges);
  const slotted = replies.length > 0 && !model.notice;
  // The row reads the way the options list does: one label that is not a single short word letters every option.
  const lettered = cardLettered(options);
  // "Done · closes &F12" takes the → slot when the card gave fewer than three answers; with three it sits under them.
  const closeInRow = doneClose !== undefined && replies.length < 3;
  if (!hasReplies(model, requestChanges) && doneClose === undefined && error === null && waitingOn === undefined)
    return null;
  return (
    <div
      className="fy-qr"
      data-agenda-quick-replies=""
      data-swipeable={swipeable || undefined}
      onClickCapture={event => {
        if (!swallow.current) return;
        event.preventDefault();
        event.stopPropagation();
        swallow.current = false;
      }}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {error === null ? null : (
        <p className="fy-qr__error m-0" role="alert">
          Not sent: {error}
        </p>
      )}
      {doneClose === undefined ? null : <DoneCloseError view={doneClose} />}
      {doneClose === undefined ? null : <DoneCloseConfirm view={doneClose} />}
      {waitingOn === undefined ? null : (
        <p className="fy-qr__note m-0" data-agenda-waiting="" role="status">
          With {waitingOn} — it will update this.
        </p>
      )}
      <fieldset
        aria-label="Quick replies"
        className="fy-qr__row"
        data-slots={slotted || undefined}
        data-wraps={closeInRow || undefined}
      >
        {model.notice ? (
          <button
            className="kt-btn fy-qr__chip"
            data-agenda-clear=""
            data-variant="primary"
            disabled={busy}
            onClick={() => give(CLEAR_ACTION)}
            type="button"
          >
            <Check aria-hidden="true" size={13} />
            {GOT_IT_LABEL}
          </button>
        ) : null}
        {replies.map(reply => (
          <AnswerChip
            answer={reply.answer}
            busy={busy}
            give={give}
            key={reply.label}
            letter={reply.letter}
            lettered={lettered}
            recommended={recommended}
            swipeable={swipeable}
            {...(reply.onTap === undefined ? {} : { onTap: reply.onTap })}
          />
        ))}
        {closeInRow ? <DoneCloseChip disabled={busy} view={doneClose} /> : null}
      </fieldset>
      {doneClose === undefined || closeInRow ? null : (
        <div className="fy-qr__under" data-agenda-more-row="">
          <DoneCloseChip disabled={busy} view={doneClose} />
        </div>
      )}
    </div>
  );
}

function AnswerChip({
  answer,
  busy,
  give,
  letter,
  lettered,
  recommended,
  swipeable,
  onTap,
}: {
  readonly answer: AgendaCardAnswer;
  readonly busy: boolean;
  readonly give: (action: InboxAction) => void;
  readonly letter: string | undefined;
  readonly lettered: boolean;
  readonly recommended: string | undefined;
  readonly swipeable: boolean;
  /** A button with its own handling: tapped only, so it says no swipe direction. */
  readonly onTap?: (() => void) | undefined;
}) {
  return (
    <Chip
      arrow={onTap === undefined ? answer.direction : undefined}
      busy={busy}
      label={answer.label}
      letter={letter}
      lettered={lettered}
      onTap={() => {
        if (onTap !== undefined) {
          if (!busy) onTap();
          return;
        }
        const action = answerAction(answer, '');
        if (action !== null) give(action);
      }}
      primary={sameLabel(answer.label, recommended)}
      recommended={sameLabel(answer.label, recommended)}
      swipeable={swipeable}
    />
  );
}
