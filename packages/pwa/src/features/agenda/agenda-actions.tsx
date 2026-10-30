/**
 * THE ANSWER BAR OF ONE ITEM CARD, pinned under its question. Answering is replying, so there is no
 * text box here: the owner types in the ferret's normal message box, and a picked option carries that text.
 *
 *  1. The card's own answers as buttons (three at most; an old choice's options past the third plain, with
 *     no arrow), the recommended one tagged "Recommended" and the reason said once, in one line, under them.
 *     An arrow on each only where the card can be swiped.
 *  2. A text-only ask has no options: a line says to reply in the message box below.
 *  3. A quiet second row: Skip — move on, unanswered (only where the host can) · "Details ›" (only where the
 *     item has more to read) · a ⋯ menu holding "Not needed…", which dismisses.
 *
 * An item answered one answer per question swaps the answers for a single "Send answers" button. Nothing
 * here sends anything: every answer leaves through the callbacks.
 */

import type { AgendaAskOption, AgendaCardAnswer } from '@ferretry/protocol';
import { ArrowLeft, ArrowRight, ArrowUp, Check, ChevronRight, Ellipsis, LoaderCircle, Send, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { AnswerDirection } from '../../lib/agenda-answers.ts';

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

const sameLabel = (a: string, b: string | undefined): boolean =>
  b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The small tag on the recommended option. Words, not colour alone, so a screen reader says it too. */
function RecommendedTag() {
  return (
    <span className="fy-attn-tag" data-agenda-recommended="">
      <span className="sr-only">, </span>
      <Check aria-hidden="true" size={11} />
      Recommended
    </span>
  );
}

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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
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
        data-agenda-more=""
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
            data-agenda-dismiss=""
            onClick={() => {
              setOpen(false);
              onDismiss();
            }}
            role="menuitem"
            tabIndex={-1}
            type="button"
          >
            <X aria-hidden="true" size={14} />
            Not needed…
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Skip: move on without answering; absent where the host cannot skip. */
function SkipButton({ busy, onSkip }: { readonly busy: boolean; readonly onSkip: () => void }) {
  return (
    <button
      className="kt-btn fy-attn-skip"
      data-agenda-skip=""
      disabled={busy}
      onClick={onSkip}
      title="Leave it for now and move on to the next card"
      type="button"
    >
      Skip
      <ChevronRight aria-hidden="true" size={14} />
    </button>
  );
}

/** "Details ›": what the item knows beyond its question — the side panel, or the phone's full view. */
function DetailsButton({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <button
      className="kt-btn fy-attn-details"
      data-agenda-details=""
      onClick={onOpen}
      title="Read what is going on, why it matters and what is decided"
      type="button"
    >
      Details
      <ChevronRight aria-hidden="true" size={14} />
    </button>
  );
}

function AnswerButton({
  answer,
  busy,
  swipeHints,
  arrows,
  recommended,
  onAnswer,
}: {
  readonly answer: AgendaCardAnswer;
  readonly busy: boolean;
  readonly swipeHints: boolean;
  readonly arrows: boolean;
  readonly recommended: boolean;
  readonly onAnswer: (answer: AgendaCardAnswer) => void;
}) {
  const hintId = useId();
  const arrow = arrows ? ARROWS[answer.direction] : null;
  return (
    <button
      aria-describedby={answer.description === undefined ? undefined : hintId}
      className="kt-btn fy-attn-answer"
      data-agenda-answer={answer.direction}
      data-agenda-option={answer.label}
      data-recommended={recommended || undefined}
      data-variant={answer.direction === 'right' ? 'primary' : undefined}
      disabled={busy}
      onClick={() => onAnswer(answer)}
      title={answer.description}
      type="button"
    >
      {answer.direction === 'right' ? null : arrow}
      <span className="fy-attn-answer__label">{answer.label}</span>
      {recommended ? <RecommendedTag /> : null}
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

export interface AgendaActionsProps {
  /** The card's answers, left · up · right. */
  readonly answers: readonly AgendaCardAnswer[];
  /** An old choice's options past the third: buttons with no direction. */
  readonly extraOptions: readonly AgendaAskOption[];
  /** The card can be swiped: each answer also says which way, aloud. */
  readonly swipeHints: boolean;
  /** Draws each answer's direction arrow. Defaults to `swipeHints`. */
  readonly arrows?: boolean;
  readonly busy: boolean;
  /** The option the ferret recommends, tagged on its button. */
  readonly recommended?: string | undefined;
  /** The one line under the buttons: why the recommendation. */
  readonly recommendationLine?: string | undefined;
  /** An item waiting on its ferret says so, above the bar: "Waiting on Piper". */
  readonly waiting?: string;
  /** Skips the card unanswered; present only where the host can skip. */
  readonly onSkip?: () => void;
  /** Opens the detail; present only where the item has something to read beyond its question. */
  readonly onOpenDetail?: () => void;
  /** Says the answer is the message box's text: a text-only ask, or a review that wants changes written. */
  readonly composerHint?: string;
  readonly onAnswer: (answer: AgendaCardAnswer) => void;
  readonly onOption: (option: AgendaAskOption) => void;
  /** Whether "Not needed…" is in the ⋯ menu — it is not when an answer already dismisses (a Skip). */
  readonly dismissInMenu: boolean;
  /** Dismisses as not needed; the host attaches the message box's text as the reason. */
  readonly onDismiss: () => void;
  /** A plain notification: the one action is "Clear". */
  readonly clear?: () => void;
  /** Quiet extras in the second row (the full card's "Add to reply"), between `secondaryLead` and the ⋯ menu. */
  readonly secondaryExtra?: ReactNode;
  /** The start of the second row (the full card's `‹ 1 of 7 ›`). */
  readonly secondaryLead?: ReactNode;
  /** The end of the second row, after the ⋯ menu (the full card's ✕). */
  readonly secondaryTail?: ReactNode;
  /** Several questions: one "Send answers" button replaces the answers. */
  readonly sendAnswers?: { readonly ready: boolean; readonly onSend: () => void };
}

export function AgendaActions({
  answers,
  extraOptions,
  swipeHints,
  arrows = swipeHints,
  busy,
  recommended,
  recommendationLine,
  waiting,
  onSkip,
  onOpenDetail,
  composerHint,
  onAnswer,
  onOption,
  dismissInMenu,
  onDismiss,
  clear,
  secondaryExtra,
  secondaryLead,
  secondaryTail,
  sendAnswers,
}: AgendaActionsProps) {
  const hintId = useId();
  const menu = dismissInMenu ? <ActionMenu busy={busy} onDismiss={onDismiss} /> : null;
  const skip = onSkip === undefined ? null : <SkipButton busy={busy} onSkip={onSkip} />;
  const details = onOpenDetail === undefined ? null : <DetailsButton onOpen={onOpenDetail} />;
  const hosted = secondaryLead !== undefined || secondaryExtra !== undefined || secondaryTail !== undefined;
  const secondary =
    skip === null && details === null && menu === null && !hosted ? null : (
      <div className="fy-attn-actions__row fy-attn-actions__row--secondary" data-hosted={hosted || undefined}>
        {secondaryLead}
        {skip}
        {details}
        {secondaryExtra}
        {menu}
        {secondaryTail}
      </div>
    );
  const waitingLine =
    waiting === undefined ? null : (
      <p className="fy-attn-actions__waiting m-0 text-meta text-muted" data-agenda-waiting="" role="status">
        <LoaderCircle aria-hidden="true" size={13} />
        {waiting}
      </p>
    );

  if (sendAnswers !== undefined) {
    return (
      <div className="fy-attn-actions" data-agenda-actions="">
        <div className="fy-attn-actions__row">
          <button
            className="kt-btn fy-attn-actions__send-answers"
            data-agenda-send-answers=""
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
          {hosted ? null : skip}
          {hosted ? null : details}
          {hosted ? null : menu}
        </div>
        {hosted ? secondary : null}
      </div>
    );
  }

  const hasAnswerButtons = answers.length > 0 || extraOptions.length > 0;
  return (
    <div className="fy-attn-actions" data-agenda-actions="">
      {waitingLine}
      {clear === undefined ? null : (
        <div className="fy-attn-actions__row">
          <button
            className="kt-btn fy-attn-actions__send-answers"
            data-agenda-clear=""
            data-variant="primary"
            disabled={busy}
            onClick={clear}
            type="button"
          >
            <Check aria-hidden="true" size={14} />
            Clear
          </button>
        </div>
      )}
      {hasAnswerButtons ? (
        <fieldset aria-label="Answers" className="fy-attn-answers" data-count={answers.length}>
          {answers.map(answer => (
            <AnswerButton
              answer={answer}
              arrows={arrows}
              busy={busy}
              key={answer.direction}
              onAnswer={onAnswer}
              recommended={sameLabel(answer.label, recommended)}
              swipeHints={swipeHints}
            />
          ))}
        </fieldset>
      ) : null}
      {extraOptions.length === 0 ? null : (
        <fieldset aria-label="More choices" className="fy-attn-extras">
          {extraOptions.map(option => (
            <button
              aria-describedby={option.description === undefined ? undefined : `${hintId}-${option.label}`}
              className="kt-btn fy-attn-extra"
              data-agenda-option={option.label}
              data-recommended={sameLabel(option.label, recommended) || undefined}
              disabled={busy}
              key={option.label}
              onClick={() => onOption(option)}
              title={option.description}
              type="button"
            >
              {option.label}
              {sameLabel(option.label, recommended) ? <RecommendedTag /> : null}
              {option.description === undefined ? null : (
                <span className="sr-only" id={`${hintId}-${option.label}`}>
                  {option.description}
                </span>
              )}
            </button>
          ))}
        </fieldset>
      )}
      {recommendationLine === undefined ? null : (
        <p className="fy-attn-actions__reason m-0" data-agenda-recommendation="">
          {recommendationLine}
        </p>
      )}
      {composerHint === undefined ? null : (
        <p className="fy-attn-actions__reason m-0" data-agenda-composer-hint="">
          {composerHint}
        </p>
      )}
      {secondary}
    </div>
  );
}
