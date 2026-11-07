/**
 * The board card a helper works on, as Packs asks Board for it. Board owns cards; Packs may not import its contract
 * (§2.4), so the shapes `fy new` needs are declared here and the daemon half wires a port onto them. The shapes are
 * today's `Delegation` / `DelegationOutcome` (the Board delegation), unchanged.
 */

/** A card reference: its id (`F12`). */
export interface TaskRef {
  readonly machineId?: string | undefined;
  readonly id: string;
}

export const TASK_REF_SIGIL = '&';
export const formatTaskRef = (ref: Pick<TaskRef, 'id'>): string => `${TASK_REF_SIGIL}${ref.id}`;

/** Where a delegated card's parent came from: the brief that names it, or the lead's explicit focus card. */
export type ParentFrom = 'brief' | 'focus';

/** Who holds a card now, as a start must still find them when it assigns it. */
export interface CardHolders {
  readonly owner: string | null;
  readonly assignee: string | null;
}

/** A `fy new`'s card, decided before the child exists so its brief can name it. */
export interface Delegation {
  readonly lead: string;
  /** The helper's brief as the lead wrote it, without the footer the daemon adds. */
  readonly brief: string;
  /** The child's card id: reserved for a new card, the lead's own for an existing one. */
  readonly id: string;
  /** The card already exists (`--card`, or the lead's open card with this title): it is assigned, not made. */
  readonly existing: boolean;
  /** The card the child's card sits under; `null` for a top-level card. */
  readonly parent: TaskRef | null;
  /** Why it sits there; absent for a top-level card and for an existing card, which keeps the parent it had. */
  readonly parentFrom?: ParentFrom;
  /** The board's name as the owner reads it; `undefined` when the child may run on another board. */
  readonly project?: string;
  readonly held?: CardHolders;
}

/** What delegating a card came to: the delegation, or why the start must not go on. */
export interface DelegationOutcome {
  readonly delegation?: Delegation;
  /** Set when `--card` named a card the lead may not hand over: the start is refused with this. */
  readonly refusal?: string;
  readonly notes: readonly string[];
}

/** What a `fy new` hands the board to decide its card from. */
export interface DelegationRequest {
  readonly brief: string;
  /** The name the child ferret is given, which titles a new card. */
  readonly name?: string | undefined;
  /** An existing card the child works on (`--card`). */
  readonly card?: string | undefined;
}

/** The lead's side of the helper's card: taken just before the first start that will run. */
export interface PackCardsPort {
  delegate(
    lead: string,
    request: DelegationRequest,
    inheritsCwd: boolean,
    cwd: string | undefined,
  ): Promise<DelegationOutcome>;
}

/** The line a helper's brief gains (`helperFooter`): its card and where it is. */
export const cardFooterLine = (
  id: string,
  project: string | undefined,
  bin: string,
  parent: TaskRef | null = null,
): string =>
  `Your card is ${formatTaskRef({ id })} on the ${project === undefined ? "project's" : project} board${parent === null ? '' : `, under ${formatTaskRef(parent)}`}; the daemon moves it for you (\`${bin} task note\` adds progress).`;
