import type { BoardProjectId, BoardSwitch } from '../../../contract/index.ts';
import type { ProjectInfo, RegisterProjectRequest } from '@ferretry/plugin-projects/contract';
import type { LaneProposalCard } from './lane-proposal-card.ts';
import type { BoardActorVia, LaneSet } from './model.ts';
import type { ProjectGitFacts } from './template-inference.ts';

/**
 * What the board store asks of lanes. `projectOf` is the board a ferret works on, `unfiled` when it has none;
 * `laneSet` is a project's current lanes, or `null` while it has none, which makes a card refuse with `no-lane-set`.
 * Lane-set WRITES (propose, edit, confirm) are not on this port.
 */
export interface LaneSetSource {
  projectOf(ferretId: string): Promise<BoardProjectId>;
  laneSet(projectId: BoardProjectId): Promise<LaneSet | null>;
}

/** What a transaction on one project's stored lane set decided: the set to keep (or `undefined` to keep the stored one) and what it answers. */
export interface LaneSetMutation<T> {
  readonly next?: LaneSet;
  readonly result: T;
}

/** One lane set per project. A damaged document is refused, never overwritten: the store rejects instead. */
export interface LaneSetStore {
  read(projectId: BoardProjectId): Promise<LaneSet | null>;
  /** Reads, decides and writes under one lock per project, so two edits cannot both win the same version. */
  transact<T>(projectId: BoardProjectId, decide: (current: LaneSet | null) => LaneSetMutation<T>): Promise<T>;
}

/** The owner's switch per project. A board nobody switched is off. A damaged document is refused. */
export interface BoardSwitchStore {
  /** `null` when nobody has switched this board. */
  read(projectId: BoardProjectId): Promise<BoardSwitch | null>;
  /** Records the owner's switch, `at` the instant it was thrown, and answers what is stored. */
  set(projectId: BoardProjectId, on: boolean, at: string): Promise<BoardSwitch>;
}

/**
 * Puts one lane proposal in front of the owner as a single ask raised for the proposing ferret, and takes it away
 * again, saying why, once the proposal it names is gone: replaced, accepted elsewhere, or dropped. The Agenda shows
 * the ask; the answer comes back through Asks (`LaneProposalAcceptance`).
 */
export interface LaneProposalAsks {
  raise(ferretId: string, reference: string, card: LaneProposalCard): Promise<void>;
  withdraw(ferretId: string, reference: string, note: string): Promise<void>;
}

/**
 * Whose a relocation is: the OWNER's (their own edit, or their Accept of a ferret's proposal), recorded as theirs
 * and free to close a card; or the DAEMON's, which runs every check an owner-less move does (`relocationProblems`).
 */
export type RelocationAuthority =
  | { readonly kind: 'owner'; readonly via?: BoardActorVia }
  | { readonly kind: 'daemon' };

/**
 * Moves the cards of a deleted lane to the lane the edit named, in the card store. Called after the edited set is
 * stored, with the new set already readable; it must be safe to repeat, because a failure here leaves the set edited
 * and the cards where they were. `by` is whose move it is, and what each card's history records.
 */
export interface CardRelocator {
  relocate(projectId: BoardProjectId, moves: Readonly<Record<string, string>>, by: RelocationAuthority): Promise<void>;
}

/** Reads {@link ProjectGitFacts} for a folder. Never rejects: a folder it cannot read is a folder with no repository. */
export interface ProjectGitFactSource {
  inspect(path: string): Promise<ProjectGitFacts>;
}

/** The registered projects (Projects, when it is on; none when it is off, so only the Unfiled board exists). */
export interface ProjectRegistry {
  projects(): Promise<readonly ProjectInfo[]>;
}

/** Registers a folder, or answers with the project already registered for its path or its repository. Rejects when it cannot. */
export interface ProjectRegistrar {
  register(request: RegisterProjectRequest): Promise<ProjectInfo>;
}
