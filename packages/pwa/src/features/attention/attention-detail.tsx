/**
 * WHAT AN ATTENTION ITEM KNOWS BEYOND ITS QUESTION — premise, context, what is already decided, terms (a table),
 * steps, and the body with its diagrams and mock-ups. The card itself is minimal (question, options, Skip); this
 * is where the rest is read: beside the card on a wide screen (`layout: 'panel'`), or as ONE full scrollable view
 * on a phone (`layout: 'full'`, no scroll nested inside it).
 *
 * CONTRACT STUB — Unit B fills it in; the signature is what the hosts build against.
 */

import type { AttentionItem } from '@ferretry/protocol';
import type { ReactNode } from 'react';

export interface AttentionDetailProps {
  readonly item: AttentionItem;
  /** Beside the card (wide screens), or the phone's one full scrollable view. */
  readonly layout: 'panel' | 'full';
  /** How prose is drawn — the conversation renders references; elsewhere, Markdown. */
  readonly renderProse?: (text: string) => ReactNode;
  /** Ticks or unticks one step on the machine. Absent: the steps are read-only. */
  readonly onProgress?: (step: number, done: boolean) => Promise<void>;
  readonly busy?: boolean;
}

/** Whether the item has anything to read beyond its question and options. */
export const attentionHasDetail = (item: AttentionItem): boolean =>
  [item.premise, item.context, item.decided, item.body].some(text => (text ?? '').trim() !== '') ||
  (item.terms?.length ?? 0) > 0 ||
  (item.steps?.length ?? 0) > 0;

export function AttentionDetail({ item }: AttentionDetailProps) {
  return <section data-attention-detail={item.id} />;
}
