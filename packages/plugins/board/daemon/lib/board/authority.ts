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
 * | `assignee`    | the ferret doing it (`assignee`, else the owner)       | move, note, link, report, files, …   |
 * | `assignee-lead` | a ferret above the card's assignee, not its owner    | drop and reassign, nothing else      |
 * | `daemon`      | the daemon's own automation                            | trigger moves, link cache, refile    |
 * | `reader`      | any other ferret                                       | read; depend from ITS OWN card only   |
 *
 * Re-plan means retitle, rewrite the brief, reassign, drop, reorder and re-parent (which also needs `adopt` on
 * the new parent: a card never moves onto a tree its caller cannot write).
 *
 * One exception inside re-plan: the card's ASSIGNEE may hand it down to a descendant of its own ({@link mayHandDown}),
 * so a lead given a card can start a helper on it without making a duplicate. Never sideways or upward.
 */
import { type Card, formatCardRef } from '../../../contract/index.ts';

/** Who is asking. The route derives it from the server-side actor, never from the body. */
export type BoardCaller =
  /**
   * The owner's authority. `via: 'admin-token'` is the host's admin token with no ferret's own credential
   * behind it — the owner at the machine, or a ferret that left its session out — so it is RECORDED as
   * that (`admin-token`), never as the owner, while it keeps the authority the token has always had.
   */
  | { readonly kind: 'owner'; readonly via?: 'admin-token' }
  | { readonly kind: 'ferret'; readonly ferret: string }
  | { readonly kind: 'daemon'; readonly ferret?: string };

export type BoardStanding = 'owner-human' | 'owner' | 'ancestor' | 'assignee-lead' | 'assignee' | 'daemon' | 'reader';

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
  | 'snooze'
  | 'replan'
  | 'reparent'
  | 'adopt'
  | 'override'
  | 'pass-gate'
  | 'trigger'
  | 'report';

const WORKERS: readonly BoardStanding[] = ['owner-human', 'owner', 'ancestor', 'assignee'];
const PLANNERS: readonly BoardStanding[] = ['owner-human', 'owner', 'ancestor'];
/** A lead may also drop or reassign a card its subtree was handed, whoever owns it: nothing else about the card. */
const SUBTREE_PLANNERS: readonly BoardStanding[] = [...PLANNERS, 'assignee-lead'];
const HUMAN: readonly BoardStanding[] = ['owner-human'];

/**
 * The standings each operation admits. `replan` is a retitle or a brief rewrite inside an `edit`;
 * `adopt` is naming a card as the parent of a new one; `pass-gate` and `override` are the owner's. `trigger`
 * is the daemon's move on what it observes; `report` is a card's own people telling it what it cannot see.
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
  note: [...WORKERS, 'daemon'],
  edit: WORKERS,
  file: WORKERS,
  refile: [...WORKERS, 'daemon'],
  drop: SUBTREE_PLANNERS,
  assign: SUBTREE_PLANNERS,
  order: PLANNERS,
  snooze: HUMAN,
  replan: PLANNERS,
  reparent: PLANNERS,
  adopt: WORKERS,
  override: HUMAN,
  'pass-gate': HUMAN,
  trigger: ['daemon'],
  report: WORKERS,
};

/** The ferret doing the card now: its assignee, which reads as the owner when unset. */
export const effectiveAssignee = (card: Pick<Card, 'owner' | 'assignee'>): string => card.assignee ?? card.owner;

/**
 * A caller's standing on one card. `ownerAncestors` is the card owner's lineage and `assigneeAncestors` the assignee's,
 * nearest first; only a ferret that is neither the owner nor the assignee needs them, so a caller may pass `[]`
 * otherwise. A lead above the OWNER is an `ancestor`: the owner lineage alone holds the card's gates and its plan. A
 * lead above only the ASSIGNEE is an `assignee-lead`: the card was handed to its subtree, so it may drop or reassign it,
 * and nothing more (never an owner ferret's gate, never a re-plan).
 */
export const standingOf = (
  caller: BoardCaller,
  card: Pick<Card, 'owner' | 'assignee'>,
  ownerAncestors: readonly string[],
  assigneeAncestors: readonly string[] = [],
): BoardStanding => {
  if (caller.kind === 'owner') return 'owner-human';
  if (caller.kind === 'daemon') return 'daemon';
  if (caller.ferret === card.owner) return 'owner';
  if (ownerAncestors.includes(caller.ferret)) return 'ancestor';
  if (caller.ferret === effectiveAssignee(card)) return 'assignee';
  if (assigneeAncestors.includes(caller.ferret)) return 'assignee-lead';
  return 'reader';
};

