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
  laneProposalReference,
  LaneSetSchema,
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import { laneChangeCard, laneProposalCard } from './lane-proposal-card.ts';
import {
  addQuickToTestLane,
  decideLaneChange,
  describeRelocationProblem,
  type LaneActor,
  type LaneSetDecision,
  type LaneSetProblem,
  mergeReleaseLanes,
  RELEASED_TO_TEST_NAME,
  relocationProblems,
  stageLanes,
  unfiledLaneSet,
} from './lane-set-policy.ts';
import type { CardRelocator, LaneProposalAgenda, LaneSetSource, LaneSetStore, RelocationAuthority } from './ports.ts';
import type { ProjectRegistry, SessionProjects } from './session-projects.ts';

export const UNFILED_PROJECT_NAME = 'Unfiled';

export type LaneSetFailure = LaneSetProblem | { readonly code: 'not-found'; readonly projectId: string };

export type LaneSetChange = LaneSetChangeResponse;

/** What the boot merge of the release lanes did to one project's set. */
export type ReleaseLaneMergeOutcome =
  | { readonly projectId: BoardProjectId; readonly merged: true; readonly version: number }
  | { readonly projectId: BoardProjectId; readonly merged: false; readonly problem: string };

/** What the boot migration that adds quick's To test lane did to one project's set. */
export type QuickToTestOutcome =
  | { readonly projectId: BoardProjectId; readonly added: true; readonly version: number }
  | { readonly projectId: BoardProjectId; readonly added: false; readonly problem: string };

/** What the boot migration that writes out every lane's stage did to one project's set. */
export type StageLanesOutcome =
  | { readonly projectId: BoardProjectId; readonly staged: true; readonly version: number }
  | { readonly projectId: BoardProjectId; readonly staged: false; readonly problem: string };

