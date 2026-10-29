/**
 * ONE ITEM'S FULL CARD, covering only the chat area (the header, the agenda line and the composer stay visible):
 * every section in ONE scroll (no scroll bar inside another), and an answer bar with the options laid out as the
 * swipes point (← ↑ →, the recommended one on the right; arrows only where it can be swiped), ↓ / "Add to reply"
 * (the item's "re:" chip into the composer), ‹ › to the previous / next item and ✕ to close. A swipe starts only
 * from the card's top strip; the body scrolls.
 *
 * CONTRACT STUB — Unit B fills it in; the signature is what the chat and the Inbox build against.
 */

import type { AttentionItem } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import type { InboxAction } from '../../lib/attention-answers.ts';

export interface AttentionFullCardProps {
  readonly item: AttentionItem;
  /** The ferret's name, for the header and "with Johnnie". */
  readonly ferret: string;
  /** Where it sits among the items it pages through: "2 of 5". */
  readonly position: { readonly index: number; readonly total: number };
  readonly now?: number;
  readonly busy?: boolean;
  /** Why the last answer did not land. */
  readonly error?: string | null;
  /** It can be swiped (a touch screen): arrows on the answers, swipes from the top strip. */
  readonly swipeable: boolean;
  /** An option (or Not needed…): the host attaches the composer's text (`withComposerNote`) and sends it. */
  readonly onAct: (action: InboxAction) => void;
  /** ↓ / "Add to reply": this item's "re:" chip into the composer. */
  readonly onAddReply: () => void;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onClose: () => void;
  /** Ticks or unticks one step on the machine. Absent: the steps are read-only. */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  readonly renderProse?: (text: string) => ReactNode;
}

export function AttentionFullCard({ item, onClose }: AttentionFullCardProps) {
  return (
    <article data-attention-full-card={item.id}>
      {item.title ?? item.subject}
      <button onClick={onClose} type="button">
        Close
      </button>
    </article>
  );
}
