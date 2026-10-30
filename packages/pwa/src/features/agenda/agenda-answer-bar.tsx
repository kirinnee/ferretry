/**
 * THE ACTION BAR OF AN ITEM VIEW — the bottom of the screen while an agenda item is open, in the composer's
 * place. The answers are the big buttons (`AgendaActions`: the card's own answers, the recommended one on the
 * right), "Add to reply" puts the item into the next chat message without answering it, and the text field
 * below sends what is typed AS A REPLY ABOUT THIS ITEM. An answer carries the field's text as its note.
 *
 * On touch the answers swipe (← ↑ →) over the buttons; a drag shows what it would send and commits only past
 * the threshold, exactly the thresholds the Inbox deck reads (`swipeIntent`). On a mouse nothing swipes and no
 * arrows are drawn; the item view takes the arrow keys.
 */

import type { AgendaAskOption, AgendaCardAnswer, AgendaItem } from '@ferretry/protocol';
import { MessageSquarePlus, Send } from 'lucide-react';
import { type PointerEvent, useRef, useState } from 'react';
import { answerAction, CLEAR_ACTION, optionAction } from '../../lib/agenda-answers.ts';
import type { CardModel } from '../../lib/agenda-card-model.ts';
import {
  DISMISS_ACTION,
  type InboxAction,
  SWIPE_SLOP_PX,
  type SwipeDirection,
  type SwipeMap,
  swipeIntent,
} from '../../lib/agenda-inbox.ts';
import { AgendaActions } from './agenda-actions.tsx';
import { isDownSwipe } from './use-down-swipe.ts';

export interface AgendaAnswerBarProps {
  readonly item: AgendaItem;
  readonly model: CardModel;
  /** What each swipe or arrow key sends, by direction. */
  readonly map: SwipeMap;
  readonly busy: boolean;
  readonly error: string | null;
  readonly ferret: string;
  /** The primary pointer is touch: answers swipe and say their direction. */
  readonly swipeable: boolean;
  /** Several questions: the one "Send answers" button, and whether it can send yet. */
  readonly sendAnswers?: { readonly ready: boolean; readonly onSend: (note: string) => void };
  /** An answer, carrying the field's text as its note. */
  readonly onAct: (action: InboxAction, note: string) => void;
  /** Adds the item to the next reply and returns to the chat. */
  readonly onReply: (typed: string) => void;
  /** Back to the chat (the ↓ swipe on the answers). */
  readonly onClose: () => void;
  /** Sends the field's text as a reply about this item; resolves once sent. */
  readonly onSend: (text: string) => Promise<void>;
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

const STAMP: Readonly<Record<SwipeDirection, string>> = { left: '←', up: '↑', right: '→' };

export function AgendaAnswerBar({
  item,
  model,
  map,
  busy,
  error,
  ferret,
  swipeable,
  sendAnswers,
  onAct,
  onReply,
  onClose,
  onSend,
}: AgendaAnswerBarProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ readonly dx: number; readonly dy: number; readonly width: number } | null>(null);
  const gesture = useRef<Drag | null>(null);
  const swallow = useRef(false);
  const give = (action: InboxAction): void => {
    if (!busy) onAct(action, text);
  };

  const submit = (): void => {
    const typed = text.trim();
    if (typed === '' || sending) return;
    setSending(true);
    setFailed(null);
    onSend(typed).then(
      () => {
        setSending(false);
        setText('');
      },
      (reason: unknown) => {
        setSending(false);
        setFailed(reason instanceof Error ? reason.message : 'The message did not go.');
      },
    );
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

  const intent = drag === null ? null : swipeIntent(drag.dx, drag.dy, drag.width, map);
  const aiming = intent?.direction == null ? undefined : map[intent.direction];

  return (
    <footer className="fy-item-bar" data-agenda-bar="" data-safe-bottom="">
      <div
        className="fy-item-bar__answers"
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
        {drag !== null && drag.dy > Math.abs(drag.dx) ? (
          <p
            aria-hidden="true"
            className="fy-item-bar__stamp"
            data-committed={isDownSwipe(drag.dx, drag.dy, drag.width) || undefined}
            data-swipe="down"
          >
            ↓ Back to the chat
          </p>
        ) : null}
        {intent === null || intent.direction === null || aiming === undefined ? null : (
          <p
            aria-hidden="true"
            className="fy-item-bar__stamp"
            data-committed={intent.committed || undefined}
            data-swipe={intent.direction}
          >
            {`${STAMP[intent.direction]} ${aiming.label}`}
          </p>
        )}
        {error === null ? null : (
          <p className="fy-item-bar__error m-0" role="alert">
            Not sent: {error}
          </p>
        )}
        <AgendaActions
          answers={model.answers}
          arrows={swipeable}
          busy={busy}
          dismissInMenu={model.dismissInMenu && !model.notice}
          extraOptions={model.extras}
          onAnswer={(answer: AgendaCardAnswer) => {
            const action = answerAction(answer, '');
            if (action !== null) give(action);
          }}
          onDismiss={() => give(DISMISS_ACTION)}
          onOption={(option: AgendaAskOption) => give(optionAction(option, ''))}
          recommendationLine={model.recommendationLine}
          recommended={model.recommended}
          secondaryExtra={
            <button
              className="kt-btn fy-item-bar__reply"
              data-agenda-add-reply=""
              onClick={() => onReply(text.trim())}
              type="button"
            >
              <MessageSquarePlus aria-hidden="true" size={14} />
              Add to reply
            </button>
          }
          swipeHints={swipeable}
          {...(model.composerHint === undefined ? {} : { composerHint: model.composerHint })}
          {...(model.notice ? { clear: () => give(CLEAR_ACTION) } : {})}
          {...(item.waitingOn === 'ferret' && !model.notice
            ? { waiting: `With ${ferret} — it will update this.` }
            : {})}
          {...(sendAnswers === undefined
            ? {}
            : { sendAnswers: { ready: sendAnswers.ready, onSend: () => sendAnswers.onSend(text) } })}
        />
      </div>
      <form
        className="fy-item-bar__field"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          aria-label={`Reply to ${ferret} about this`}
          className="fy-item-bar__input"
          data-agenda-field=""
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
          placeholder={`Reply to ${ferret} about this…`}
          rows={1}
          value={text}
        />
        <button
          aria-label="Send reply"
          className="fy-item-bar__send"
          data-agenda-send=""
          disabled={text.trim() === '' || sending}
          type="submit"
        >
          <Send aria-hidden="true" size={16} />
        </button>
      </form>
      {failed === null ? null : (
        <p className="fy-item-bar__error m-0" role="alert">
          Not sent: {failed}
        </p>
      )}
    </footer>
  );
}
