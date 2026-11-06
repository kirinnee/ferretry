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
  UNFILED_PROJECT_ID,
} from '@ferretry/protocol';
import { laneChangeCard, laneProposalCard } from './lane-proposal-card.ts';
import {
  decideLaneChange,
  type LaneActor,
  type LaneSetDecision,
  type LaneSetProblem,
  unfiledLaneSet,
} from './lane-set-policy.ts';
import type { CardRelocator, LaneProposalAgenda, LaneSetSource, LaneSetStore, RelocationAuthority } from './ports.ts';
import type { ProjectRegistry, SessionProjects } from './session-projects.ts';
import { ancestorsOf } from '../board/lineage.ts';
import type { SessionParents } from '../board/ports.ts';

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
    /** Who started whom, so a lead may replace its own ferret's waiting proposal. Absent, only that ferret may. */
    private readonly parents?: SessionParents,
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
    const leads = await this.leadsProposer(projectId, actor);
    // A ferret's change never relocates: it waits, or it is a first proposal with no cards to move.
    const decided = await this.store.transact<
      BoardResult<{ readonly decision: LaneSetDecision; readonly before: LaneSet | null }, LaneSetProblem>
    >(projectId, current => {
      const before = current ?? defaultLaneSet(projectId);
      const result = decideLaneChange(projectId, before, request, actor, leads);
      return result.ok ? { next: result.value.next, result: boardOk({ decision: result.value, before }) } : { result };
    });
    if (!decided.ok) return decided;
    const { decision, before } = decided.value;
    const laneSet = decision.next;
    await this.withdrawGone(projectId, before?.pending, laneSet, request.action === 'confirm');
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
    // Answered on the agenda: the card is closed already, so there is nothing to withdraw.
    if (Object.keys(accepted.relocate).length > 0) await this.relocator.relocate(projectId, accepted.relocate, OWNER);
    return true;
  }

  /**
   * Whether a ferret leads the session that proposed the waiting proposal it would replace (`docs/board.md` § A
   * ferret's lane change waits for the owner). Read before the change, so a proposal replaced in between by
   * somebody else is judged as not this ferret's to replace.
   */
  private async leadsProposer(projectId: BoardProjectId, actor: LaneActor): Promise<(session: string) => boolean> {
    const proposer = actor.kind === 'ferret' ? (await this.store.read(projectId))?.pending?.proposerSession : undefined;
    if (proposer === undefined || this.parents === undefined) return () => false;
    const above = await ancestorsOf(proposer, this.parents);
    return session => session === proposer && actor.kind === 'ferret' && above.includes(actor.sessionId);
  }

  /**
   * Closes the agenda card of a waiting proposal that is gone — replaced, accepted in the editor, or dropped by a
   * change to the lanes — saying why, so the owner never answers a card that would do nothing. Total: a card that
   * cannot be closed stays open, and its Accept still confirms nothing.
   */
  private async withdrawGone(
    projectId: BoardProjectId,
    was: LaneSet['pending'],
    now: LaneSet,
    confirmed = false,
  ): Promise<void> {
    if (was?.proposerSession === undefined || now.pending?.version === was.version) return;
    const why =
      now.pending !== undefined
        ? LANE_CARD_WITHDRAWN.replaced
        : confirmed && now.version === was.version
          ? LANE_CARD_WITHDRAWN.accepted
          : LANE_CARD_WITHDRAWN.dropped;
    await this.agenda
      .withdraw(was.proposerSession, laneProposalReference(projectId, was.version), why)
      .catch(() => undefined);
  }
}

const OWNER = { kind: 'owner' } as const satisfies LaneActor & RelocationAuthority;

const authorityOf = (actor: LaneActor): RelocationAuthority =>
  actor.kind === 'owner' ? (actor.via === undefined ? OWNER : { kind: 'owner', via: actor.via }) : { kind: 'daemon' };

/** What a withdrawn proposal card says: why the proposal it named is gone. */
export const LANE_CARD_WITHDRAWN = {
  replaced: 'A newer proposal replaced this one; its own card is on the agenda.',
  accepted: 'Accepted in the Board lane editor.',
  dropped: 'The lanes changed since this was proposed (the owner edited them), so this proposal is gone.',
} as const;

const defaultLaneSet = (projectId: BoardProjectId): LaneSet | null =>
  projectId === UNFILED_PROJECT_ID ? unfiledLaneSet() : null;
