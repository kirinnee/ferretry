/**
 * WHO MAY WRITE WHAT on a card: ownership plus lineage (`board-design.md` §2.5).
 *
 * This replaces the `task-boards` grant ACL for the board. There are no roles to grant: a caller's
 * standing on a card follows from the card itself (its owner and assignee) and from the owner's lineage
 * (`config.parent`, walked up). Every decision here is a pure function of those facts.
 *
 * | Standing      | Who                                                    | May                                  |
 * |---------------|--------------------------------------------------------|--------------------------------------|
 * | `owner-human` | the owner: loopback, or a device the `fleet` grant let in | everything, incl. gates and overrides |
 * | `owner`       | the card's owner ferret                                | the assignee's writes, plus re-plan   |
 * | `ancestor`    | a ferret above the card's owner                        | the same as the owner                |
 * | `assignee`    | the ferret doing it (`assignee`, else the owner)       | move, note, link, block, files, …    |
 * | `daemon`      | the daemon's own automation                            | trigger moves, link cache, refile    |
 * | `reader`      | any other ferret                                       | read; depend from ITS OWN card only   |
 *
 * Re-plan means retitle, rewrite the brief, reassign, drop, reorder and re-parent (which also needs `adopt` on
 * the new parent: a card never moves onto a tree its caller cannot write).
 */
import { type BoardTask, formatTaskRef } from '@ferretry/protocol';

/** Who is asking. The route derives it from the server-side actor, never from the body. */
export type BoardCaller =
  | { readonly kind: 'owner' }
  | { readonly kind: 'ferret'; readonly sessionId: string }
  | { readonly kind: 'daemon'; readonly sessionId?: string };

export type BoardStanding = 'owner-human' | 'owner' | 'ancestor' | 'assignee' | 'daemon' | 'reader';

/** Everything a caller can ask of a card, as authority sees it. */
export type BoardOperation =
  | 'move'
  | 'focus'
  | 'block'
  | 'unblock'
  | 'depend'
  | 'undepend'
  | 'reopen'
  | 'clarify'
  | 'link'
  | 'note'
  | 'edit'
  | 'file'
  | 'refile'
  | 'drop'
  | 'assign'
  | 'order'
  | 'replan'
  | 'reparent'
  | 'adopt'
  | 'override'
  | 'pass-gate'
  | 'trigger';

const WORKERS: readonly BoardStanding[] = ['owner-human', 'owner', 'ancestor', 'assignee'];
const PLANNERS: readonly BoardStanding[] = ['owner-human', 'owner', 'ancestor'];
const HUMAN: readonly BoardStanding[] = ['owner-human'];

/**
 * The standings each operation admits. `replan` is a retitle or a brief rewrite inside an `edit`;
 * `adopt` is naming a card as the parent of a new one; `pass-gate` and `override` are the owner's.
 */
export const OPERATION_STANDINGS: Readonly<Record<BoardOperation, readonly BoardStanding[]>> = {
  move: WORKERS,
  focus: WORKERS,
  block: WORKERS,
  unblock: WORKERS,
  depend: WORKERS,
  undepend: WORKERS,
  reopen: WORKERS,
  clarify: WORKERS,
  link: [...WORKERS, 'daemon'],
  note: WORKERS,
  edit: WORKERS,
  file: WORKERS,
  refile: [...WORKERS, 'daemon'],
  drop: PLANNERS,
  assign: PLANNERS,
  order: PLANNERS,
  replan: PLANNERS,
  reparent: PLANNERS,
  adopt: WORKERS,
  override: HUMAN,
  'pass-gate': HUMAN,
  trigger: ['daemon'],
};

/** The ferret doing the card now: its assignee, which reads as the owner when unset. */
export const effectiveAssignee = (card: Pick<BoardTask, 'owner' | 'assignee'>): string => card.assignee ?? card.owner;

/**
 * A caller's standing on one card. `ownerAncestors` is the card owner's lineage, nearest first; only a
 * ferret that is neither the owner nor the assignee needs it, so a caller may pass `[]` otherwise.
 */
export const standingOf = (
  caller: BoardCaller,
  card: Pick<BoardTask, 'owner' | 'assignee'>,
  ownerAncestors: readonly string[],
): BoardStanding => {
  if (caller.kind === 'owner') return 'owner-human';
  if (caller.kind === 'daemon') return 'daemon';
  if (caller.sessionId === card.owner) return 'owner';
  if (ownerAncestors.includes(caller.sessionId)) return 'ancestor';
  if (caller.sessionId === effectiveAssignee(card)) return 'assignee';
  return 'reader';
};

/** Whether a standing admits an operation. */
export const mayDo = (operation: BoardOperation, standing: BoardStanding): boolean =>
  OPERATION_STANDINGS[operation].includes(standing);

const STANDING_WORDS: Readonly<Record<BoardStanding, string>> = {
  'owner-human': 'the owner',
  owner: 'its owner ferret',
  ancestor: "the owner ferret's leads",
  assignee: 'its assignee',
  daemon: 'the daemon',
  reader: 'any ferret',
};

const OPERATION_WORDS: Readonly<Record<BoardOperation, string>> = {
  move: 'move',
  focus: 'focus on',
  block: 'block',
  unblock: 'unblock',
  depend: 'add a dependency to',
  undepend: 'remove a dependency from',
  reopen: 'reopen',
  clarify: 'clarify',
  link: 'link to',
  note: 'note on',
  edit: 'edit',
  file: 'claim files on',
  refile: 'refile',
  drop: 'drop',
  assign: 'reassign',
  order: 'reorder',
  replan: 'retitle or rewrite the brief of',
  reparent: 'move under another card',
  adopt: 'add a child card under',
  override: 'override a dependency of',
  'pass-gate': 'pass the owner gate of',
  trigger: 'trigger a move of',
};

/**
 * The sentence a refusal answers with: what was refused and who may do it instead, naming the card's
 * own ferrets so the caller knows whom to ask.
 */
export const refusalMessage = (
  operation: BoardOperation,
  card: Pick<BoardTask, 'id' | 'owner' | 'assignee'>,
): string => {
  const who = OPERATION_STANDINGS[operation].map(standing => STANDING_WORDS[standing]);
  const ferrets =
    card.assignee === null || card.assignee === card.owner
      ? `owner ferret ${card.owner}`
      : `owner ferret ${card.owner}, assignee ${card.assignee}`;
  return `only ${who.join(', ')} may ${OPERATION_WORDS[operation]} ${formatTaskRef(card)} (${ferrets})`;
};
