/**
 * THE REPLY TYPED ON THE TOP CARD OF A DECK, shared between the deck and the card.
 *
 * The reply is optional and travels with whichever answer is given — and a swipe or an arrow key is
 * decided by the deck, not by the card's own buttons. So the deck owns the text and hands it down, and
 * a swipe on a card that needs text it has not got (a review's "Needs changes") bumps `focusTick`, which
 * the card answers by opening and focusing its box. A card drawn outside a deck has no provider and
 * keeps its own text.
 */

import { createContext, useContext } from 'react';

export interface ReplyDraft {
  readonly text: string;
  readonly setText: (text: string) => void;
  /** Counts up each time the deck wants the reply box opened and focused. */
  readonly focusTick: number;
}

export const ReplyDraftContext = createContext<ReplyDraft | null>(null);

/** The deck's shared reply for this card, or `null` when the card is not in a deck. */
export const useReplyDraft = (): ReplyDraft | null => useContext(ReplyDraftContext);
