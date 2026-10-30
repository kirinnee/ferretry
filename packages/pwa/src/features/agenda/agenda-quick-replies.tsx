/**
 * THE QUICK REPLIES OF AN OPEN AGENDA ITEM — ONE ROW OF EVERY ACTION, directly above the REAL composer (never
 * covering it) and on the card body's edges: at most THREE answer buttons in DIRECTION order — the ← answer, the
 * ↑ (recommended) one, the → one — then a quiet "Not needed". A direction with no answer draws NOTHING: the
 * buttons there share the width, never a hole (owner: "doesn't waste so much space"). Each is SHORT: its letter
 * ("A", "B"), or its label when that is one or two words ("Looks good"), one way per row, never wrapped; the full
 * label is its accessible name and its title. The recommended one is in the accent. A tap answers at once.
 * Options past the three swiped ones are the same buttons in full-width rows under it, tap only. Answering is
 * replying, so there is no text field here: the composer below is the one box, and what is typed in it rides an
 * answer as its note.
 *
 * On touch the row swipes (← ↑ →) exactly as the Inbox deck does (`swipeIntent`), and ↓ SKIPS: on to the next
 * item, or back to the chat when there is none.
 * An item linked to a card the owner may close also draws "Done · closes &F12": one more answer, in the → slot
 * when it is free and in the full-width row otherwise, tap only — a swipe never closes a card.
 * An item answered one answer per question draws its chips beside each question; this row then holds the one
 * compact "Send answers" (and "All recommended" when every question has a pick to agree with).
 */

import type { AgendaAskOption, AgendaCardAnswer } from '@ferretry/protocol';
import { Check, LoaderCircle, Send } from 'lucide-react';
import { type PointerEvent, useRef } from 'react';
import { type AnswerDirection, answerAction, CLEAR_ACTION, optionAction } from '../../lib/agenda-answers.ts';
import type { CardModel } from '../../lib/agenda-card-model.ts';
import { DISMISS_ACTION, type InboxAction, SWIPE_SLOP_PX, type SwipeMap, swipeIntent } from '../../lib/agenda-inbox.ts';
import { letterOf, rowLettered, shortLabel } from '../../lib/agenda-options.ts';
import { DoneCloseChip, DoneCloseConfirm, DoneCloseError } from './agenda-done-close.tsx';
import type { DoneCloseView } from './use-done-close-flow.ts';
import { isDownSwipe } from './use-down-swipe.ts';

const SWIPE_WORD: Readonly<Record<AnswerDirection, string>> = {
  left: 'swipe left',
  up: 'swipe up',
  right: 'swipe right',
};

const sameLabel = (a: string, b: string | undefined): boolean =>
  b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/** What an item answered one answer per question lets the row do. */
export interface QuestionSending {
  /** Every question that has options has a pick. */
  readonly ready: boolean;
  /** Every such question has a recommendation that names one of its options. */
  readonly canUseRecommended: boolean;
  readonly onSend: () => void;
  readonly onUseRecommended: () => void;
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
  readonly sending?: QuestionSending;
  /** "Done · closes &F12": absent when the item offers no card to close. */
  readonly doneClose?: DoneCloseView;
  /** One answer; the host adds the composer's text as its note. */
  readonly onAct: (action: InboxAction) => void;
  /** The ↓ swipe: skip to the next item, or back to the chat when there is none. */
  readonly onSkip: () => void;
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
  /** The row is drawn as letters (`rowLettered`), so this button is too. */
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
      <span className="fy-qr__label">{shortLabel(label, letter, lettered)}</span>
    </button>
  );
}

function QuestionChips({ sending, busy }: { readonly sending: QuestionSending; readonly busy: boolean }) {
  return (
    <>
      {sending.canUseRecommended ? (
        <button
          className="kt-btn fy-qr__chip"
          data-agenda-use-recommended=""
          disabled={busy}
          onClick={sending.onUseRecommended}
          type="button"
        >
          <Check aria-hidden="true" size={13} />
          All recommended
        </button>
      ) : null}
      <button
        className="kt-btn fy-qr__chip"
        data-agenda-send-answers=""
        data-variant="primary"
        disabled={busy || !sending.ready}
        onClick={sending.onSend}
        type="button"
      >
        {busy ? (
          <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <Send size={13} aria-hidden="true" />
        )}
        Send answers
      </button>
    </>
  );
}

/** One button of the row: an answer the card gives, in the slot of its swipe direction. */
interface Reply {
  readonly label: string;
  readonly letter: string | undefined;
  readonly answer: AgendaCardAnswer;
}

