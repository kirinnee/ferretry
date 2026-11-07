/**
 * THE BOARD'S PROJECTS AND THEIR LANES. One place that answers "which projects have a board", "what are this
 * project's lanes" and "change them", over a store, the project registry and the asks it is handed.
 *
 * The Unfiled board is not a registered project: it is listed here, beside the registered ones, with the
 * `quick` lanes until the owner stores another set. Nothing in this class touches `/v1/projects`.
 */
import { err, ok, type Result } from '@ferretry/std';
import { type BoardProjectId, UNFILED_PROJECT_ID } from '../../../contract/index.ts';
import { laneChangeCard, laneProposalCard } from './lane-proposal-card.ts';
import {
  decideLaneChange,
  type LaneActor,
  type LaneSetDecision,
  type LaneSetProblem,
  unfiledLaneSet,
} from './lane-set-policy.ts';
import { ancestorsOf, type FerretParents } from './lineage.ts';
import { laneProposalReference, type LaneSet, type LaneSetActionRequest } from './model.ts';
import type {
  CardRelocator,
  LaneProposalAsks,
  LaneSetSource,
  LaneSetStore,
  ProjectRegistry,
  RelocationAuthority,
} from './ports.ts';
import type { FerretProjects } from './ferret-projects.ts';

export const UNFILED_PROJECT_NAME = 'Unfiled';

export type LaneSetFailure = LaneSetProblem | { readonly code: 'not-found'; readonly projectId: string };

/** What a lane-set change answers. `ask` says whether the owner was asked: `raised` is the one ask for the proposing ferret, `not-needed` is a confirmed set or an owner's own edit, and `failed` means the set is live but no ask was raised (the proposer should say so itself). */
export interface LaneSetChange {
  readonly laneSet: LaneSet;
  readonly ask: 'raised' | 'not-needed' | 'failed';
}

/** One board as the project list reads it: the Unfiled board first, then every registered project. */
export interface ProjectBoard {
  readonly id: BoardProjectId;
  readonly name: string;
  /** The registered folder; `null` for the Unfiled board. */
  readonly path: string | null;
  readonly laneSet: LaneSet | null;
}

export class LaneSetService implements LaneSetSource {
  constructor(
    private readonly store: LaneSetStore,
    private readonly registry: ProjectRegistry,
    private readonly ferrets: Pick<FerretProjects, 'projectOf'>,
    private readonly asks: LaneProposalAsks,
    private readonly relocator: CardRelocator,
    /** Who started whom, so a lead may replace its own ferret's waiting proposal. Absent, only that ferret may. */
    private readonly parents?: FerretParents,
  ) {}

  projectOf(ferretId: string): Promise<BoardProjectId> {
    return this.ferrets.projectOf(ferretId);
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
  async projects(): Promise<readonly ProjectBoard[]> {
    const registered = await this.registry.projects();
    const boards: ProjectBoard[] = [
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

  async project(projectId: BoardProjectId): Promise<ProjectBoard | undefined> {
    return (await this.projects()).find(board => board.id === projectId);
  }

  /**
   * Applies a propose, edit or confirm (`decideLaneChange`). A ferret's change to a project that has lanes waits
   * for the owner and moves nothing; any ferret result the owner has not confirmed puts one ask on the Agenda for that ferret.
   * Cards move only once a change is live, as whoever made it live: the owner's, or the checked daemon's.
   */
  async apply(
    projectId: BoardProjectId,
    request: LaneSetActionRequest,
    actor: LaneActor,
  ): Promise<Result<LaneSetChange, LaneSetFailure>> {
    const board = await this.project(projectId);
    if (board === undefined) return err({ code: 'not-found', projectId });
    const leads = await this.leadsProposer(projectId, actor);
    // A ferret's change never relocates: it waits, or it is a first proposal with no cards to move.
    const decided = await this.store.transact<
      Result<{ readonly decision: LaneSetDecision; readonly before: LaneSet | null }, LaneSetProblem>
    >(projectId, current => {
      const before = current ?? defaultLaneSet(projectId);
      const result = decideLaneChange(projectId, before, request, actor, leads);
      return result.ok ? { next: result.value.next, result: ok({ decision: result.value, before }) } : { result };
    });
    if (!decided.ok) return decided;
    const { decision, before } = decided.value;
    const laneSet = decision.next;
    await this.withdrawGone(projectId, before?.pending, laneSet, request.action === 'confirm');
    if (Object.keys(decision.relocate).length > 0) {
      await this.relocator.relocate(projectId, decision.relocate, authorityOf(actor));
    }
    if (actor.kind !== 'ferret') return ok({ laneSet, ask: 'not-needed' });
    const pending = decision.change === 'pending' ? laneSet.pending : undefined;
    if (pending === undefined && laneSet.confirmedBy !== null) return ok({ laneSet, ask: 'not-needed' });
    try {
      await this.asks.raise(
        actor.ferretId,
        laneProposalReference(projectId, pending?.version ?? laneSet.version),
        pending === undefined ? laneProposalCard(board.name, laneSet) : laneChangeCard(board.name, laneSet, pending),
      );
      return ok({ laneSet, ask: 'raised' });
    } catch {
      return ok({ laneSet, ask: 'failed' });
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
    // Answered through Asks: the ask is closed already, so there is nothing to withdraw.
    if (Object.keys(accepted.relocate).length > 0) await this.relocator.relocate(projectId, accepted.relocate, OWNER);
    return true;
  }

  /**
   * Whether a ferret leads the ferret that proposed the waiting proposal it would replace (`docs/board.md` § A
   * ferret's lane change waits for the owner). Read before the change, so a proposal replaced in between by
   * somebody else is judged as not this ferret's to replace.
   */
  private async leadsProposer(projectId: BoardProjectId, actor: LaneActor): Promise<(ferret: string) => boolean> {
    const proposer = actor.kind === 'ferret' ? (await this.store.read(projectId))?.pending?.proposerSession : undefined;
    if (proposer === undefined || this.parents === undefined) return () => false;
    const above = await ancestorsOf(proposer, this.parents);
    return ferret => ferret === proposer && actor.kind === 'ferret' && above.includes(actor.ferretId);
  }

  /**
   * Closes the ask of a waiting proposal that is gone — replaced, accepted in the editor, or dropped by a
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
        ? LANE_ASK_WITHDRAWN.replaced
        : confirmed && now.version === was.version
          ? LANE_ASK_WITHDRAWN.accepted
          : LANE_ASK_WITHDRAWN.dropped;
    await this.asks
      .withdraw(was.proposerSession, laneProposalReference(projectId, was.version), why)
      .catch(() => undefined);
  }
}

const OWNER = { kind: 'owner' } as const satisfies LaneActor & RelocationAuthority;

const authorityOf = (actor: LaneActor): RelocationAuthority =>
  actor.kind === 'owner' ? (actor.via === undefined ? OWNER : { kind: 'owner', via: actor.via }) : { kind: 'daemon' };

/** What a withdrawn proposal ask says: why the proposal it named is gone. */
export const LANE_ASK_WITHDRAWN = {
  replaced: 'A newer proposal replaced this one; its own ask is on the Agenda.',
  accepted: 'Accepted in the Board lane editor.',
  dropped: 'The lanes changed since this was proposed (the owner edited them), so this proposal is gone.',
} as const;

const defaultLaneSet = (projectId: BoardProjectId): LaneSet | null =>
  projectId === UNFILED_PROJECT_ID ? unfiledLaneSet() : null;
