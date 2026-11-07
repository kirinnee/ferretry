/**
 * PEER: today's `packages/protocol/src/lib/{board,board-lanes}.ts` and `packages/daemon/src/lib/board/graph.ts`
 * (owner: board) — the part of a card the session archive reads.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the
 * host.
 */

/** The semantics the daemon reasons over, in the order a card normally travels through them. */
export type LaneCategory = 'backlog' | 'active' | 'review' | 'shipped' | 'verify' | 'closed';

/**
 * One card as the archive's keep rule reads it: who owns and holds it, whether it was dropped, and the category of
 * the lane it sits in as Board resolved it (today's `cardCategory(card, laneSets)`) — `undefined` when the lane
 * could not be read.
 */
export interface OpenCardStanding {
  readonly owner: string;
  readonly assignee: string | null;
  readonly dropped: unknown;
  readonly category: LaneCategory | undefined;
}
