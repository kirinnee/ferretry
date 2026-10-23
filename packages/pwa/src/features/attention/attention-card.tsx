/**
 * ONE ATTENTION ITEM, AS A CARD: the ferret and machine it came from (linked to the conversation), the
 * ask, the context, the options as buttons, a reply box, and Done / Dismiss.
 *
 * It is the one card both places draw — the Attention inbox's deck, where it also swipes, and the
 * panel at the top of the ferret's own conversation — so an option reads, and answers, the same in
 * both. It holds no transport: every answer leaves through `onAct` as an {@link InboxAction}, and the
 * host decides whether it waits out an undo window (the inbox) or goes at once (the panel).
 *
 * THE OPTION ORDER IS THE SWIPE ORDER (`inboxOptions`), and the first three carry the arrow the swipe
 * uses, so a reader who learns the buttons has learned the gestures.
 */

import type { AttentionItem } from '@ferretry/protocol';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CornerDownLeft,
  LoaderCircle,
  MessageSquareText,
  X,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import {
  DISMISS_ACTION,
  DONE_ACTION,
  directionOfAction,
  type InboxAction,
  inboxOptions,
  replyAction,
  type SwipeDirection,
  swipeMap,
} from '../../lib/attention-inbox.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { attentionAge, attentionKindMeta, attentionReference, collapsesByDefault } from './attention-board.tsx';

/** Where the card came from, in the inbox. Inside its own conversation there is nothing to say. */
export interface AttentionCardOrigin {
  /** The ferret's name, as the sidebar shows it. */
  readonly ferret: string;
  /** What it is working on, when that is not just its name. */
  readonly task?: string;
  readonly machine: string;
  /** The conversation, opened at this item. */
  readonly href: string;
  readonly onNavigate: (to: string) => void;
}

export interface AttentionCardProps {
  readonly item: AttentionItem;
  readonly origin?: AttentionCardOrigin;
  /** An answer for this card is on its way. */
  readonly busy?: boolean;
  /** Why the last answer did not land, said on the card it belongs to. */
  readonly error?: string | null;
  /** Draws the swipe arrow beside the first three options. */
  readonly swipeHints?: boolean;
  /** Ringed and labelled: the item a link or a reference pointed at. */
  readonly highlighted?: boolean;
  readonly now?: number;
  /** How the ask's context is drawn — the conversation renders references; the inbox, prose. */
  readonly renderProse?: (text: string) => ReactNode;
  readonly onAct: (action: InboxAction) => void;
  /** Extra DOM id for scroll targets. */
  readonly id?: string;
}

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

const plainProse = (text: string): ReactNode => <p className="m-0 whitespace-pre-wrap break-words">{text}</p>;

