/**
 * THE ANSWER BAR OF ONE ATTENTION CARD, pinned under its detail: the card's answers as buttons in the
 * order a swipe points — LEFT · UP · RIGHT — each with its arrow, the right one (the recommended one)
 * primary; an old choice's options past the third as plain buttons with no arrow; a collapsed
 * "Reply…" that opens a text box (open from the start on a `reply` card, which has nothing else to
 * answer with); and a ⋯ menu that holds Dismiss, the one answer nobody means to press by accident.
 *
 * The reply is OPTIONAL on every card: whatever answer is given afterwards carries it as its note. An
 * item answered one answer per question swaps all of that for a single "Send answers" button. Nothing
 * here sends anything: every answer leaves through the callbacks.
 */

import type { AttentionAskOption, AttentionCardAnswer } from '@ferretry/protocol';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  CornerDownLeft,
  Ellipsis,
  LoaderCircle,
  MessageSquarePlus,
  Send,
  X,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import type { AnswerDirection } from '../../lib/attention-answers.ts';

const ARROWS: Readonly<Record<AnswerDirection, ReactNode>> = {
  left: <ArrowLeft size={14} aria-hidden="true" />,
  up: <ArrowUp size={14} aria-hidden="true" />,
  right: <ArrowRight size={14} aria-hidden="true" />,
};

const SWIPE_WORD: Readonly<Record<AnswerDirection, string>> = {
  left: 'swipe left',
  up: 'swipe up',
  right: 'swipe right',
};

/** A ⋯ button and the menu it opens: arrows move, Esc closes and returns focus, outside taps close. */
function ActionMenu({ busy, onDismiss }: { readonly busy: boolean; readonly onDismiss: () => void }) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keydown handler only routes Esc to the menu inside it
    <div className="fy-attn-menu" onKeyDown={onKeyDown} ref={root}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="More actions"
        className="kt-btn kt-btn--sm fy-attn-menu__button"
        data-attention-more=""
        disabled={busy}
        onClick={() => setOpen(current => !current)}
        ref={trigger}
        title="More actions"
        type="button"
      >
        <Ellipsis aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div aria-label="More actions" className="fy-attn-menu__list" id={menuId} role="menu">
          <button
            className="fy-attn-menu__item"
            data-attention-dismiss=""
            onClick={() => {
              setOpen(false);
              onDismiss();
            }}
            role="menuitem"
            tabIndex={-1}
            type="button"
          >
            <X aria-hidden="true" size={14} />
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AnswerButton({
  answer,
  busy,
  swipeHints,
  arrows,
  onAnswer,
}: {
  readonly answer: AttentionCardAnswer;
  readonly busy: boolean;
  readonly swipeHints: boolean;
  readonly arrows: boolean;
  readonly onAnswer: (answer: AttentionCardAnswer) => void;
}) {
  const hintId = useId();
  const arrow = arrows ? ARROWS[answer.direction] : null;
  return (
    <button
      aria-describedby={answer.description === undefined ? undefined : hintId}
      className="kt-btn fy-attn-answer"
      data-attention-answer={answer.direction}
      data-attention-option={answer.label}
      data-variant={answer.direction === 'right' ? 'primary' : undefined}
      disabled={busy}
      onClick={() => onAnswer(answer)}
      title={answer.description}
      type="button"
    >
      {answer.direction === 'right' ? null : arrow}
      <span className="fy-attn-answer__label">{answer.label}</span>
      {answer.direction === 'right' ? arrow : null}
      {swipeHints ? <span className="sr-only">, or {SWIPE_WORD[answer.direction]}</span> : null}
      {answer.description === undefined ? null : (
        <span className="sr-only" id={hintId}>
          {answer.description}
        </span>
      )}
    </button>
  );
}

export interface AttentionActionsProps {
  /** The card's answers, left · up · right. */
  readonly answers: readonly AttentionCardAnswer[];
  /** An old choice's options past the third: buttons with no direction. */
  readonly extraOptions: readonly AttentionAskOption[];
  /** The card can be swiped: each answer also says which way, aloud. */
  readonly swipeHints: boolean;
  /** Draws each answer's direction arrow. Defaults to `swipeHints`; a card that cannot be swiped may still show them. */
  readonly arrows?: boolean;
  readonly busy: boolean;
  /** A to-do that is waiting on its ferret says so, above the bar. */
  readonly waitingOn?: string;
  readonly reply: string;
  readonly onReplyChange: (text: string) => void;
  readonly replyOpen: boolean;
  readonly onReplyOpenChange: (open: boolean) => void;
  readonly replyRef: RefObject<HTMLTextAreaElement | null>;
  /** The card is a text-only ask: the box is the answer, and a Send button sends it. */
  readonly replyIsAnswer: boolean;
  readonly canSendReply: boolean;
  readonly onSendReply: () => void;
  readonly onAnswer: (answer: AttentionCardAnswer) => void;
  readonly onOption: (option: AttentionAskOption) => void;
  /** Whether Dismiss is in the ⋯ menu — it is not when an answer already is one (a Skip). */
  readonly dismissInMenu: boolean;
  readonly onDismiss: () => void;
  /** Several questions: one "Send answers" button replaces the answers and the reply box. */
  readonly sendAnswers?: { readonly ready: boolean; readonly onSend: () => void };
}

