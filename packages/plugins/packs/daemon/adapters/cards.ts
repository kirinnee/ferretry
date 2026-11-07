import type { DelegationOutcome, DelegationRequest, PackCardsPort } from '../lib/cards.ts';

/**
 * The helper's card, as far as Packs may decide it alone. Board owns cards and is not a dependency of Packs (§2.3), so
 * Packs cannot reserve a NEW card under the lead's focus card: a helper started without `--card` starts without one, and
 * `fy new` says so. A card the lead NAMES is handed to Ferrets' start, which assigns the helper to it.
 *
 * GAP: the lead's side of delegation (reserving a child card under the lead's focus) returns when Board offers it as a
 * port Packs may use.
 */
export class NamedCardOnly implements PackCardsPort {
  async delegate(lead: string, request: DelegationRequest): Promise<DelegationOutcome> {
    if (request.card === undefined) return { notes: [] };
    return {
      delegation: { lead, brief: request.brief, id: request.card, existing: true, parent: null },
      notes: [],
    };
  }
}
