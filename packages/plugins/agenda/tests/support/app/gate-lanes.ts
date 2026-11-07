/**
 * A project's lanes and cards for the Agenda's gate rule (`awaiting-owner.ts`): the lane ids of today's default board
 * with a verify lane (`tested`), in the shape the rule reads. Board owns the real lanes; this is a fixture of them.
 */

import type { GateCard, GateLaneSet } from '../../../app/lib/awaiting-owner.ts';

export const GATE_LANES: GateLaneSet = {
  lanes: [
    { id: 'todo', category: 'backlog' },
    { id: 'plan', category: 'active', ownerGate: true },
    { id: 'implement', category: 'active' },
    { id: 'review', category: 'review' },
    { id: 'tested', category: 'verify', ownerGate: true },
    { id: 'merged', category: 'shipped' },
    { id: 'released', category: 'shipped' },
    { id: 'closed', category: 'closed', ownerGate: true },
  ],
};

/** A person-asked top-level card in Todo, with `extra` over it. */
export const gateCard = (
  id: string,
  extra: Record<string, unknown> = {},
): GateCard & { readonly task: { readonly id: string } } => ({
  task: { id, laneId: 'todo', dropped: null, parent: null, askedBy: 'person', ...extra },
});
