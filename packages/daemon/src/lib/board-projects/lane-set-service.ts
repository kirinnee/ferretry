/**
 * THE BOARD'S PROJECTS AND THEIR LANES. One place that answers "which projects have a board", "what are this
 * project's lanes" and "change them", over a store, the project registry and the agenda it is handed.
 *
 * The Unfiled board is not a registered project: it is listed here, beside the registered ones, with the
 * `quick` lanes until the owner stores another set. Nothing in this class touches `/v1/projects`.
 */
import {
  type BoardProject,
  type BoardProjectId,
  type BoardResult,
  boardErr,
  boardOk,
  type LaneSet,
  type LaneSetActionRequest,
  type LaneSetChangeResponse,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import {
  type LaneActor,
  type LaneSetProblem,
  actorName,
  confirmLaneSet,
  editLaneSet,
  proposeLaneSet,
  unfiledLaneSet,
} from './lane-set-policy.ts';
import { laneProposalCard, laneProposalReference } from './lane-proposal-card.ts';
import type { CardRelocator, LaneProposalAgenda, LaneSetSource, LaneSetStore } from './ports.ts';
import type { ProjectRegistry, SessionProjects } from './session-projects.ts';

export const UNFILED_PROJECT_NAME = 'Unfiled';

export type LaneSetFailure = LaneSetProblem | { readonly code: 'not-found'; readonly projectId: string };

export type LaneSetChange = LaneSetChangeResponse;

export class LaneSetService implements LaneSetSource {
  constructor(
    private readonly store: LaneSetStore,
    private readonly registry: ProjectRegistry,
    private readonly sessions: Pick<SessionProjects, 'projectOf'>,
    private readonly agenda: LaneProposalAgenda,
    private readonly relocator: CardRelocator,
  ) {}

  projectOf(sessionId: string): Promise<BoardProjectId> {
    return this.sessions.projectOf(sessionId);
  }

  async laneSet(projectId: BoardProjectId): Promise<LaneSet | null> {
    const stored = await this.store.read(projectId);
    return stored ?? defaultLaneSet(projectId);
  }

  /** Whether a card may be created in the project: a refusal names the command to run when it may not. */
  async hasLaneSet(projectId: BoardProjectId): Promise<boolean> {
    return (await this.laneSet(projectId)) !== null;
  }

  /** The Unfiled board first, then every registered project, each with its lanes or `null`. */
  async projects(): Promise<readonly BoardProject[]> {
    const registered = await this.registry.projects();
    const boards: BoardProject[] = [
      {
        id: UNFILED_PROJECT_ID,
        name: UNFILED_PROJECT_NAME,
        path: null,
        laneSet: await this.laneSet(UNFILED_PROJECT_ID),
      },
    ];
    for (const project of registered) {
      boards.push({ id: project.id, name: project.name, path: project.path, laneSet: await this.laneSet(project.id) });
    }
    return boards;
  }

  async project(projectId: BoardProjectId): Promise<BoardProject | undefined> {
    return (await this.projects()).find(board => board.id === projectId);
  }

  /** Applies a propose, edit or confirm. A ferret's unconfirmed result puts one choice on its agenda. */
  async apply(
    projectId: BoardProjectId,
    request: LaneSetActionRequest,
    actor: LaneActor,
  ): Promise<BoardResult<LaneSetChange, LaneSetFailure>> {
    const board = await this.project(projectId);
    if (board === undefined) return boardErr({ code: 'not-found', projectId });
    const decided = await this.store.transact<BoardResult<LaneSet, LaneSetProblem>>(projectId, current => {
      const result = decide(projectId, current ?? defaultLaneSet(projectId), request, actor);
      return result.ok ? { next: result.value, result } : { result };
    });
    if (!decided.ok) return decided;
    const laneSet = decided.value;
    if (request.action === 'edit') {
      const moves = relocations(request);
      if (Object.keys(moves).length > 0) await this.relocator.relocate(projectId, moves);
    }
    if (laneSet.confirmedBy !== null || actor.kind !== 'ferret') return boardOk({ laneSet, agenda: 'not-needed' });
    try {
      await this.agenda.raise(
        actor.sessionId,
        laneProposalReference(projectId, laneSet.version),
        laneProposalCard(board.name, laneSet),
      );
      return boardOk({ laneSet, agenda: 'raised' });
    } catch {
      return boardOk({ laneSet, agenda: 'failed' });
    }
  }

  /** The owner's Accept on a proposal card. A card for a version that has moved on confirms nothing. */
  async acceptProposal(projectId: BoardProjectId, version: number): Promise<boolean> {
    return await this.store.transact(projectId, current => {
      const confirmed = confirmLaneSet(current ?? defaultLaneSet(projectId), version);
      return confirmed.ok ? { next: confirmed.value, result: true } : { result: false };
    });
  }
}

const defaultLaneSet = (projectId: BoardProjectId): LaneSet | null =>
  projectId === UNFILED_PROJECT_ID ? unfiledLaneSet() : null;

const decide = (
  projectId: BoardProjectId,
  stored: LaneSet | null,
  request: LaneSetActionRequest,
  actor: LaneActor,
): BoardResult<LaneSet, LaneSetProblem> => {
  switch (request.action) {
    case 'propose':
      return proposeLaneSet(projectId, stored, request.template, request.renames, actorName(actor));
    case 'edit':
      return editLaneSet(stored, request, actor);
    case 'confirm':
      return actor.kind === 'owner' ? confirmLaneSet(stored, request.version) : boardErr({ code: 'owner-only' });
  }
};

const relocations = (request: Extract<LaneSetActionRequest, { action: 'edit' }>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(request.relocate).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
