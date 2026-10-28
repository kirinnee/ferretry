/**
 * THE ACTIONS OF ONE ATTENTION ITEM, in as few rows as can hold them: the answers as buttons (the
 * recommended one marked), ONE reply field with its send icon inside it, and a ⋯ menu that holds
 * Done and Dismiss — the two answers nobody means to press by accident.
 *
 * An item answered one answer per question swaps the options and the reply field for a single
 * "Send answers" button. Nothing here sends anything: every answer leaves through `onAct`.
 */

import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CircleHelp,
  CornerDownLeft,
  Ellipsis,
  LoaderCircle,
  Send,
  X,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  DISMISS_ACTION,
  DONE_ACTION,
  directionOfAction,
  type InboxAction,
  NEEDS_INFO_ACTION,
  type SwipeDirection,
  type SwipeMap,
} from '../../lib/attention-inbox.ts';
import { RecommendedBadge } from './attention-brief.tsx';

const ARROWS: Readonly<Record<SwipeDirection, ReactNode>> = {
  right: <ArrowRight size={13} aria-hidden="true" />,
  left: <ArrowLeft size={13} aria-hidden="true" />,
  up: <ArrowUp size={13} aria-hidden="true" />,
};

const SWIPE_WORD: Readonly<Record<SwipeDirection, string>> = {
  right: 'swipe right',
  left: 'swipe left',
  up: 'swipe up',
};

/** The swipe arrow beside an action, or nothing when it is not on a swipe (or hints are off). */
function SwipeHint({
  map,
  action,
  enabled,
}: {
  readonly map: SwipeMap;
  readonly action: InboxAction;
  readonly enabled: boolean;
}) {
  if (!enabled) return null;
  const direction = directionOfAction(map, action);
  return direction === null ? null : (
    <span className="fy-attn-card__swipe" title={SWIPE_WORD[direction]}>
      {ARROWS[direction]}
      <span className="sr-only">, or {SWIPE_WORD[direction]}</span>
    </span>
  );
}

