import type { BoardActorVia, BoardProjectId, LaneSet } from '@ferretry/protocol';
import type { ProjectGitFacts } from './template-inference.ts';
import type { LaneProposalCard } from './lane-proposal-card.ts';

/**
 * What the board store (U2) asks of lanes. `projectOf` is the board a session works on, `unfiled` when it has
 * none; `laneSet` is a project's current lanes, or `null` while it has none, which makes a card refuse with
 * `no-lane-set`. Lane-set WRITES (propose, edit, confirm) are not on this port.
 */
export interface LaneSetSource {
  projectOf(sessionId: string): Promise<BoardProjectId>;
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
}

/** What a transaction on one project's stored lane set decided: the set to keep (or `undefined` to keep the stored one) and what it answers. */
export interface LaneSetMutation<T> {
  readonly next?: LaneSet;
  readonly result: T;
}

/** One document per project. A damaged document is refused, never overwritten: the store rejects instead. */
export interface LaneSetStore {
  read(projectId: BoardProjectId): Promise<LaneSet | null>;
  /** Reads, decides and writes under one lock per project, so two edits cannot both win the same version. */
  transact<T>(projectId: BoardProjectId, decide: (current: LaneSet | null) => LaneSetMutation<T>): Promise<T>;
}

/** Puts one proposal in front of the owner as a single agenda choice on the proposing session's board. */
export interface LaneProposalAgenda {
  raise(sessionId: string, reference: string, card: LaneProposalCard): Promise<void>;
}

/**
 * Whose a relocation is: the OWNER's (their own edit, or their Accept of a ferret's proposal), recorded as theirs
 * and free to close a card; or the DAEMON's (a boot migration), which never moves a card into a closed lane.
 */
export type RelocationAuthority =
  | { readonly kind: 'owner'; readonly via?: BoardActorVia }
  | { readonly kind: 'daemon' };

/**
 * Moves the cards of a deleted lane to the lane the edit named, in the board store (U2). Called after the
 * edited set is stored, with the new set already readable; it must be safe to repeat, because a failure here
 * leaves the set edited and the cards where they were. `by` is whose move it is, and what each card's history
 * records; `reason` is what that history says about it; absent, it says the lane was removed.
 */
export interface CardRelocator {
  relocate(
    projectId: BoardProjectId,
    moves: Readonly<Record<string, string>>,
    by: RelocationAuthority,
    reason?: string,
  ): Promise<void>;
}

/** Reads {@link ProjectGitFacts} for a folder. Never rejects: a folder it cannot read is a folder with no repository. */
export interface ProjectGitFactSource {
  inspect(path: string): Promise<ProjectGitFacts>;
}
