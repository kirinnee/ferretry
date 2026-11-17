/**
 * SHIPPING UNITS (docs/design/clash-queue.md § Shipping units): which cards' work merges together. The one definition
 * both the claim-time queue (`clash-queue.ts`) and the merge gate (`merge-gate.ts`) use, so they cannot disagree.
 *
 * - A card SHIPS ITS OWN work when it links a PR that is open, not polled yet, or merged. Otherwise it is a PR-free
 *   card (the same test `isPrFreeHelper` closes a helper by, plus a just-linked PR): a helper, or an umbrella lead.
 * - Its SHIPPING CARD is itself when it ships its own work or has no parent here, else its parent's shipping card: a
 *   helper's work merges in its lead's PR. Shipping cards that link a PR in common that is still in flight merge
 *   together, so they are ONE unit: its KEY is the first such card's id (store order), the same for every one of them.
 * - A card RIDES its own key, and a PR-free card also rides the keys of everything under it that is not dropped: an
 *   umbrella lead's claims are touched by whichever child PR merges. A dropped child merges nothing, though the live
 *   cards under it still do.
 * - Two cards are in the SAME UNIT when they ride a key in common. A merged or closed PR two cards both kept from
 *   earlier says nothing about the next merge, so only PRs in flight join units.
 */
import type { Task, PrLink } from '../../../contract/index.ts';
import type { BoardIndex } from './graph.ts';

/** A PR still in flight: open, or linked but not polled yet. */
const inFlight = (pr: Pick<PrLink, 'state'>): boolean => pr.state === 'open' || pr.state === 'unknown';

/** Whether the card ships its own work: a PR of its own in flight or merged. */
const shipsItsOwn = (task: Pick<Task, 'links'>): boolean =>
  task.links.prs.some(pr => inFlight(pr) || pr.state === 'merged');

const prKey = (pr: Pick<PrLink, 'repo' | 'number'>): string => `${pr.repo.toLowerCase()}#${String(pr.number)}`;

/** The units of one board read. Memoised per card id; build one per read, never keep it. */
export class ShippingUnits {
  private readonly shipping = new Map<string, Task>();
  private readonly riding = new Map<string, ReadonlySet<string>>();
  /** Union-find over shipping-card ids: cards linking an in-flight PR in common share one root. */
  private readonly joined = new Map<string, string>();

  constructor(private readonly index: BoardIndex) {
    const firstWithPr = new Map<string, string>();
    for (const task of index.cards) {
      if (task.dropped !== null) continue;
      const shipping = this.shippingCard(task);
      for (const pr of shipping.links.prs.filter(inFlight)) {
        const first = firstWithPr.get(prKey(pr));
        if (first === undefined) firstWithPr.set(prKey(pr), shipping.id);
        else this.join(first, shipping.id);
      }
    }
  }

  private root(id: string): string {
    let current = id;
    for (
      let parent = this.joined.get(current);
      parent !== undefined && parent !== current;
      parent = this.joined.get(current)
    ) {
      current = parent;
    }
    return current;
  }

  /** Joins two units; the root is the one met first in store order (it was given first), so keys are stable. */
  private join(first: string, other: string): void {
    const kept = this.root(first);
    const merged = this.root(other);
    if (kept !== merged) this.joined.set(merged, kept);
  }

  /** The card whose PR ships this card's work (see the module doc). A parent loop stops where it closes. */
  shippingCard(task: Task): Task {
    const known = this.shipping.get(task.id);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    let current = task;
    while (!shipsItsOwn(current) && current.parent !== null && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = this.index.get(current.parent);
      if (parent === undefined) break;
      current = parent;
    }
    this.shipping.set(task.id, current);
    return current;
  }

  /** The unit's key: the same for every card whose work merges together (see the module doc). */
  key(task: Task): string {
    return this.root(this.shippingCard(task).id);
  }

  /** The unit keys this card's claims and waits belong to (see the module doc). */
  rides(task: Task): ReadonlySet<string> {
    const known = this.riding.get(task.id);
    if (known !== undefined) return known;
    const keys = new Set([this.key(task)]);
    if (!shipsItsOwn(task)) {
      const seen = new Set<string>([task.id]);
      const pending = [...this.index.children(task.id)];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (seen.has(next.id)) continue;
        seen.add(next.id);
        // A dropped card merges nothing itself, but dropping it leaves the cards under it alive.
        if (next.dropped === null) keys.add(this.key(next));
        pending.push(...this.index.children(next.id));
      }
    }
    this.riding.set(task.id, keys);
    return keys;
  }

  /** Whether two cards' work merges together (see the module doc). */
  sameUnit(left: Task, right: Task): boolean {
    const theirs = this.rides(right);
    for (const key of this.rides(left)) if (theirs.has(key)) return true;
    return false;
  }
}
