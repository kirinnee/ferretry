/**
 * Turns the owner's Accept on a lane-proposal ask into a confirmed lane set. It is handed every answer Asks reports
 * (`asks.answered`, read through the Asks port) and acts on exactly one: an answer of "Accept" to an ask the lane
 * producer raised whose entry names a project and version. Asks only ever records the OWNER's answers (at the machine
 * or from a paired device), so a ferret's proposal waits for the owner and never for another ferret.
 * Total, as every answer observer is: a store that fails leaves the ask answered and the set a proposal, and the
 * owner can confirm it again from the Board.
 */
import { acceptedProposal, type LaneProposalAnswer } from './lane-proposal-card.ts';
import type { LaneSetService } from './lane-set-service.ts';

export class LaneProposalAcceptance {
  constructor(private readonly lanes: Pick<LaneSetService, 'acceptProposal'>) {}

  async answered(answer: LaneProposalAnswer): Promise<void> {
    const accepted = acceptedProposal(answer);
    if (accepted === undefined) return;
    await this.lanes.acceptProposal(accepted.projectId, accepted.version).catch(() => false);
  }
}
