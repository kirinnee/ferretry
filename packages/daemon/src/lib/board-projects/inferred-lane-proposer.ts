import type { BoardProject, BoardProjectId, BoardResult, LaneSet, LaneSetActionRequest } from '@ferretry/protocol';
import type { LaneSetChange, LaneSetFailure } from './lane-set-service.ts';
import type { LaneActor } from './lane-set-policy.ts';
import type { ProjectGitFactSource } from './ports.ts';
import { inferLaneTemplate } from './template-inference.ts';

/** The lane-set operations a proposal uses; `LaneSetService` is one. */
export interface ProposalLaneSets {
  project(projectId: BoardProjectId): Promise<BoardProject | undefined>;
  apply(
    projectId: BoardProjectId,
    request: LaneSetActionRequest,
    actor: LaneActor,
  ): Promise<BoardResult<LaneSetChange, LaneSetFailure>>;
}

/**
 * Puts lanes on a project that has none (`board-design.md` §5 step 4): the template inferred from the project's
 * folder, UNCONFIRMED, proposed as the session that needs it, so the lane service raises the one agenda choice on
 * that session and its cards can be filed at once. Satisfies the board's `LaneProposer`; `null` when it could not.
 */
export class InferredLaneProposer {
  constructor(
    private readonly lanes: ProposalLaneSets,
    private readonly facts: ProjectGitFactSource,
  ) {}

  async propose(projectId: BoardProjectId, sessionId: string): Promise<LaneSet | null> {
    const project = await this.lanes.project(projectId);
    if (project === undefined) return null;
    const template = inferLaneTemplate(
      project.path === null ? { hasRepository: false, hasReleaseTags: false } : await this.facts.inspect(project.path),
    );
    const change = await this.lanes.apply(
      projectId,
      { action: 'propose', template, renames: {} },
      { kind: 'ferret', name: sessionId, sessionId },
    );
    return change.ok ? change.value.laneSet : null;
  }
}
