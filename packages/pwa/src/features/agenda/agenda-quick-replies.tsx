/**
 * THE QUICK REPLIES OF AN OPEN AGENDA ITEM — a wrapping row of compact chips directly above the REAL composer
 * (never covering it). The item's options are the chips, the recommended one tagged "Recommended"; a tap answers
 * at once. Answering is replying, so there is no text field here: the composer below is the one box, and what is
 * typed in it rides an answer as its note.
 *
 * On touch the chips swipe (← ↑ →) exactly as the Inbox deck does (`swipeIntent`), and ↓ goes back to the chat.
 * An item answered one answer per question draws its chips beside each question; this row then holds the one
 * compact "Send answers" (and "All recommended" when every question has a pick to agree with).
 */

import type { AgendaCardAnswer } from '@ferretry/protocol';
import { ArrowLeft, ArrowRight, ArrowUp, Check, LoaderCircle, Send } from 'lucide-react';
import { type PointerEvent, type ReactNode, useRef, useState } from 'react';
import { type AnswerDirection, answerAction, CLEAR_ACTION, optionAction } from '../../lib/agenda-answers.ts';
import type { CardModel } from '../../lib/agenda-card-model.ts';
import {
  DISMISS_ACTION,
  type InboxAction,
  SWIPE_SLOP_PX,
  type SwipeDirection,
  type SwipeMap,
  swipeIntent,
} from '../../lib/agenda-inbox.ts';
import { ActionMenu, RecommendedTag } from './agenda-actions.tsx';
import { isDownSwipe } from './use-down-swipe.ts';

const ARROWS: Readonly<Record<AnswerDirection, ReactNode>> = {
  left: <ArrowLeft size={13} aria-hidden="true" />,
  up: <ArrowUp size={13} aria-hidden="true" />,
  right: <ArrowRight size={13} aria-hidden="true" />,
};

const SWIPE_WORD: Readonly<Record<AnswerDirection, string>> = {
  left: 'swipe left',
  up: 'swipe up',
  right: 'swipe right',
};

const STAMP: Readonly<Record<SwipeDirection, string>> = { left: '←', up: '↑', right: '→' };

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
  /** What each swipe sends, by direction. */
  readonly map: SwipeMap;
  readonly busy: boolean;
  readonly error: string | null;
  /** The ferret's name, for "With Piper — it will update this." Absent: the item is not waiting on it. */
  readonly waitingOn?: string;
  /** The primary pointer is touch: chips swipe and say their direction. */
  readonly swipeable: boolean;
  readonly sending?: QuestionSending;
  /** One answer; the host adds the composer's text as its note. */
  readonly onAct: (action: InboxAction) => void;
  /** Back to the chat (the ↓ swipe). */
  readonly onClose: () => void;
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
  readonly hint?: string | undefined;
  readonly recommended: boolean;
  readonly busy: boolean;
  readonly arrow?: AnswerDirection | undefined;
  readonly swipeable: boolean;
  readonly primary?: boolean;
  readonly onTap: () => void;
  readonly option: string;
}