/** Where a direction sits in the row, read left to right: ← ↑ →. */
const ROW_ORDER: Readonly<Record<string, number>> = { left: 0, up: 1, right: 2 };

/** The row's buttons, in ← ↑ → order: the card's answers (three at most), each with its letter among the item's options. */
const repliesOf = (model: CardModel, options: readonly AgendaAskOption[]): readonly Reply[] =>
  model.answers
    .map(answer => ({ label: answer.label, letter: letterOf(options, answer.label), answer }))
    .toSorted((a, b) => (ROW_ORDER[a.answer.direction] ?? 3) - (ROW_ORDER[b.answer.direction] ?? 3));

/** Whether the row has anything to draw: chips, a clear, a send, a waiting line or an error. */
const hasReplies = (model: CardModel, sending: QuestionSending | undefined): boolean =>
  model.notice || sending !== undefined || model.answers.length > 0 || model.extras.length > 0;

export function AgendaQuickReplies({
  model,
  options = [],
  map,
  busy,
  error,
  waitingOn,
  swipeable,
  sending,
  doneClose,
  onAct,
  onSkip,
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
      onSkip();
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
  // Options past the swiped three: a second, full-width row of the same buttons, tap only — never a menu.
  const extras = model.extras.map(option => ({ option, label: option.label, letter: letterOf(options, option.label) }));
  const canDismiss = model.dismissInMenu && !model.notice;
  const replies = repliesOf(model, options);
  const slotted = replies.length > 0 && sending === undefined && !model.notice;
  // Every row reads one way: one long label letters the swipe row AND the rows under it.
  const lettered = rowLettered([...replies, ...extras]);
  // The → slot is free when the card gave fewer than three answers and the row is not the per-question one.
  const closeInRow = doneClose !== undefined && replies.length < 3 && sending === undefined;
  if (!hasReplies(model, sending) && doneClose === undefined && error === null && waitingOn === undefined) return null;
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
            Clear
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
          />
        ))}
        {closeInRow ? <DoneCloseChip disabled={busy} view={doneClose} /> : null}
        {sending === undefined ? null : <QuestionChips busy={busy} sending={sending} />}
        {canDismiss ? <NotNeeded busy={busy} give={give} /> : null}
      </fieldset>
      <MoreChoices
        busy={busy}
        close={closeInRow ? undefined : doneClose}
        extras={extras}
        give={give}
        lettered={lettered}
      />
    </div>
  );
}

/** "Not needed": a plain, quiet text button, last in the one row of actions. */
function NotNeeded({ busy, give }: { busy: boolean; give: (action: InboxAction) => void }) {
  return (
    <button
      className="fy-qr__dismiss"
      data-agenda-dismiss=""
      disabled={busy}
      onClick={() => give(DISMISS_ACTION)}
      type="button"
    >
      Not needed
    </button>
  );
}

/** The options past the swiped three: rows of the same buttons filling the width, tap only (no swipe reaches them). */
function MoreChoices({
  extras,
  busy,
  lettered,
  give,
  close,
}: {
  readonly close?: DoneCloseView | undefined;
  readonly extras: readonly {
    readonly option: AgendaAskOption;
    readonly label: string;
    readonly letter: string | undefined;
  }[];
  readonly busy: boolean;
  readonly lettered: boolean;
  readonly give: (action: InboxAction) => void;
}) {
  if (extras.length === 0 && close === undefined) return null;
  return (
    <fieldset aria-label="More choices" className="fy-qr__row fy-qr__more" data-agenda-more-row="">
      {close === undefined ? null : <DoneCloseChip disabled={busy} view={close} />}
      {extras.map(extra => (
        <Chip
          busy={busy}
          key={extra.label}
          label={extra.label}
          letter={extra.letter}
          lettered={lettered}
          onTap={() => give(optionAction(extra.option, ''))}
          recommended={false}
          swipeable={false}
        />
      ))}
    </fieldset>
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
}: {
  readonly answer: AgendaCardAnswer;
  readonly busy: boolean;
  readonly give: (action: InboxAction) => void;
  readonly letter: string | undefined;
  readonly lettered: boolean;
  readonly recommended: string | undefined;
  readonly swipeable: boolean;
}) {
  return (
    <Chip
      arrow={answer.direction}
      busy={busy}
      label={answer.label}
      letter={letter}
      lettered={lettered}
      onTap={() => {
        const action = answerAction(answer, '');
        if (action !== null) give(action);
      }}
      primary={sameLabel(answer.label, recommended)}
      recommended={sameLabel(answer.label, recommended)}
      swipeable={swipeable}
    />
  );
}
