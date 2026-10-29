/**
 * AN ASK, AS A MESSAGE IN THE FERRET'S CONVERSATION. Every ask starts in discussion: it is drawn in the chat
 * where it was raised, marked as an ask, with its question and its options as chips. Picking a chip answers it
 * (the composer's text rides along as the note); "Reply" makes it the composer's reply target. Nothing about it
 * overlays the conversation.
 *
 * CONTRACT STUB — Unit B fills it in; the signature is what the chat builds against.
 */

import type { AttentionItem } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import type { InboxAction } from '../../lib/attention-answers.ts';

export interface AttentionAskMessageProps {
  readonly item: AttentionItem;
  /** An answer for it is on its way. */
  readonly busy?: boolean;
  /** This ask is what the composer is replying to. */
  readonly replying: boolean;
  /** Picks an option (or dismisses): the host attaches the composer's text (`withComposerNote`) and sends it. */
  readonly onAct: (action: InboxAction) => void;
  /** Makes this ask the composer's reply target. */
  readonly onReplyTo: () => void;
  /** Opens what the item knows beyond its question (`AttentionDetail`). Absent when there is nothing more. */
  readonly onOpenDetail?: () => void;
  readonly renderProse?: (text: string) => ReactNode;
  readonly now?: number;
}

export function AttentionAskMessage({ item }: AttentionAskMessageProps) {
  return <article data-attention-ask={item.id}>{item.subject}</article>;
}
