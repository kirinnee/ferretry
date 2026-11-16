import { createContext, useContext } from 'react';

/**
 * Whether the deck around a card reads its ↓ swipe itself — the compass (`agenda-compass.ts`) — so the card's own head
 * and answer row, which swipe on their own everywhere else, leave ↓ to it. One reading of a pull down, never two.
 */
export const DeckDownContext = createContext(false);

export const useDeckReadsDown = (): boolean => useContext(DeckDownContext);