/** What a card's history says when the merge moves it. */
export const RELEASE_MERGE_REASON = `Released and To test are one lane now: ${RELEASED_TO_TEST_NAME}`;

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

  /**
   * Applies a propose, edit or confirm (`decideLaneChange`). A ferret's change to a project that has lanes waits
   * for the owner and moves nothing; any ferret result the owner has not confirmed puts one choice on its agenda.
   * Cards move only once a change is live, as whoever made it live: the owner's, or the checked daemon's.
   */
  async apply(
    projectId: BoardProjectId,
    request: LaneSetActionRequest,
    actor: LaneActor,
  ): Promise<BoardResult<LaneSetChange, LaneSetFailure>> {
    const board = await this.project(projectId);
    if (board === undefined) return boardErr({ code: 'not-found', projectId });
    // A ferret's change never relocates: it waits, or it is a first proposal with no cards to move.
    const decided = await this.store.transact<BoardResult<LaneSetDecision, LaneSetProblem>>(projectId, current => {
      const result = decideLaneChange(projectId, current ?? defaultLaneSet(projectId), request, actor);
      return result.ok ? { next: result.value.next, result } : { result };
    });
    if (!decided.ok) return decided;
    const decision = decided.value;
    const laneSet = decision.next;
    if (Object.keys(decision.relocate).length > 0) {
      await this.relocator.relocate(projectId, decision.relocate, authorityOf(actor));
    }
    if (actor.kind !== 'ferret') return boardOk({ laneSet, agenda: 'not-needed' });
    const pending = decision.change === 'pending' ? laneSet.pending : undefined;
    if (pending === undefined && laneSet.confirmedBy !== null) return boardOk({ laneSet, agenda: 'not-needed' });
    try {
      await this.agenda.raise(
        actor.sessionId,
        laneProposalReference(projectId, pending?.version ?? laneSet.version),
        pending === undefined ? laneProposalCard(board.name, laneSet) : laneChangeCard(board.name, laneSet, pending),
      );
      return boardOk({ laneSet, agenda: 'raised' });
    } catch {
      return boardOk({ laneSet, agenda: 'failed' });
    }
  }

  /**
   * The boot migration that folds every stored set's Released and To test lanes into one
   * ({@link mergeReleaseLanes}). Cards move first, while the old set still has both lanes, so a card is never
   * in a lane its set lacks; then the set is stored; then a second pass moves any card a release put in To
   * test meanwhile. Idempotent (a merged set has nothing to merge) and total: a project that fails is
   * reported and the rest go on. The owner is asked nothing.
   */
  async mergeReleaseLanes(): Promise<readonly ReleaseLaneMergeOutcome[]> {
    const ids = [UNFILED_PROJECT_ID, ...(await this.registry.projects()).map(project => project.id)];
    const outcomes: ReleaseLaneMergeOutcome[] = [];
    for (const projectId of ids) {
      try {
        const stored = await this.store.read(projectId);
        const plan = stored === null ? null : mergeReleaseLanes(stored);
        if (plan === null) continue;
        const moves = { [plan.from]: plan.into };
        // The daemon moves these cards, so the move is checked as any of its relocations is.
        const refused = relocationProblems(stored ?? plan.next, plan.next, moves)[0];
        if (refused !== undefined) throw new Error(describeRelocationProblem(refused));
        await this.relocator.relocate(projectId, moves, DAEMON, RELEASE_MERGE_REASON);
        const version = await this.store.transact<number | null>(projectId, current => {
          const again = current === null ? null : mergeReleaseLanes(current);
          return again === null ? { result: null } : { next: again.next, result: again.next.version };
        });
        if (version === null) continue;
        await this.relocator.relocate(projectId, moves, DAEMON, RELEASE_MERGE_REASON);
        outcomes.push({ projectId, merged: true, version });
      } catch (error) {
        outcomes.push({ projectId, merged: false, problem: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  }

  /**
   * The boot migration that gives every stored `quick` set from before To test its To test lane
   * ({@link addQuickToTestLane}). No lane goes, so no card moves: the cards a merge already finished then
   * move on their facts, each with its own history. Idempotent (a set with To test does not match) and
   * total: a project that fails is reported and the rest go on. The owner is asked nothing.
   */
  async addQuickToTestLanes(): Promise<readonly QuickToTestOutcome[]> {
    const ids = [UNFILED_PROJECT_ID, ...(await this.registry.projects()).map(project => project.id)];
    const outcomes: QuickToTestOutcome[] = [];
    for (const projectId of ids) {
      try {
        const version = await this.store.transact<number | null>(projectId, current => {
          const next = current === null ? null : addQuickToTestLane(current);
          return next === null ? { result: null } : { next, result: next.version };
        });
        if (version !== null) outcomes.push({ projectId, added: true, version });
      } catch (error) {
        outcomes.push({ projectId, added: false, problem: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  }

  /**
   * The boot migration that writes the stage of every lane stored without one ({@link stageLanes}): the
   * stage its compatibility fields already describe, so no card moves and nothing behaves differently. A
   * damaged set is refused by the store, reported, and the rest go on; a staged set the next read would refuse
   * is never written, since the store does not check what it writes and the board would read as damaged from
   * then on. Idempotent (a staged set does not match) and total. The owner is asked nothing.
   */
  async stageLanes(): Promise<readonly StageLanesOutcome[]> {
    const ids = [UNFILED_PROJECT_ID, ...(await this.registry.projects()).map(project => project.id)];
    const outcomes: StageLanesOutcome[] = [];
    for (const projectId of ids) {
      try {
        const version = await this.store.transact<number | null>(projectId, current => {
          const next = current === null ? null : stageLanes(current);
          if (next !== null && !LaneSetSchema.safeParse(next).success) {
            throw new Error('staging its lanes would leave them unreadable, so they are left as they are');
          }
          return next === null ? { result: null } : { next, result: next.version };
        });
        if (version !== null) outcomes.push({ projectId, staged: true, version });
      } catch (error) {
        outcomes.push({ projectId, staged: false, problem: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  }

  /**
   * The owner's Accept on a proposal card: it confirms the live set of that version, or makes the waiting proposal
   * of that version live and moves its cards as the owner's. A card for a version that has moved on confirms
   * nothing. Only ever called for the owner's own answer (`LaneProposalAcceptance`).
   */
  async acceptProposal(projectId: BoardProjectId, version: number): Promise<boolean> {
    const accepted = await this.store.transact<LaneSetDecision | null>(projectId, current => {
      const decided = decideLaneChange(
        projectId,
        current ?? defaultLaneSet(projectId),
        { action: 'confirm', version },
        OWNER,
      );
      return decided.ok ? { next: decided.value.next, result: decided.value } : { result: null };
    });
    if (accepted === null) return false;
    if (Object.keys(accepted.relocate).length > 0) await this.relocator.relocate(projectId, accepted.relocate, OWNER);
    return true;
  }
}

const OWNER = { kind: 'owner' } as const satisfies LaneActor & RelocationAuthority;
const DAEMON: RelocationAuthority = { kind: 'daemon' };

const authorityOf = (actor: LaneActor): RelocationAuthority =>
  actor.kind === 'owner' ? (actor.via === undefined ? OWNER : { kind: 'owner', via: actor.via }) : DAEMON;

const defaultLaneSet = (projectId: BoardProjectId): LaneSet | null =>
  projectId === UNFILED_PROJECT_ID ? unfiledLaneSet() : null;
