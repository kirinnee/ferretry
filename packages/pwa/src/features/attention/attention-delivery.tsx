/**
 * WHERE THE OWNER'S ANSWER STANDS, drawn where the owner looks for it: on the card, and in the pinned panel.
 *
 * An answer is DONE only when the ferret has it (docs/attention.md § Delivery), so the board says three
 * things this file draws and nothing else:
 *
 * - "Sending…": the daemon holds the answer (`replies.pending`) or has handed it over and not yet seen it
 *   arrive (`delivery.sending`). It is the same words in both cases — the owner cannot act on the
 *   difference — and it goes when the daemon stops listing the item.
 * - "Your answer didn't reach <ferret>": the item is open again (`undelivered`), with the answer it was
 *   given, so Retry sends exactly that again. It is the same action the answer was, through the same client:
 *   the card holds no transport (`onAct`), and the host decides whether an undo window comes first.
 * - "In discussion": the owner asked to talk it through, so the item waits on its ferret and is a slim line
 *   until it is opened, not a card that asks for an answer.
 *
 * The strip reads the panel's facts through {@link AttentionDeliveryContext} rather than new props on the
 * card: the card stays the one component every place draws, and a place that provides no context (the
 * inbox's deck, whose answered cards leave it at once) simply has no "Sending…" to say.
 */

import {
  type AttentionId,
  type AttentionItem,
  type AttentionSnapshot,
  attentionTitle,
  hasOwnTitle,
} from '@ferretry/protocol';
import { LoaderCircle, MessageCircle, TriangleAlert } from 'lucide-react';
import { createContext, useContext } from 'react';
import { type InboxAction, undeliveredAction } from '../../lib/attention-answers.ts';
import { Button } from '../../shell/primitives.tsx';
import { attentionReference } from './attention-board.tsx';

/** What the strip needs beyond the item itself, provided by the host that knows the board. */
export interface AttentionDeliveryState {
  /** Items whose answer is held or on its way to the ferret. */
  readonly sending: ReadonlySet<AttentionId>;
  /** The ferret's spoken name, for hosts whose card has no origin to name it. */
  readonly ferret?: string;
}

const NOTHING_SENDING: AttentionDeliveryState = { sending: new Set() };

export const AttentionDeliveryContext = createContext<AttentionDeliveryState>(NOTHING_SENDING);

/** The ids whose answer is held for the settle window or handed to the ferret and not yet proven. */
export const deliveringIds = (snapshot: AttentionSnapshot | null): ReadonlySet<AttentionId> =>
  new Set([...(snapshot?.replies?.pending ?? []), ...(snapshot?.delivery?.sending ?? [])]);

/** The heading a card shows for an item: its own title, or its whole ask for an item from before titles. */
export const attentionHeading = (item: Pick<AttentionItem, 'subject' | 'title'>): string =>
  hasOwnTitle(item) ? attentionTitle(item) : item.subject.trim();

export interface AttentionDeliveryProps {
  readonly item: AttentionItem;
  /** The ferret's name when the card knows it (the inbox's origin); else the host's, else "the ferret". */
  readonly ferret?: string | undefined;
  /** An answer for this card is already on its way: Retry waits for it. */
  readonly busy?: boolean;
  readonly onAct: (action: InboxAction) => void;
}

/** Under the card's header: "Sending…", or "Your answer didn't reach <ferret> — answer again or Retry". */
export function AttentionDelivery({ item, ferret, busy = false, onAct }: AttentionDeliveryProps) {
  const state = useContext(AttentionDeliveryContext);
  const name = ferret ?? state.ferret ?? 'the ferret';
  if (state.sending.has(item.id))
    return (
      <p className="fy-attn-delivery" data-attention-delivery="sending" role="status">
        <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
        Sending…
      </p>
    );
  const { undelivered } = item;
  if (undelivered === undefined) return null;
  return (
    <div className="fy-attn-delivery" data-attention-delivery="undelivered" data-tone="err" role="alert">
      <TriangleAlert aria-hidden="true" size={14} />
      <span className="fy-attn-delivery__text">
        Your answer didn&apos;t reach {name} — answer again or retry.
        <span className="fy-attn-delivery__reason"> {undelivered.reason}</span>
      </span>
      <Button
        data-attention-retry=""
        disabled={busy}
        onClick={() => onAct(undeliveredAction(undelivered.reply))}
        size="sm"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

/** One answered item still on its way, as a slim line: it goes when the daemon stops listing it. */
export function AttentionSendingLine({ heading }: { readonly heading: string }) {
  return (
    <p className="fy-attn-delivery" data-attention-delivery="sending" data-attention-sending-line="" role="status">
      <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
      <span className="fy-attn-delivery__text">
        Sending… <span className="fy-attn-delivery__title">{heading}</span>
      </span>
    </p>
  );
}

export interface AttentionDiscussionLineProps {
  readonly item: AttentionItem;
  /** The panel's DOM id the line opens a card in, for `aria-controls`. */
  readonly controls: string;
  readonly onExpand: () => void;
}

/** "In discussion · <title> ›": the item is waiting on its ferret; pressing it opens the card as usual. */
export function AttentionDiscussionLine({ item, controls, onExpand }: AttentionDiscussionLineProps) {
  return (
    <button
      aria-controls={controls}
      aria-expanded="false"
      aria-label={`In discussion: ${attentionHeading(item)}. Open ${attentionReference(item.id)}`}
      className="fy-attn-collapsed fy-attn-discussing"
      data-attention-discussing=""
      onClick={onExpand}
      type="button"
    >
      <MessageCircle aria-hidden="true" className="fy-attn-discussing__icon" size={14} />
      <span className="fy-attn-collapsed__lead">In discussion</span>
      <span aria-hidden="true" className="fy-attn-collapsed__sep">
        ·
      </span>
      <span className="fy-attn-collapsed__title">{attentionHeading(item)}</span>
      <span aria-hidden="true" className="fy-attn-collapsed__go">
        ›
      </span>
    </button>
  );
}