function Chip({ label, hint, recommended, busy, arrow, swipeable, primary = false, onTap, option }: ChipProps) {
  return (
    <button
      className="kt-btn fy-qr__chip"
      data-agenda-answer={arrow}
      data-agenda-option={option}
      data-recommended={recommended || undefined}
      data-variant={primary ? 'primary' : undefined}
      disabled={busy}
      onClick={onTap}
      title={hint}
      type="button"
    >
      {arrow !== undefined && swipeable ? ARROWS[arrow] : null}
      <span className="fy-qr__label">{label}</span>
      {recommended ? <RecommendedTag /> : null}
      {arrow !== undefined && swipeable ? <span className="sr-only">, or {SWIPE_WORD[arrow]}</span> : null}
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

function Stamp({
  drag,
  map,
}: {
  readonly drag: { readonly dx: number; readonly dy: number; readonly width: number };
  readonly map: SwipeMap;
}) {
  if (drag.dy > Math.abs(drag.dx)) {
    return (
      <p
        aria-hidden="true"
        className="fy-qr__stamp"
        data-committed={isDownSwipe(drag.dx, drag.dy, drag.width) || undefined}
        data-swipe="down"
      >
        ↓ Back to the chat
      </p>
    );
  }
  const intent = swipeIntent(drag.dx, drag.dy, drag.width, map);
  const aiming = intent.direction === null ? undefined : map[intent.direction];
  if (intent.direction === null || aiming === undefined) return null;
  return (
    <p
      aria-hidden="true"
      className="fy-qr__stamp"
      data-committed={intent.committed || undefined}
      data-swipe={intent.direction}
    >
      {`${STAMP[intent.direction]} ${aiming.label}`}
    </p>
  );
}

/** Whether the row has anything to draw: chips, a clear, a send, a waiting line or an error. */
const hasReplies = (model: CardModel, sending: QuestionSending | undefined): boolean =>
  model.notice || sending !== undefined || model.answers.length > 0 || model.extras.length > 0;

export function AgendaQuickReplies({
  model,
  map,
  busy,
  error,
  waitingOn,
  swipeable,
  sending,
  onAct,
  onClose,
}: AgendaQuickRepliesProps) {
  const [drag, setDrag] = useState<{ readonly dx: number; readonly dy: number; readonly width: number } | null>(null);
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
    setDrag({ dx, dy, width: current.width });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDrag(null);
    if (!current.moved) return;
    swallow.current = true;
    if (isDownSwipe(current.dx, current.dy, current.width)) {
      onClose();
      return;
    }
    const intent = swipeIntent(current.dx, current.dy, current.width, map);
    const action = intent.committed && intent.direction !== null ? map[intent.direction] : undefined;
    if (action !== undefined) give(action);
  };
  const onPointerCancel = (): void => {
    gesture.current = null;
    setDrag(null);
  };

  const recommended = model.recommended;
  const showMenu = model.dismissInMenu && !model.notice;
  if (!hasReplies(model, sending) && error === null && waitingOn === undefined) return null;
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
      {drag === null ? null : <Stamp drag={drag} map={map} />}
      {error === null ? null : (
        <p className="fy-qr__error m-0" role="alert">
          Not sent: {error}
        </p>
      )}
      {waitingOn === undefined ? null : (
        <p className="fy-qr__note m-0" data-agenda-waiting="" role="status">
          With {waitingOn} — it will update this.
        </p>
      )}
      <fieldset aria-label="Quick replies" className="fy-qr__row">
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
        {model.answers.map(answer => (
          <AnswerChip
            answer={answer}
            busy={busy}
            give={give}
            key={answer.direction}
            recommended={recommended}
            swipeable={swipeable}
          />
        ))}
        {model.extras.map(option => (
          <Chip
            busy={busy}
            hint={option.description}
            key={option.label}
            label={option.label}
            onTap={() => give(optionAction(option, ''))}
            option={option.label}
            recommended={sameLabel(option.label, recommended)}
            swipeable={swipeable}
          />
        ))}
        {sending === undefined ? null : <QuestionChips busy={busy} sending={sending} />}
        {showMenu ? <ActionMenu busy={busy} onDismiss={() => give(DISMISS_ACTION)} /> : null}
      </fieldset>
    </div>
  );
}

function AnswerChip({
  answer,
  busy,
  give,
  recommended,
  swipeable,
}: {
  readonly answer: AgendaCardAnswer;
  readonly busy: boolean;
  readonly give: (action: InboxAction) => void;
  readonly recommended: string | undefined;
  readonly swipeable: boolean;
}) {
  return (
    <Chip
      arrow={answer.direction}
      busy={busy}
      hint={answer.description}
      label={answer.label}
      onTap={() => {
        const action = answerAction(answer, '');
        if (action !== null) give(action);
      }}
      option={answer.label}
      primary={answer.direction === 'right'}
      recommended={sameLabel(answer.label, recommended)}
      swipeable={swipeable}
    />
  );
}