/** A ⋯ button and the menu it opens: arrows move, Esc closes and returns focus, outside taps close. */
function ActionMenu({
  busy,
  map,
  swipeHints,
  hideDone = false,
  onAct,
}: {
  readonly busy: boolean;
  /** A to-do waiting on its ferret cannot be done yet. */
  readonly hideDone?: boolean;
  readonly map: SwipeMap;
  readonly swipeHints: boolean;
  readonly onAct: (action: InboxAction) => void;
}) {
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
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const choose = (action: InboxAction): void => {
    setOpen(false);
    onAct(action);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keydown handler only routes arrows and Esc to the menu items inside it
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
          {hideDone ? null : (
            <button
              className="fy-attn-menu__item"
              data-attention-done=""
              onClick={() => choose(DONE_ACTION)}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              <Check aria-hidden="true" size={14} />
              Done
              <SwipeHint action={DONE_ACTION} enabled={swipeHints} map={map} />
            </button>
          )}
          <button
            className="fy-attn-menu__item"
            data-attention-dismiss=""
            onClick={() => choose(DISMISS_ACTION)}
            role="menuitem"
            tabIndex={-1}
            type="button"
          >
            <X aria-hidden="true" size={14} />
            Dismiss
            <SwipeHint action={DISMISS_ACTION} enabled={swipeHints} map={map} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The to-do's two answers; there is nothing to choose between, so there is no option list and no reply box. */
interface TaskActionState {
  /** The owner asked for more information and the ferret has not edited the item yet. */
  readonly waiting: boolean;
  readonly ferret: string;
  /** Every step is ticked: Done is the one primary action. */
  readonly complete: boolean;
}

function TaskActions({
  task,
  busy,
  map,
  swipeHints,
  onAct,
}: {
  readonly task: TaskActionState;
  readonly busy: boolean;
  readonly map: SwipeMap;
  readonly swipeHints: boolean;
  readonly onAct: (action: InboxAction) => void;
}) {
  const noteId = useId();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const ask = (): void => {
    const text = note.trim();
    onAct(text === '' ? NEEDS_INFO_ACTION : { ...NEEDS_INFO_ACTION, note: text });
    setNote('');
    setAsking(false);
  };
  return (
    <div className="fy-attn-actions" data-attention-task-actions="">
      {task.waiting ? (
        <p className="fy-attn-actions__waiting m-0 text-meta text-muted" data-attention-waiting="" role="status">
          <LoaderCircle aria-hidden="true" size={13} />
          Waiting on {task.ferret}
        </p>
      ) : null}
      <div className="fy-attn-actions__row" data-attention-row="">
        {task.waiting ? null : (
          <button
            className="kt-btn fy-attn-actions__resolve"
            data-attention-done=""
            data-variant={task.complete ? 'primary' : undefined}
            disabled={busy}
            onClick={() => onAct(DONE_ACTION)}
            type="button"
          >
            <Check aria-hidden="true" size={14} />
            Done
            <SwipeHint action={DONE_ACTION} enabled={swipeHints} map={map} />
          </button>
        )}
        {task.waiting ? null : (
          <button
            aria-expanded={asking}
            className="kt-btn fy-attn-actions__resolve"
            data-attention-needs-info=""
            disabled={busy}
            onClick={() => setAsking(open => !open)}
            type="button"
          >
            <CircleHelp aria-hidden="true" size={14} />
            Need more info
            <SwipeHint action={NEEDS_INFO_ACTION} enabled={swipeHints} map={map} />
          </button>
        )}
        <ActionMenu busy={busy} hideDone map={map} onAct={onAct} swipeHints={swipeHints} />
      </div>
      {asking && !task.waiting ? (
        <form
          className="fy-attn-actions__row"
          onSubmit={event => {
            event.preventDefault();
            ask();
          }}
        >
          <label className="sr-only" htmlFor={noteId}>
            What is missing (optional)
          </label>
          <textarea
            className="kt-input fy-attn-reply__box"
            data-attention-needs-info-note=""
            id={noteId}
            onChange={event => setNote(event.target.value)}
            placeholder="What is missing? (optional)"
            rows={2}
            value={note}
          />
          <button className="kt-btn" data-attention-needs-info-send="" disabled={busy} type="submit">
            Ask {task.ferret}
          </button>
        </form>
      ) : null}
    </div>
  );
}

export interface AttentionActionsProps {
  /** A to-do: Done and Need more info instead of options and a reply. */
  readonly task?: TaskActionState;
  readonly options: readonly InboxAction[];
  readonly recommended: string | undefined;
  readonly map: SwipeMap;
  readonly swipeHints: boolean;
  readonly busy: boolean;
  /** The reply field's label and placeholder. */
  readonly answering: boolean;
  readonly replyLabel: string;
  readonly reply: string;
  readonly onReplyChange: (text: string) => void;
  readonly replyable: InboxAction | null;
  readonly onSendReply: () => void;
  /** Several questions: one "Send answers" button replaces the options and the reply field. */
  readonly sendAnswers?: { readonly action: InboxAction | null; readonly onSend: () => void };
  /** Draws the reply field. Off where the conversation's own composer is the reply. */
  readonly showReply?: boolean;
  readonly onAct: (action: InboxAction) => void;
}

export function AttentionActions({
  options,
  recommended,
  map,
  swipeHints,
  busy,
  answering,
  replyLabel,
  reply,
  onReplyChange,
  replyable,
  onSendReply,
  sendAnswers,
  showReply = true,
  task,
  onAct,
}: AttentionActionsProps) {
  const replyId = useId();
  if (task !== undefined)
    return <TaskActions busy={busy} map={map} onAct={onAct} swipeHints={swipeHints} task={task} />;
  const menu = <ActionMenu busy={busy} map={map} onAct={onAct} swipeHints={swipeHints} />;
  if (sendAnswers !== undefined) {
    return (
      <div className="fy-attn-actions">
        <div className="fy-attn-actions__row">
          <button
            className="kt-btn fy-attn-actions__send-answers"
            data-attention-send-answers=""
            data-variant="primary"
            disabled={busy || sendAnswers.action === null}
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
  const optionButtons =
    options.length === 0 ? null : (
      <fieldset className="fy-attn-card__options" aria-label="Answers">
        {options.map(option => (
          <button
            className="kt-attn-option fy-attn-card__option"
            data-attention-option={option.label}
            disabled={busy}
            key={option.label}
            onClick={() => onAct(option)}
            type="button"
          >
            <span className="kt-attn-option__body">
              <span className="kt-attn-option__label">{option.label}</span>
            </span>
            {recommended === option.label ? <RecommendedBadge /> : null}
            <SwipeHint action={option} enabled={swipeHints} map={map} />
          </button>
        ))}
      </fieldset>
    );
  if (!showReply) {
    return (
      <div className="fy-attn-actions">
        <div className="fy-attn-actions__row" data-attention-row="">
          {optionButtons}
          {options.length === 0 ? (
            <>
              <button
                className="kt-btn fy-attn-actions__resolve"
                data-attention-done=""
                disabled={busy}
                onClick={() => onAct(DONE_ACTION)}
                type="button"
              >
                <Check aria-hidden="true" size={14} />
                Done
              </button>
              <button
                className="kt-btn fy-attn-actions__resolve"
                data-attention-dismiss=""
                disabled={busy}
                onClick={() => onAct(DISMISS_ACTION)}
                type="button"
              >
                <X aria-hidden="true" size={14} />
                Dismiss
              </button>
            </>
          ) : (
            menu
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="fy-attn-actions">
      {optionButtons}
      <form
        className="fy-attn-actions__row"
        onSubmit={event => {
          event.preventDefault();
          onSendReply();
        }}
      >
        <label className="sr-only" htmlFor={replyId}>
          {replyLabel}
        </label>
        <div className="fy-attn-reply">
          <textarea
            className="kt-input fy-attn-reply__box"
            disabled={busy}
            id={replyId}
            onChange={event => onReplyChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                onSendReply();
              }
            }}
            placeholder={answering ? 'Write your answer…' : 'Reply…'}
            rows={1}
            value={reply}
          />
          <button
            aria-label={answering ? 'Send answer' : 'Send reply'}
            className="fy-attn-reply__send"
            disabled={busy || replyable === null}
            type="submit"
          >
            {busy ? (
              <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <CornerDownLeft size={14} aria-hidden="true" />
            )}
          </button>
        </div>
        {menu}
      </form>
    </div>
  );
}
