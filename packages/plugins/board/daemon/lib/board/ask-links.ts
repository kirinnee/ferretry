/**
 * ASKS' LINK TO CARDS (docs/agenda.md § Card asks): which open asks carry each card, and which of those are the card's
 * own gate ask, the one the owner has yet to answer. Asks owns the fact; a card only DERIVES from it (its `openAsks`,
 * and that it is never stale while its ask is open), so the card store holds no copy and answering the ask clears it
 * with no write to the card.
 *
 * A card links TWO kinds of ask. Its own gate obligation (source `card`, whose entry names the card) is the one the
 * owner has yet to answer (`asking`): the open `card` asks are read in ONE call, whatever the size of the board, and
 * grouped by the card each names. (The board once read the ledger of every card's owner and assignee, and their
 * homes, for these same asks: O(ferrets) reads of every card list, closed cards included.) A gate ask on a ledger
 * outside the board's ferrets therefore shows too.
 *
 * The other is an ask a ferret RAISED about the card (`fy agenda add --task F9`): "what is waiting on the owner for
 * this task". It is read from the agenda items that name the card (`task`, or `relatedTasks` after a merge) and is
 * only ever `open`, never `asking`: the card's gate behaviour is the gate ask's alone. An answered ask is resolved,
 * so it is not read. A notice is context, never an ask, so it is not counted.
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

/** What the link reads from Asks: the gate asks, and the asks ferrets raised about a card. Each read stands alone. */
export interface CardAskReader {
  /** Every open ask of the `card` source, read through Asks (`AsksApi.open`) in one call. */
  open(): Promise<readonly OpenCardAsk[]>;
  /** Every open ask a ferret raised about a card, one entry per card it names (`AsksApi.snapshots`). */
  mentioned(): Promise<readonly OpenCardAsk[]>;
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
    const gates = await this.read(() => this.asks.open());
    signal?.throwIfAborted();
    const mentions = await this.read(() => this.asks.mentioned());
    signal?.throwIfAborted();
    for (const item of gates) {
      if (item.notice === true || !wanted.has(item.cardId)) continue;
      const ref: AskRef = { ferret: item.ferret, id: item.id };
      const entry = found.get(item.cardId) ?? { open: [], asking: [] };
      entry.open.push(ref);
      entry.asking.push(ref);
      found.set(item.cardId, entry);
    }
    for (const item of mentions) {
      if (item.notice === true || !wanted.has(item.cardId)) continue;
      const entry = found.get(item.cardId) ?? { open: [], asking: [] };
      if (entry.open.some(ref => ref.ferret === item.ferret && ref.id === item.id)) continue;
      entry.open.push({ ferret: item.ferret, id: item.id });
      found.set(item.cardId, entry);
    }
    return found;
  }

  /** Asks that cannot be read costs the cards their asks, never the board read (nor the other kind of ask). */
  private async read(read: () => Promise<readonly OpenCardAsk[]>): Promise<readonly OpenCardAsk[]> {
    try {
      return await read();
    } catch (error) {
      this.diagnostics.warn(
        `could not read the asks of the tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