/**
 * Who a card's gates ask (docs/board.md § Cards show progress): an EXTERNAL card is one a person asked for, and its
 * gates are the owner's alone, asked as agenda items; an INTERNAL card is a ferret's own bookkeeping, and the owner
 * never sees it, so its owner ferret or a lead above that ferret passes its gates with an ordinary move.
 */
export type CardAudience = 'external' | 'internal';

/** The standings that pass an INTERNAL card's gate besides the owner: its owner ferret and that ferret's leads. */
const INTERNAL_GATE_KEEPERS: readonly BoardStanding[] = ['owner-human', 'owner', 'ancestor'];

/**
 * Whether a standing passes an owner gate (out of a gated lane, or into a gated closed lane) on a card of this
 * audience. The owner always; the owner ferret or an ancestor only on an internal card; an assignee, a helper,
 * a reader and the daemon never (the daemon's own moves are its triggers, which never enter a gated closed lane).
 */
export const mayPassGate = (standing: BoardStanding, audience: CardAudience): boolean =>
  audience === 'internal' ? INTERNAL_GATE_KEEPERS.includes(standing) : standing === 'owner-human';

/** Whether a standing admits an operation. */
export const mayDo = (operation: BoardOperation, standing: BoardStanding): boolean =>
  OPERATION_STANDINGS[operation].includes(standing);

/**
 * Whether an assignee may assign the card to `assignee`: only its own descendant. `assigneeAncestors` is the
 * target's lineage read from the daemon's session registry, never from the request.
 */
export const mayHandDown = (
  caller: BoardCaller,
  standing: BoardStanding,
  assignee: string | null,
  assigneeAncestors: readonly string[],
): boolean =>
  standing === 'assignee' &&
  caller.kind === 'ferret' &&
  assignee !== null &&
  assignee !== caller.ferret &&
  assigneeAncestors.includes(caller.ferret);

/**
 * The lead a ferret may CLAIM the card from: the reverse of {@link mayHandDown}. The card's current holder (its assignee,
 * else its owner) when that is one of the caller's own ancestors. `undefined` otherwise, and for the ferret that already
 * holds it: never sideways (a sibling's or cousin's card, even under a shared lead who owns it), never beyond the caller's
 * own lineage, and never a card the owner holds (the owner is not a ferret). `callerAncestors` is the caller's lineage
 * from the daemon's session registry, nearest first.
 */
export const claimableFrom = (
  caller: BoardCaller,
  card: Pick<Card, 'owner' | 'assignee'>,
  callerAncestors: readonly string[],
): string | undefined => {
  if (caller.kind !== 'ferret') return undefined;
  const holder = effectiveAssignee(card);
  return caller.ferret !== holder && callerAncestors.includes(holder) ? holder : undefined;
};

/** The sentence a refused claim answers with: who may claim, and what to do instead. */
export const claimRefusalMessage = (card: Pick<Card, 'id' | 'owner' | 'assignee'>, caller: BoardCaller): string => {
  const ref = formatCardRef(card);
  if (caller.kind !== 'ferret') return `claim is a ferret's: ${ref} is taken with \`fy card assign ${ref} <ferret>\``;
  if (caller.ferret === effectiveAssignee(card)) return `${ref} is already yours`;
  if (caller.ferret === card.owner) return `you own ${ref}: take it with \`fy card assign ${ref} ${caller.ferret}\``;
  return `only a ferret below the ferret holding ${ref} may claim it (held by ${effectiveAssignee(card)}); a card held by a ferret outside your lineage is theirs: ask your lead`;
};

const STANDING_WORDS: Readonly<Record<BoardStanding, string>> = {
  'owner-human': 'the owner',
  owner: 'its owner ferret',
  ancestor: "the owner ferret's leads",
  'assignee-lead': "the assignee's leads",
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
  snooze: 'snooze',
  replan: 'retitle or rewrite the brief of',
  reparent: 'move under another card',
  adopt: 'add a child card under',
  override: 'override a dependency of',
  'pass-gate': 'pass the owner gate of',
  trigger: 'trigger a move of',
  report: 'report an event on',
};

/**
 * The sentence a refusal answers with: what was refused and who may do it instead, naming the card's
 * own ferrets so the caller knows whom to ask.
 */
export const refusalMessage = (operation: BoardOperation, card: Pick<Card, 'id' | 'owner' | 'assignee'>): string => {
  const who = OPERATION_STANDINGS[operation].map(standing => STANDING_WORDS[standing]);
  const ferrets =
    card.assignee === null || card.assignee === card.owner
      ? `owner ferret ${card.owner}`
      : `owner ferret ${card.owner}, assignee ${card.assignee}`;
  return `only ${who.join(', ')} may ${OPERATION_WORDS[operation]} ${formatCardRef(card)} (${ferrets})`;
};
