import type { BoardProjectId, LaneSet } from '@ferretry/protocol';
import { InferredLaneProposer, type ProjectGitFactSource, type ProposalLaneSets } from '../board-projects/index.ts';
import type { ImportProjects } from './ports.ts';

/** The lane-set operations the import uses; `LaneSetService` is one. */
export interface ImportLaneSets extends ProposalLaneSets {
  projectOf(sessionId: string): Promise<BoardProjectId>;
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
}

/**
 * The importer's view of projects: which board a session is on, its lanes, and the proposal made when it has
 * none. The proposal is the inferred template, UNCONFIRMED, made as the session that needs it, so the lane
 * service puts the one choice on that session's agenda and the cards can be filed at once.
 */
export class LaneSetImportProjects implements ImportProjects {
  private readonly proposer: InferredLaneProposer;

  constructor(
    private readonly lanes: ImportLaneSets,
    facts: ProjectGitFactSource,
  ) {
    this.proposer = new InferredLaneProposer(lanes, facts);
  }

  projectOf(sessionId: string): Promise<BoardProjectId> {
    return this.lanes.projectOf(sessionId);
  }

  laneSet(projectId: BoardProjectId): Promise<LaneSet | null> {
    return this.lanes.laneSet(projectId);
  }

  propose(projectId: BoardProjectId, sessionId: string): Promise<LaneSet | null> {
    return this.proposer.propose(projectId, sessionId);
  }
}
