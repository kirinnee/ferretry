/**
 * ASKS' LINK TO CARDS (docs/agenda.md § Card asks): which open asks carry each card, and which of those are the card's
 * own gate ask, the one the owner has yet to answer. Asks owns the fact; a card only DERIVES from it (its `openAsks`,
 * and that it is never stale while its ask is open), so the card store holds no copy and answering the ask clears it
 * with no write to the card.
 *
 * An ask carries a card when it is about the card (a ferret's own ask naming it, or a card a merge brought in) or is
 * one of the card's gate obligations (source `card`). An ask lives on the ledger of the ferret that raised it, or of
 * the ferret the daemon raised it for; the ledgers read are the ferrets on the board — every card's owner and
 * assignee — and their homes, because a card's ask goes on its ferret's home. A notice is context, never an ask, so
 * it is not counted.
 */
import type { AskRef } from '../../../contract/index.ts';
import type { Card, CardId } from '../../../contract/index.ts';
import { effectiveAssignee } from './authority.ts';
import type { CardAskLinkSource, CardAsks } from './ports.ts';

/** The part of an open ask the link reads. */
export interface OpenAskFacts {
  /** The ask's id on its ferret's ledger (`A12`). */
  readonly id: string;
  /** A notice is context, never an ask. */
  readonly notice?: boolean | undefined;
  /** The cards it is about (a thread linked to a card, a merge). */
  readonly cards: readonly CardId[];
  /** The cards for which it is the open gate obligation. */
  readonly gateOf: readonly CardId[];
}

/** One ferret's open asks, read through Asks (`AsksApi.open`). Empty for a ferret with none. */
export interface FerretAsksReader {
  open(ferret: string): Promise<readonly OpenAskFacts[]>;
}

/** Where a ferret's asks live: its home, the owner's own ferret at the root of its lineage. */
export interface AskHomeLookup {
  of(ferret: string): Promise<string>;
}

/** How many ledgers are read at once. */
export const ASK_READ_CONCURRENCY = 16;

/** Every ferret is its own home: for a board without helpers, and the tests. */
const SELF_HOMES: AskHomeLookup = { of: async ferret => ferret };

export class CardAskLinks implements CardAskLinkSource {
  constructor(
    private readonly asks: FerretAsksReader,
    private readonly diagnostics: { warn(message: string): void },
    private readonly homes: AskHomeLookup = SELF_HOMES,
  ) {}

  async asksFor(
    cards: readonly Card[],
    board: readonly Card[] = cards,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<CardId, CardAsks>> {
    const ferrets = [...new Set(board.flatMap(card => [card.owner, effectiveAssignee(card)]))];
    const homes = await Promise.all(ferrets.map(async each => await this.homes.of(each).catch(() => each)));
    const ledgers = [...new Set([...ferrets, ...homes])];
    const found = new Map<CardId, { open: AskRef[]; asking: AskRef[] }>();
    for (let start = 0; start < ledgers.length; start += ASK_READ_CONCURRENCY) {
      signal?.throwIfAborted();
      const batch = ledgers.slice(start, start + ASK_READ_CONCURRENCY);
      const read = await Promise.all(batch.map(async ferret => [ferret, await this.read(ferret)] as const));
      for (const [ferret, items] of read) {
        for (const item of items) {
          if (item.notice === true) continue;
          const ref: AskRef = { ferret, id: item.id };
          for (const card of cards) {
            const gate = item.gateOf.includes(card.id);
            if (!gate && !item.cards.includes(card.id)) continue;
            const entry = found.get(card.id) ?? { open: [], asking: [] };
            entry.open.push(ref);
            if (gate) entry.asking.push(ref);
            found.set(card.id, entry);
          }
        }
      }
    }
    return found;
  }

  /** A ledger that cannot be read costs its asks, never the board read. */
  private async read(ferret: string): Promise<readonly OpenAskFacts[]> {
    try {
      return await this.asks.open(ferret);
    } catch (error) {
      this.diagnostics.warn(
        `could not read the asks of ${ferret} for its cards: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
