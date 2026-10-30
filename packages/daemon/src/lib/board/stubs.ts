/**
 * STUBS for the board ports later units implement (`board-design.md` §6). Each says exactly what it
 * does not know, and each is replaced, not extended:
 *
 * - {@link StubLaneSetSource} → U3 (projects and lanes)
 * - {@link NoLaneProposals} → U3 (lane proposals)
 *
 * They do no IO, which is why they live in the domain tier and are unit tested.
 */
import { type BoardProjectId, LANE_TEMPLATES, type LaneSet, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import type { LaneProposer, LaneSetSource } from './ports.ts';

/** Who a stub lane set says proposed it. Not a session id: nothing proposed it. */
export const STUB_LANE_SET_PROPOSER = 'stub';

/**
 * STUB, REPLACED BY U3. Files every session on the Unfiled board and gives every project the
 * `pr-release-verify` template, unconfirmed. U3 resolves `config.projectId` and stores real lane sets.
 */
export class StubLaneSetSource implements LaneSetSource {
  async projectOf(_sessionId: string): Promise<BoardProjectId> {
    return UNFILED_PROJECT_ID;
  }

  async laneSet(projectId: BoardProjectId): Promise<LaneSet> {
    const template = LANE_TEMPLATES['pr-release-verify'];
    return {
      projectId,
      version: 1,
      confirmedBy: null,
      proposedBy: STUB_LANE_SET_PROPOSER,
      lanes: [...template.lanes],
      variants: template.variants,
    };
  }
}

/**
 * STUB, REPLACED BY U3's lane proposals. Proposes nothing: until U3 lands every project reads the stub's
 * lanes, so a start never finds a project without them.
 */
export class NoLaneProposals implements LaneProposer {
  async propose(): Promise<LaneSet | null> {
    return null;
  }
}
