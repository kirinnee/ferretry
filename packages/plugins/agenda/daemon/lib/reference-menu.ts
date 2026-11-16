import type { AsksApi } from '@ferretry/core-asks/contract';
import {
  type ReferenceCatalogEntry,
  type ReferenceCatalogInput,
  type ReferenceCatalogProvider,
  referenceCatalogLimit,
} from '@ferretry/plugin-conversation/contract';

/** The longest `label` a catalog entry may carry (the contract's bound); a longer subject is cut, never refused. */
const LABEL_MAX = 256;

const clip = (text: string): string => (text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`);

/**
 * THE `!` MENU OF A FERRET'S COMPOSER (reference.catalog, lead decision Q6): the ferret's open asks, as the composer
 * offered them before — the ferret's own board, in the order its board lists them.
 *
 * Today's rows, copied: the token is the ask's id (`A3`, inserted as `!A3`), the label is its subject, the detail is
 * where it came from (`task`, `question`, `agent-raised`). A query narrows by the id, the subject or the source, case
 * ignored. A resolved ask is not on the board's items, so it is not offered; an ask is `closed` only if the board marks
 * it so, and the composer hides a `closed` row.
 *
 * DEMAND: none. The facts are the ferret's board, whose direct read (`GET /v1/ferrets/:ferretId/agenda`, Asks') asks the
 * operator no capability — the board is gated by who acts (docs/grants.md) — so this menu asks none either, and answers
 * nothing the caller could not read through that route. Only ids, subjects and sources leave: no token, no digest.
 */
export class AgendaReferenceMenu implements ReferenceCatalogProvider {
  constructor(private readonly asks: Pick<AsksApi, 'snapshots'>) {}

  async entries(input: ReferenceCatalogInput): Promise<readonly ReferenceCatalogEntry[]> {
    const [board] = await this.asks.snapshots({ ferret: input.ferret });
    if (board === undefined) return [];
    const wanted = input.query?.trim().toLowerCase() ?? '';
    return board.items
      .filter(item => wanted === '' || `${item.id} ${item.subject} ${item.source}`.toLowerCase().includes(wanted))
      .slice(0, referenceCatalogLimit('!'))
      .map(item => ({ token: item.id, label: clip(item.subject), detail: item.source }));
  }
}
