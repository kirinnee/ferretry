import type { BoardProject, BoardProjectId, BoardResult, LaneSet, LaneSetActionRequest } from '@ferretry/protocol';
import type { LaneActor, LaneSetChange, LaneSetFailure } from '../board-projects/index.ts';
import { inferLaneTemplate, type ProjectGitFactSource } from '../board-projects/index.ts';
import type { ImportProjects } from './ports.ts';

/** The lane-set operations the import uses; `LaneSetService` is one. */
export interface ImportLaneSets {
  projectOf(sessionId: string): Promise<BoardProjectId>;
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
  project(projectId: BoardProjectId): Promise<BoardProject | undefined>;
  apply(
    projectId: BoardProjectId,
    request: LaneSetActionRequest,
    actor: LaneActor,
  ): Promise<BoardResult<LaneSetChange, LaneSetFailure>>;
}

/**
 * The importer's view of projects: which board a session is on, its lanes, and the proposal made when it has
 * none. The proposal is the inferred template, UNCONFIRMED, made as the session that needs it, so the lane
 * service puts the one choice on that session's agenda and the cards can be filed at once.
 */
export class LaneSetImportProjects implements ImportProjects {
  constructor(
    private readonly lanes: ImportLaneSets,
    private readonly facts: ProjectGitFactSource,
  ) {}

  projectOf(sessionId: string): Promise<BoardProjectId> {
    return this.lanes.projectOf(sessionId);
  }

  laneSet(projectId: BoardProjectId): Promise<LaneSet | null> {
    return this.lanes.laneSet(projectId);
  }

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
