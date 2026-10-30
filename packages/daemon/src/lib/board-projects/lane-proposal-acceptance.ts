/**
 * Turns the owner's Accept on a lane-proposal card into a confirmed lane set. It listens to every agenda
 * change and acts on exactly one: an item answered "Accept" whose reference names a project and version.
 * Total, as every change observer is: a store that fails leaves the card answered and the set a proposal,
 * and the owner can confirm it again from the Board.
 */
import type { AttentionBoardChange, AttentionChangeObserver } from '../attention/service.ts';
import { acceptedProposal } from './lane-proposal-card.ts';
import type { LaneSetService } from './lane-set-service.ts';

export class LaneProposalAcceptance implements AttentionChangeObserver {
  constructor(private readonly lanes: Pick<LaneSetService, 'acceptProposal'>) {}

  async changed(_sessionId: string, change: AttentionBoardChange): Promise<void> {
    if (change.change !== 'answered' || change.addressed === undefined) return;
    const accepted = acceptedProposal(change.addressed);
    if (accepted === undefined) return;
    await this.lanes.acceptProposal(accepted.projectId, accepted.version).catch(() => false);
  }
}
