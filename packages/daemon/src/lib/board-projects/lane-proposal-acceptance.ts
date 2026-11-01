/**
 * Turns the owner's Accept on a lane-proposal card into a confirmed lane set. It listens to every agenda
 * change and acts on exactly one: an item answered "Accept" BY A PERSON whose reference names a project and
 * version. A lead may answer the daemon's items on its sub-ferret's agenda, and the daemon its own, so neither
 * accepts lanes: a ferret's proposal waits for the owner, never for another ferret.
 * Total, as every change observer is: a store that fails leaves the card answered and the set a proposal,
 * and the owner can confirm it again from the Board.
 */
import type { AgendaBoardChange, AgendaChangeObserver } from '../agenda/service.ts';
import { acceptedProposal } from './lane-proposal-card.ts';
import type { LaneSetService } from './lane-set-service.ts';

export class LaneProposalAcceptance implements AgendaChangeObserver {
  constructor(private readonly lanes: Pick<LaneSetService, 'acceptProposal'>) {}

  async changed(_sessionId: string, change: AgendaBoardChange): Promise<void> {
    if (change.change !== 'answered' || change.addressed === undefined || change.actor.kind !== 'human') return;
    const accepted = acceptedProposal(change.addressed);
    if (accepted === undefined) return;
    await this.lanes.acceptProposal(accepted.projectId, accepted.version).catch(() => false);
  }
}
