/**
 * ASKS' LINK TO CARDS (docs/agenda.md § Card asks): which open asks carry each card, and which of those are the card's
 * own gate ask, the one the owner has yet to answer. Asks owns the fact; a card only DERIVES from it (its `openAsks`,
 * and that it is never stale while its ask is open), so the card store holds no copy and answering the ask clears it
 * with no write to the card.
 *
 * A card links ONE kind of ask: the card's own gate obligation (source `card`, whose entry names the card). Asks has
 * no other link to a card, so there is nothing else to read: the open `card` asks are read in ONE call, whatever the
 * size of the board, and grouped by the card each names. (The board once read the ledger of every card's owner and
 * assignee, and their homes, for these same asks: O(ferrets) reads of every card list, closed cards included.) A
 * gate ask on a ledger outside the board's ferrets therefore shows too. A notice is context, never an ask, so it is
 * not counted.
 */
import type { AskRef } from '../../../contract/index.ts';
import type { Card, CardId } from '../../../contract/index.ts';
import type { CardAskLinkSource, CardAsks } from './ports.ts';

/** The part of an open card ask the link reads. */
export interface OpenCardAsk {
  /** The ferret whose ledger the ask lives on. */
  readonly ferret: string;
  /** The ask's id on that ledger (`A12`). */
  readonly id: string;
  /** The card whose gate obligation it is. */
  readonly cardId: CardId;
  /** A notice is context, never an ask. */
  readonly notice?: boolean | undefined;
}

/** Every open ask of the `card` source, read through Asks (`AsksApi.open`) in one call. */
export interface CardAskReader {
  open(): Promise<readonly OpenCardAsk[]>;
}

export class CardAskLinks implements CardAskLinkSource {
  constructor(
    private readonly asks: CardAskReader,
    private readonly diagnostics: { warn(message: string): void },
  ) {}

  async asksFor(cards: readonly Card[], signal?: AbortSignal): Promise<ReadonlyMap<CardId, CardAsks>> {
    signal?.throwIfAborted();
    const wanted = new Set<CardId>(cards.map(card => card.id));
    const found = new Map<CardId, { open: AskRef[]; asking: AskRef[] }>();
    const items = await this.read();
    signal?.throwIfAborted();
    for (const item of items) {
      if (item.notice === true || !wanted.has(item.cardId)) continue;
      const ref: AskRef = { ferret: item.ferret, id: item.id };
      const entry = found.get(item.cardId) ?? { open: [], asking: [] };
      entry.open.push(ref);
      entry.asking.push(ref);
      found.set(item.cardId, entry);
    }
    return found;
  }

  /** Asks that cannot be read costs the cards their asks, never the board read. */
  private async read(): Promise<readonly OpenCardAsk[]> {
    try {
      return await this.asks.open();
    } catch (error) {
      this.diagnostics.warn(
        `could not read the asks of the cards: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