export function AttentionCard({
  item,
  origin,
  busy = false,
  error = null,
  swipeHints = false,
  highlighted = false,
  now = Date.now(),
  renderProse = plainProse,
  onAct,
  id,
}: AttentionCardProps) {
  const replyId = useId();
  const [reply, setReply] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const kind = attentionKindMeta(item);
  const KindIcon = kind.icon;
  const options = inboxOptions(item);
  const map = swipeMap(item);
  const context = item.context?.trim() ? item.context : null;
  const longContext = context !== null && collapsesByDefault(context);
  const replyable = replyAction(item, reply);
  const answer = item.ask?.kind === 'open-question';
  const sendReply = (): void => {
    if (replyable === null || busy) return;
    onAct(replyable);
    setReply('');
  };
  const hint = (action: InboxAction): ReactNode => {
    if (!swipeHints) return null;
    const direction = directionOfAction(map, action);
    return direction === null ? null : (
      <span className="fy-attn-card__swipe" title={SWIPE_WORD[direction]}>
        {ARROWS[direction]}
        <span className="sr-only">, or {SWIPE_WORD[direction]}</span>
      </span>
    );
  };
  return (
    <article
      aria-labelledby={`${replyId}-ask`}
      className="kt-attn fy-attn-card"
      data-attention-card={item.id}
      data-highlighted={highlighted || undefined}
      data-kind={kind.tone}
      id={id}
    >
      <header className="fy-attn-card__meta">
        <span className="kt-attn-chip kt-label inline-flex shrink-0 items-center gap-1 px-badge-x py-0.5">
          <KindIcon size={11} aria-hidden="true" />
          {kind.label}
        </span>
        <span className="mono text-meta text-faint">{attentionReference(item.id)}</span>
        {highlighted ? <span className="fy-attn-card__pointer">linked</span> : null}
        <span className="ml-auto text-meta text-faint">{attentionAge(item.waitingSince, now)}</span>
      </header>
      {origin === undefined ? null : (
        <RouteLink
          className="fy-attn-card__origin"
          data-attention-origin=""
          onNavigate={origin.onNavigate}
          title={`Open ${origin.ferret}'s conversation${origin.task === undefined ? '' : ` (${origin.task})`} on ${origin.machine}`}
          to={origin.href}
        >
          <span aria-hidden="true" className="fy-attn-card__initial">
            {origin.ferret.charAt(0).toUpperCase()}
          </span>
          <span className="shrink-0 font-semibold text-fg">{origin.ferret}</span>
          {origin.task === undefined ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{origin.task}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{origin.machine}</span>
        </RouteLink>
      )}
      <h3 className="fy-attn-card__ask" id={`${replyId}-ask`}>
        {item.subject}
      </h3>
      <div className="fy-attn-card__why">{renderProse(item.why)}</div>
      {context === null ? null : (
        <div className="fy-attn-card__context" data-open={!longContext || contextOpen || undefined}>
          {renderProse(context)}
          {longContext ? (
            <button
              aria-expanded={contextOpen}
              className="fy-attn-card__more"
              onClick={() => setContextOpen(open => !open)}
              type="button"
            >
              {contextOpen ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>
      )}
      {error === null ? null : (
        <p className="m-0 text-meta text-err" role="alert">
          Not sent: {error}
        </p>
      )}
      {options.length === 0 ? null : (
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
              {hint(option)}
            </button>
          ))}
        </fieldset>
      )}
      <form
        className="fy-attn-card__reply"
        onSubmit={event => {
          event.preventDefault();
          sendReply();
        }}
      >
        <label className="sr-only" htmlFor={`${replyId}-reply`}>
          {answer ? 'Your answer' : `Reply to ${attentionReference(item.id)}`}
        </label>
        <MessageSquareText aria-hidden="true" className="fy-attn-card__reply-icon" size={14} />
        <textarea
          className="kt-input fy-attn-card__reply-box"
          disabled={busy}
          id={`${replyId}-reply`}
          onChange={event => setReply(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              sendReply();
            }
          }}
          placeholder={answer ? 'Write your answer…' : 'Reply…'}
          rows={1}
          value={reply}
        />
        <button
          aria-label={answer ? 'Send answer' : 'Send reply'}
          className="kt-btn kt-btn--sm fy-attn-card__send"
          data-variant="primary"
          disabled={busy || replyable === null}
          type="submit"
        >
          {busy ? (
            <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <CornerDownLeft size={14} aria-hidden="true" />
          )}
          <span>Send</span>
        </button>
      </form>
      <footer className="fy-attn-card__foot">
        <button
          className="kt-btn kt-btn--sm"
          data-attention-done=""
          disabled={busy}
          onClick={() => onAct(DONE_ACTION)}
          type="button"
        >
          <Check size={14} aria-hidden="true" />
          Done
          {hint(DONE_ACTION)}
        </button>
        <button
          className="kt-btn kt-btn--sm"
          data-attention-dismiss=""
          data-variant="ghost"
          disabled={busy}
          onClick={() => onAct(DISMISS_ACTION)}
          type="button"
        >
          <X size={14} aria-hidden="true" />
          Dismiss
          {hint(DISMISS_ACTION)}
        </button>
        {origin === undefined ? null : (
          <RouteLink
            className="fy-attn-card__open"
            data-attention-open=""
            onNavigate={origin.onNavigate}
            to={origin.href}
          >
            Open conversation
            <ArrowRight size={13} aria-hidden="true" />
          </RouteLink>
        )}
      </footer>
    </article>
  );
}
