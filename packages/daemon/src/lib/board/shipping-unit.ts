/**
 * SHIPPING UNITS (docs/design/clash-queue.md § Shipping units): which cards' work merges together. The one definition
 * both the claim-time queue (`clash-queue.ts`) and the merge gate (`merge-gate.ts`) use, so they cannot disagree.
 *
 * - A card SHIPS ITS OWN work when it links a PR that is open, not polled yet, or merged. Otherwise it is a PR-free
 *   card (the same test `isPrFreeHelper` closes a helper by, plus a just-linked PR): a helper, or an umbrella lead.
 * - Its SHIPPING CARD is itself when it ships its own work or has no parent here, else its parent's shipping card: a
 *   helper's work merges in its lead's PR. The unit's KEY is the shipping card's id.
 * - A card RIDES its own key, and a PR-free card also rides the keys of everything under it: an umbrella lead's claims
 *   are touched by whichever child PR merges.
 * - Two cards are in the SAME UNIT when they ride a key in common, or their shipping cards link a PR in common that is
 *   still in flight (a merged or closed PR they both kept from earlier says nothing about the next merge).
 */
import type { BoardTask, PrLink } from '@ferretry/protocol';
import type { BoardIndex } from './graph.ts';

/** A PR still in flight: open, or linked but not polled yet. */
const inFlight = (pr: Pick<PrLink, 'state'>): boolean => pr.state === 'open' || pr.state === 'unknown';

/** Whether the card ships its own work: a PR of its own in flight or merged. */
const shipsItsOwn = (card: Pick<BoardTask, 'links'>): boolean =>
  card.links.prs.some(pr => inFlight(pr) || pr.state === 'merged');

const prKey = (pr: Pick<PrLink, 'repo' | 'number'>): string => `${pr.repo.toLowerCase()}#${String(pr.number)}`;

/** The units of one board read. Memoised per card id; build one per read, never keep it. */
export class ShippingUnits {
  private readonly shipping = new Map<string, BoardTask>();
  private readonly riding = new Map<string, ReadonlySet<string>>();

  constructor(private readonly index: BoardIndex) {}

  /** The card whose PR ships this card's work (see the module doc). A parent loop stops where it closes. */
  shippingCard(card: BoardTask): BoardTask {
    const known = this.shipping.get(card.id);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    let current = card;
    while (!shipsItsOwn(current) && current.parent !== null && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = this.index.get(current.parent);
      if (parent === undefined) break;
      current = parent;
    }
    this.shipping.set(card.id, current);
    return current;
  }

  key(card: BoardTask): string {
    return this.shippingCard(card).id;
  }

  /** The unit keys this card's claims and waits belong to (see the module doc). */
  rides(card: BoardTask): ReadonlySet<string> {
    const known = this.riding.get(card.id);
    if (known !== undefined) return known;
    const keys = new Set([this.key(card)]);
    if (!shipsItsOwn(card)) {
      const seen = new Set<string>([card.id]);
      const pending = [...this.index.children(card.id)];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (seen.has(next.id)) continue;
        seen.add(next.id);
        keys.add(this.key(next));
        pending.push(...this.index.children(next.id));
      }
    }
    this.riding.set(card.id, keys);
    return keys;
  }

  /** Whether two cards' work merges together (see the module doc). */
  sameUnit(left: BoardTask, right: BoardTask): boolean {
    const theirs = this.rides(right);
    for (const key of this.rides(left)) if (theirs.has(key)) return true;
    const inFlightOf = (card: BoardTask) => this.shippingCard(card).links.prs.filter(inFlight).map(prKey);
    const mine = new Set(inFlightOf(left));
    return inFlightOf(right).some(key => mine.has(key));
  }
}