export function AttentionActions({
  answers,
  extraOptions,
  swipeHints,
  arrows = swipeHints,
  busy,
  waitingOn,
  reply,
  onReplyChange,
  replyOpen,
  onReplyOpenChange,
  replyRef,
  replyIsAnswer,
  canSendReply,
  onSendReply,
  onAnswer,
  onOption,
  dismissInMenu,
  onDismiss,
  sendAnswers,
}: AttentionActionsProps) {
  const replyId = useId();
  const boxId = useId();
  const menu = dismissInMenu ? <ActionMenu busy={busy} onDismiss={onDismiss} /> : null;
  if (sendAnswers !== undefined) {
    return (
      <div className="fy-attn-actions" data-attention-actions="">
        <div className="fy-attn-actions__row">
          <button
            className="kt-btn fy-attn-actions__send-answers"
            data-attention-send-answers=""
            data-variant="primary"
            disabled={busy || !sendAnswers.ready}
            onClick={sendAnswers.onSend}
            type="button"
          >
            {busy ? (
              <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <Send size={14} aria-hidden="true" />
            )}
            Send answers
          </button>
          {menu}
        </div>
      </div>
    );
  }
  const hasAnswerButtons = answers.length > 0 || extraOptions.length > 0;
  return (
    <div className="fy-attn-actions" data-attention-actions="">
      {waitingOn === undefined ? null : (
        <p className="fy-attn-actions__waiting m-0 text-meta text-muted" data-attention-waiting="" role="status">
          <LoaderCircle aria-hidden="true" size={13} />
          Waiting on {waitingOn}
        </p>
      )}
      {hasAnswerButtons ? (
        <fieldset aria-label="Answers" className="fy-attn-answers" data-count={answers.length}>
          {answers.map(answer => (
            <AnswerButton
              answer={answer}
              busy={busy}
              key={answer.direction}
              onAnswer={onAnswer}
              swipeHints={swipeHints}
              arrows={arrows}
            />
          ))}
        </fieldset>
      ) : null}
      {extraOptions.length === 0 ? null : (
        <fieldset aria-label="More choices" className="fy-attn-extras">
          {extraOptions.map(option => (
            <button
              aria-describedby={option.description === undefined ? undefined : `${replyId}-${option.label}`}
              className="kt-btn fy-attn-extra"
              data-attention-option={option.label}
              disabled={busy}
              key={option.label}
              onClick={() => onOption(option)}
              title={option.description}
              type="button"
            >
              {option.label}
              {option.description === undefined ? null : (
                <span className="sr-only" id={`${replyId}-${option.label}`}>
                  {option.description}
                </span>
              )}
            </button>
          ))}
        </fieldset>
      )}
      {!replyIsAnswer ? (
        <div className="fy-attn-actions__row">
          <button
            aria-controls={replyOpen ? boxId : undefined}
            aria-expanded={replyOpen}
            className="kt-btn fy-attn-reply-toggle"
            data-attention-reply-toggle=""
            disabled={busy}
            onClick={() => onReplyOpenChange(!replyOpen)}
            type="button"
          >
            <MessageSquarePlus aria-hidden="true" size={14} />
            {reply.trim() === '' ? 'Reply…' : 'Reply added'}
            <ChevronDown
              aria-hidden="true"
              className="fy-attn-reply-toggle__chevron"
              data-open={replyOpen || undefined}
              size={14}
            />
          </button>
          {menu}
        </div>
      ) : null}
      {replyOpen || replyIsAnswer ? (
        <form
          className="fy-attn-actions__row"
          onSubmit={event => {
            event.preventDefault();
            if (replyIsAnswer) onSendReply();
          }}
        >
          <label className="sr-only" htmlFor={boxId}>
            {replyIsAnswer ? 'Your answer' : 'Reply (optional, sent with your answer)'}
          </label>
          <div className="fy-attn-reply">
            <textarea
              className="kt-input fy-attn-reply__box"
              data-attention-reply=""
              disabled={busy}
              id={boxId}
              onChange={event => onReplyChange(event.target.value)}
              onKeyDown={event => {
                if (replyIsAnswer && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  onSendReply();
                }
              }}
              placeholder={replyIsAnswer ? 'Write your answer…' : 'Add a note — sent with your answer'}
              ref={replyRef}
              rows={3}
              value={reply}
            />
            {replyIsAnswer ? (
              <button
                aria-label="Send answer"
                className="fy-attn-reply__send"
                data-attention-send=""
                disabled={busy || !canSendReply}
                type="submit"
              >
                {busy ? (
                  <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                ) : (
                  <CornerDownLeft size={14} aria-hidden="true" />
                )}
              </button>
            ) : null}
          </div>
          {replyIsAnswer ? menu : null}
        </form>
      ) : null}
    </div>
  );
}
