/**
 * THE CARD RULES: what each request does to one card, as pure functions of the card, the request and the
 * facts the service gathered first (lanes, the board graph, the caller's standing).
 *
 * Every rule that refuses throws a {@link BoardError} whose message says what to do instead. The rules
 * that matter most, from `board-design.md`:
 *
 * - **Authority** (§2.5) is checked first, by {@link requireStanding}.
 * - **A move back needs a reason**, and **a move back by the owner is a reopen** (§2.9): one write records
 *   the `reopened` event and appends the owner's words to the clarifications, and the service then
 *   delivers it to the card's ferret.
 * - **Gates** (§2.3): only the owner passes an owner-gated lane (`needsOwner`), so only the owner closes.
 * - **Files ride a reopen only**: an owner's move back may carry the files the owner attached ("Not good"),
 *   which the service resolved first; the `reopened` event names them and the delivery carries them on.
 * - **Dependencies** (§2.7): a card with unfinished blockers cannot move to a later CATEGORY; only the
 *   owner overrides a dependency, and the override is recorded. Cycles are refused.
 */
import {
  type CardActor,
  cardRevision,
  type BoardAttachment,
  type BoardClarification,
  type BoardEditableField,
  type Progress,
  BoardEditableFieldSchema,
  type CardVisibility,
  type BoardProjectId,
  type Card,
  type CardActionRequest,
  type CardCreateRequest,
  type CardEvent,
  type CardId,
  categoryOf,
  firstLaneOfCategory,
  formatCardRef,
  gateOptions,
  isBackwardMove,
  LANE_CATEGORIES,
  type Lane,
  type LaneSet,
  type LaneTrigger,
  laneForTrigger,
  laneOf,
  laneStage,
  moveReasonProblem,
  needsOwner,
  type PrLink,
  prUrlParts,
  type BoardReopenAttachments,
  type CardRef,
  variantLanes,
} from '../../../contract/index.ts';
import {
  type BoardCaller,
  type BoardOperation,
  type BoardStanding,
  type CardAudience,
  claimRefusalMessage,
  effectiveAssignee,
  mayDo,
  mayPassGate,
  OPERATION_STANDINGS,
  refusalMessage,
} from './authority.ts';
import { queueBehindClashes } from './clash-queue.ts';
import { BoardError } from './errors.ts';
import { type BoardIndex, blockedBy, dependencyCycle, type LaneSets, parentLoop } from './graph.ts';
import { laneFromFacts } from './lane-facts.ts';
import { closedLaneOf, shippedCloseReason, SUB_CARD_SHIPPED_REASON } from './sub-card-close.ts';
import { cardVisibility, visibilityChosen, visibilityVerdict, withDefaultVisibility } from './visibility.ts';

/** The facts every rule may consult, gathered by the service before it calls one. */
export interface CardContext {
  readonly now: string;
  /** Who acts, as the card records them: an owner on the admin token says so in its `via`. */
  readonly actor: CardActor;
  readonly standing: BoardStanding;
  /** True when the caller is the card's assignee and the new assignee is its own descendant (`mayHandDown`). */
  readonly handsDown?: boolean;
  /** The lead of the caller's own that holds the card, when the caller may CLAIM it (`claimableFrom`). */
  readonly claimedFrom?: string;
  /** The ended owner ferret a live lead may ADOPT the card from (the service judged the orphan: `BoardService.orphanedOwner`). */
  readonly adoptedFrom?: string;
  /** The lanes of the card's own board. */
  readonly laneSet: LaneSet;
  readonly index: BoardIndex;
  readonly laneSets: LaneSets;
  /** The version this daemon runs, for `release.running`; absent or `null` when it is not known. */
  readonly runningVersion?: string | null;
  /**
   * Who the card's gates ask (`CardAudience`): an internal card's owner ferret and leads pass its gates themselves.
   * Absent reads as `external`, the strict reading: only the owner passes a gate.
   */
  readonly audience?: CardAudience;
  /**
   * The files the request carries, as the service found them in the attachment store; absent when it carries
   * none. Only a reopen takes them.
   */
  readonly attachments?: {
    readonly request: BoardReopenAttachments;
    readonly files: readonly BoardAttachment[];
  };
}

/** What a rule decided. `task: null` changes nothing on the card. */
export interface CardOutcome {
  readonly task: Card | null;
  /** Set when the card was sent back with someone's words: the service delivers it to its ferret. */
  readonly reopened?: {
    readonly from: string;
    readonly to: string;
    readonly reason: string;
    /** The files to carry to the ferret with it. */
    readonly attachments?: BoardReopenAttachments;
  };
}

/** The source recorded with an owner's words when they arrived as a move on the board. */
export const OWNER_MOVE_SOURCE = 'owner (board move)';

type NewEvent = CardEvent extends infer E ? (E extends CardEvent ? Omit<E, 'seq' | 'at' | 'actor'> : never) : never;

/** The card with one more history event: next seq, this instant, this actor. */
export const withEvent = (card: Card, event: NewEvent, context: Pick<CardContext, 'now' | 'actor'>): Card => ({
  ...card,
  history: [
    ...card.history,
    { ...event, seq: card.history.length + 1, at: context.now, actor: context.actor } as CardEvent,
  ],
});

export const requireStanding = (
  operation: BoardOperation,
  standing: BoardStanding,
  card: Pick<Card, 'id' | 'owner' | 'assignee'>,
): void => {
  if (!mayDo(operation, standing)) {
    throw new BoardError('forbidden', refusalMessage(operation, card), OPERATION_STANDINGS[operation]);
  }
};

/** The refusal for a reassign: an assignee is told the one reassign it has, handing the card down. */
const requireAssign = (standing: BoardStanding, card: Pick<Card, 'id' | 'owner' | 'assignee'>): void => {
  if (mayDo('assign', standing)) return;
  const message =
    standing === 'assignee'
      ? `${refusalMessage('assign', card)}; its assignee may only hand it down to one of its own helpers`
      : refusalMessage('assign', card);
  throw new BoardError('forbidden', message, OPERATION_STANDINGS.assign);
};

const laneNames = (laneSet: LaneSet): string => laneSet.lanes.map(lane => lane.id).join(', ');

/** A lane of this board, or the refusal that lists the lanes it has. */
const requireLane = (laneSet: LaneSet, laneId: string): Lane => {
  const lane = laneOf(laneSet, laneId);
  if (!lane.ok) {
    throw new BoardError(
      'unknown-lane',
      `there is no lane "${laneId}" on this board; its lanes are ${laneNames(laneSet)}`,
    );
  }
  return lane.value;
};

const rank = (laneSet: LaneSet, laneId: string): number => {
  const category = categoryOf(laneSet, laneId);
  return category.ok ? LANE_CATEGORIES.indexOf(category.value) : -1;
};

const isBackward = (laneSet: LaneSet, from: string, to: string): boolean => {
  const backward = isBackwardMove(laneSet, from, to);
  return backward.ok && backward.value;
};

const requireOpen = (card: Card, doing: string): void => {
  if (card.dropped !== null) {
    throw new BoardError('invalid', `${formatCardRef(card)} is dropped; reopen it before you ${doing} it`);
  }
};

/**
 * Only the owner enters an owner-gated closed lane — or, on an internal card moved, its owner ferret or a lead
 * (`mayPassGate`): the refusal for anyone else.
 */
const requireOwnerForClosed = (
  lane: Lane,
  standing: BoardStanding,
  card: Pick<Card, 'id'>,
  audience: CardAudience = 'external',
): void => {
  if (lane.category === 'closed' && lane.ownerGate === true && !mayPassGate(standing, audience)) {
    throw new BoardError(
      'owner-gate',
      `only the owner closes a card; move ${formatCardRef(card)} to the lane before ${lane.name} and the owner closes it`,
      ['owner-human'],
    );
  }
};

// ---------------------------------------------------------------------------------------------------
// Gates: the one stopping point (docs/board.md § Cards show progress)
// ---------------------------------------------------------------------------------------------------

const isGate = (lane: Lane): boolean => laneStage(lane).kind === 'gate';

/**
 * The gate lanes the card's variant walks strictly between its lane and `target`, in order. Entering a gate is not
 * passing it, so `target` never counts; a move back passes none.
 */
export const gatesBetween = (laneSet: LaneSet, card: Pick<Card, 'laneId' | 'workflow'>, target: Lane): Lane[] => {
  const at = (id: string): number => laneSet.lanes.findIndex(lane => lane.id === id);
  // A variant naming a lane the set lacks cannot say what is walked, so every lane is.
  const walked = variantLanes(laneSet, card.workflow);
  return (walked.ok ? walked.value : laneSet.lanes).filter(
    lane => at(lane.id) > at(card.laneId) && at(lane.id) < at(target.id) && isGate(lane),
  );
};

// ---------------------------------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------------------------------

const move = (card: Card, to: string, reason: string | undefined, context: CardContext): CardOutcome => {
  requireStanding('move', context.standing, card);
  requireOpen(card, 'move');
  const ref = formatCardRef(card);
  if (to === card.laneId) throw new BoardError('invalid', `${ref} is already in ${to}`);
  const target = requireLane(context.laneSet, to);
  const from = requireLane(context.laneSet, card.laneId);
  if (!moveReasonProblem(context.laneSet, card.laneId, to, reason).ok) {
    throw new BoardError('reason-required', `moving ${ref} back from ${from.name} to ${target.name} needs a reason`);
  }
  const gated = needsOwner(context.laneSet, card.laneId, to);
  const audience = context.audience ?? 'external';
  const forward = !isBackward(context.laneSet, card.laneId, to);
  // Leaving a gate is `needsOwner`'s; a gate on the way is passed too, and entering one is fine.
  const passed = forward ? gatesBetween(context.laneSet, card, target)[0] : undefined;
  if (((gated.ok && gated.value) || passed !== undefined) && !mayPassGate(context.standing, audience)) {
    requireOwnerForClosed(target, context.standing, card, audience);
    const gate = passed ?? from;
    const where = gate.id === from.id ? `on from ${from.name}` : `past ${gate.name}`;
    throw new BoardError(
      'owner-gate',
      audience === 'internal'
        ? `only its owner ferret or a lead above it moves ${ref} ${where}`
        : `only the owner moves ${ref} ${where}: the daemon asks them in the Inbox, so raise no ask for it`,
      audience === 'internal' ? ['owner-human', 'owner', 'ancestor'] : ['owner-human'],
    );
  }
  if (rank(context.laneSet, to) > rank(context.laneSet, card.laneId)) {
    const blockers = blockedBy(card, context.index, context.laneSets);
    if (blockers.length > 0) {
      throw new BoardError(
        'blocked-by',
        `${ref} is blocked by ${blockers.map(formatCardRef).join(', ')}: it can move sideways or back, but not on to ${target.name} until they ship (only the owner may override a dependency)`,
      );
    }
  }
  const backward = isBackwardMove(context.laneSet, card.laneId, to);
  const isBack = backward.ok && backward.value;
  if (isBack && context.standing === 'owner-human') {
    return reopenTo(card, to, reason ?? '', { text: reason ?? '', source: OWNER_MOVE_SOURCE }, context);
  }
  if (context.attachments !== undefined) {
    throw new BoardError('invalid', `files ride only the owner's move back; ${ref} is not being sent back`);
  }
  return {
    task: {
      ...withEvent(card, { type: 'moved', from: card.laneId, to, backward: isBack, reason: reason ?? null }, context),
      laneId: to,
    },
  };
};

/** The reopen itself: the owner's words become a clarification, then the card goes to `to` (§2.9). */
const reopenTo = (
  card: Card,
  to: string,
  reason: string,
  ask: { readonly text: string; readonly source: string },
  context: CardContext,
): CardOutcome => {
  const clarification: BoardClarification = {
    text: ask.text,
    source: ask.source,
    at: context.now,
    by: context.actor,
  };
  const files = context.attachments;
  const reopened = withEvent(
    card,
    {
      type: 'reopened',
      from: card.laneId,
      to,
      reason,
      ask,
      ...(files === undefined ? {} : { attachments: [...files.files] }),
    },
    context,
  );
  return {
    task: { ...reopened, laneId: to, dropped: null, clarifications: [...card.clarifications, clarification] },
    reopened: { from: card.laneId, to, reason, ...(files === undefined ? {} : { attachments: files.request }) },
  };
};

const reopen = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'reopen' }>,
  context: CardContext,
): CardOutcome => {
  requireStanding('reopen', context.standing, card);
  const ref = formatCardRef(card);
  const target = requireLane(context.laneSet, action.to);
  if (target.category === 'closed') {
    throw new BoardError('invalid', `a reopen opens a card; to close ${ref}, move it to ${target.name}`);
  }
  if (card.dropped === null) {
    const backward = isBackwardMove(context.laneSet, card.laneId, action.to);
    if (!(backward.ok && backward.value)) {
      throw new BoardError(
        'invalid',
        `a reopen goes back to an earlier lane; ${ref} is in ${card.laneId}, so move it on instead`,
      );
    }
  } else if (
    action.to !== card.laneId &&
    !isBackward(context.laneSet, card.laneId, action.to) &&
    !mayPassGate(context.standing, context.audience ?? 'external')
  ) {
    // A dropped card comes back where it was dropped, or earlier: a drop is no way past a gate.
    const from = requireLane(context.laneSet, card.laneId);
    throw new BoardError(
      'owner-gate',
      `only the owner reopens ${ref} past ${from.name}, where it was dropped; reopen it there or earlier`,
      ['owner-human'],
    );
  }
  return reopenTo(card, action.to, action.reason, action.ask, context);
};

/**
 * A daemon move on a real signal (§3.1): into the lane the trigger names for the card's workflow. It
 * never goes backwards (unless `backward` says the facts pulled the card back, see {@link laneFromFacts})
 * and never moves a dropped card, and it is NOT stopped by dependencies, because
 * reality wins over the rule; the history says what it was blocked by. `null` when nothing moves.
 *
 * IT NEVER PASSES A GATE (docs/board.md § Cards show progress): a card waiting at one stays there, whatever the
 * signal, and a move that would pass one on the way stops in it. Only the owner's own report (`passGates`) goes on.
 */
export const triggerMove = (
  card: Card,
  trigger: LaneTrigger,
  reason: string | undefined,
  context: CardContext,
  backward = false,
  passGates = false,
): Card | null => {
  requireStanding('trigger', context.standing, card);
  if (card.dropped !== null) return null;
  const lane = laneForTrigger(context.laneSet, card.workflow, trigger);
  if (!lane.ok || lane.value === null || lane.value.id === card.laneId) return null;
  if (lane.value.category === 'closed' && lane.value.ownerGate === true) return null;
  const movesBack = isBackwardMove(context.laneSet, card.laneId, lane.value.id);
  if (!movesBack.ok || movesBack.value !== backward) return null;
  if (!passGates && isGate(requireLane(context.laneSet, card.laneId))) return null;
  const stop = passGates ? undefined : gatesBetween(context.laneSet, card, lane.value)[0];
  const to = stop ?? lane.value;
  const blockers = backward ? [] : blockedBy(card, context.index, context.laneSets);
  const note = blockers.length === 0 ? null : `${trigger} while blocked by ${blockers.map(formatCardRef).join(', ')}`;
  const held = stop === undefined ? null : `stopped at ${stop.name}, which waits for the owner`;
  const said = [reason, note, held].filter(part => part !== undefined && part !== null).join('; ');
  return {
    ...withEvent(
      card,
      {
        type: 'moved',
        from: card.laneId,
        to: to.id,
        backward,
        reason: said === '' ? null : said,
        auto: true,
        trigger,
      },
      context,
    ),
    laneId: to.id,
  };
};

/**
 * The first gate a move from the card's lane to `target` would pass: the card's own lane, else a lane of its
 * variant strictly between the two (`laneStage`, so a stored or a derived gate). Entering a gate is not passing
 * it, so `target` itself never counts, nor does a gate the card's variant skips. `undefined` when it passes
 * none, a backward target included. Throws `unknown-lane` for a card in a lane the set lacks.
 */
export const gateOnTheWay = (
  laneSet: LaneSet,
  card: Pick<Card, 'laneId' | 'workflow'>,
  target: Lane,
): Lane | undefined => {
  const from = requireLane(laneSet, card.laneId);
  return isGate(from) ? from : gatesBetween(laneSet, card, target)[0];
};

/**
 * An external trigger somebody reported (the task action `trigger`): something Ferretry cannot see happened —
 * a deploy finished, a reviewer approved — so the card moves the way that trigger moves it. The move is the
 * daemon's, through {@link triggerMove}, so it is recorded `auto` with the trigger and `reportedBy` names
 * the caller. Never backward and never into an owner-gated closed lane; the report of a non-owner never closes a
 * card at all (a fact may close a set with no verify lane; a caller's word may not), never moves a blocked card on
 * to a later category (as a move does not), and never passes a gate the owner has not answered: neither the card's own lane nor one its variant walks on the way
 * ({@link gateOnTheWay}). Already there, or past it, is no change.
 */
const report = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'trigger' }>,
  context: CardContext,
): CardOutcome => {
  requireStanding('report', context.standing, card);
  requireOpen(card, 'report an event on');
  const ref = formatCardRef(card);
  const found = laneForTrigger(context.laneSet, card.workflow, action.event);
  if (!found.ok || found.value === null) {
    throw new BoardError(
      'invalid',
      `no lane of this board enters on ${action.event} for ${card.workflow} work, so it does not move ${ref}; its lanes are ${laneNames(context.laneSet)}`,
    );
  }
  const target = found.value;
  if (target.id === card.laneId) return { task: null };
  // Only the owner closes on a report: a fact may close a set with no verify lane, a caller's word may not.
  if (target.category === 'closed' && (target.ownerGate === true || context.standing !== 'owner-human')) {
    throw new BoardError(
      'owner-gate',
      target.ownerGate === true
        ? `${action.event} would close ${ref} in ${target.name}, which only the owner's own move enters`
        : `${action.event} would close ${ref} in ${target.name}, and only the owner closes a card on a report`,
      ['owner-human'],
    );
  }
  const from = requireLane(context.laneSet, card.laneId);
  const back = isBackwardMove(context.laneSet, card.laneId, target.id);
  if (!back.ok || back.value) return { task: null };
  const gate = context.standing === 'owner-human' ? undefined : gateOnTheWay(context.laneSet, card, target);
  if (gate !== undefined) {
    throw new BoardError(
      'owner-gate',
      gate.id === from.id
        ? `${ref} waits in ${from.name} for the owner; a report does not pass that gate, the owner's answer does`
        : `${ref} would pass ${gate.name}, which waits for the owner; a report does not pass that gate, the owner's answer does`,
      ['owner-human'],
    );
  }
  // A dependency holds a caller's word as it holds a move: only a fact, or the owner, moves a blocked card on.
  const blockers =
    context.standing !== 'owner-human' && rank(context.laneSet, target.id) > rank(context.laneSet, card.laneId)
      ? blockedBy(card, context.index, context.laneSets)
      : [];
  if (blockers.length > 0) {
    throw new BoardError(
      'blocked-by',
      `${ref} is blocked by ${blockers.map(formatCardRef).join(', ')}: a report does not move it on to ${target.name} until they ship (only the owner may override a dependency)`,
    );
  }
  const moved = triggerMove(
    card,
    action.event,
    action.reason,
    { ...context, actor: { kind: 'daemon' }, standing: 'daemon' },
    false,
    context.standing === 'owner-human',
  );
  // Never null by now: every case triggerMove declines was answered above.
  return { task: moved === null ? null : reportedBy(moved, context) };
};

/** The move just made, with who reported the trigger beside the daemon that made it. */
const reportedBy = (moved: Card, context: Pick<CardContext, 'actor'>): Card => ({
  ...moved,
  history: moved.history.map((event, index) =>
    index === moved.history.length - 1 && event.type === 'moved' ? { ...event, reportedBy: context.actor } : event,
  ),
});

/**
 * Catches a card up to its own PR facts ({@link laneFromFacts}): the daemon's automatic move, recorded with the
 * trigger and the fact that moved it. It stops at a gate like every daemon move ({@link triggerMove}): facts move a
 * card into one, never out of or past it — not on, and not back for an open PR. `null` when the facts
 * put the card where it already is, or have no opinion. Whoever asked for the write, the move is the
 * daemon's: a card the facts moved was moved by no one.
 */
export const reconcileFacts = (card: Card, context: CardContext): Card | null => {
  const move = laneFromFacts(card, context.laneSet, card.workflow, {
    prs: card.links.prs,
    runningVersion: context.runningVersion ?? null,
  });
  const moved =
    move === null
      ? null
      : triggerMove(
          card,
          move.trigger,
          move.reason,
          { ...context, actor: { kind: 'daemon' }, standing: 'daemon' },
          move.backward,
        );
  // A sub-card that ships does not wait for the owner to try it: its parent carries the test.
  const reason = shippedCloseReason(moved ?? card, context.laneSet);
  return reason === null ? moved : (closeAsDaemon(moved ?? card, reason, context) ?? moved);
};

/** What a close is recorded as: the release or merge that shipped a sub-card, else the helper's own done. */
const closeTrigger = (card: Card, reason: string): LaneTrigger =>
  reason !== SUB_CARD_SHIPPED_REASON
    ? 'signal.done'
    : card.links.prs.some(pr => pr.releasedIn !== null)
      ? 'release.published'
      : 'pr.merged';

/**
 * The daemon's automatic move of a card into the board's closed lane, with the reason beside it. It is for a sub-card
 * that shipped or whose helper finished ({@link sub-card-close}); the owner's own Done is a verdict, not this.
 */
export const closeAsDaemon = (card: Card, reason: string, context: CardContext): Card | null => {
  const target = closedLaneOf(context.laneSet);
  if (target === undefined || target.id === card.laneId) return null;
  return {
    ...withEvent(
      card,
      {
        type: 'moved',
        from: card.laneId,
        to: target.id,
        backward: false,
        reason,
        auto: true,
        trigger: closeTrigger(card, reason),
      },
      { ...context, actor: { kind: 'daemon' } },
    ),
    laneId: target.id,
  };
};

/**
 * THE ONE PLACE THE DAEMON PASSES A GATE (docs/board.md § Cards show progress; their asks ride the agenda). A card at a
 * TRY-IT lane with nothing to try is moved by the daemon into the board's closed lane, reason beside it, so nobody is
 * asked to tap Done on it. Only the daemon (the `trigger` standing), only out of a lane whose gate has a reopen option
 * (a try-it), only into the closed lane. Everything else about a gate stays the owner's: a ferret's move past one is
 * still refused by `move`, and nothing on the wire reaches this. `null` when the card is not at such a gate, is
 * dropped, or the board has no closed lane: nothing is written.
 */
export const closeNothingToTry = (card: Card, reason: string, context: CardContext): Card | null => {
  requireStanding('trigger', context.standing, card);
  if (card.dropped !== null) return null;
  const from = laneOf(context.laneSet, card.laneId);
  if (!from.ok || !gateOptions(from.value).some(option => option.outcome.kind === 'reopen-with-ask')) return null;
  const target = closedLaneOf(context.laneSet);
  if (target === undefined || target.id === card.laneId) return null;
  return {
    ...withEvent(
      card,
      { type: 'moved', from: card.laneId, to: target.id, backward: false, reason, auto: true, trigger: 'signal.done' },
      { ...context, actor: { kind: 'daemon' } },
    ),
    laneId: target.id,
  };
};

// ---------------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------------

/** A dependency target on this machine, or the refusal that says why it cannot be one. */
export const requireLocalCard = (index: BoardIndex, ref: CardRef, role: string): Card => {
  if (!index.isLocal(ref)) {
    throw new BoardError(
      'invalid',
      `${formatCardRef(ref)} is on another machine; a ${role} must be a card on this machine for now`,
    );
  }
  const found = index.get(ref);
  if (found === undefined) throw new BoardError('not-found', `there is no card ${formatCardRef(ref)} on this machine`);
  return found;
};

const sameRef = (left: CardRef, right: CardRef): boolean => left.id === right.id;

const depend = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'depend' }>,
  context: CardContext,
): CardOutcome => {
  requireStanding('depend', context.standing, card);
  if (action.override !== undefined) requireStanding('override', context.standing, card);
  const ref = formatCardRef(card);
  const blocker = requireLocalCard(context.index, action.task, 'dependency');
  if (blocker.id === card.id) throw new BoardError('invalid', `${ref} cannot depend on itself`);
  const override =
    action.override === undefined
      ? undefined
      : { by: 'owner' as const, reason: action.override.reason, at: context.now };
  const task = { id: blocker.id };
  const existing = card.dependsOn.find(dependency => sameRef(dependency.task, task));
  if (existing !== undefined && override === undefined && existing.until === action.until) {
    throw new BoardError('invalid', `${ref} already depends on ${formatCardRef(task)}`);
  }
  if (existing === undefined) {
    const cycle = dependencyCycle(context.index, card.id, task);
    if (cycle !== null) throw new BoardError('cycle', `that dependency would close a cycle: ${cycle}`);
  }
  const kept = override ?? existing?.override;
  const entry = { task, until: action.until, ...(kept === undefined ? {} : { override: kept }) };
  const dependsOn =
    existing === undefined
      ? [...card.dependsOn, entry]
      : card.dependsOn.map(dependency => (sameRef(dependency.task, task) ? entry : dependency));
  return {
    task: {
      ...withEvent(
        card,
        { type: 'depended', task, until: action.until, ...(override === undefined ? {} : { override }) },
        context,
      ),
      dependsOn,
    },
  };
};

const undepend = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'undepend' }>,
  context: CardContext,
): CardOutcome => {
  requireStanding('undepend', context.standing, card);
  if (!card.dependsOn.some(dependency => sameRef(dependency.task, action.task))) {
    throw new BoardError('invalid', `${formatCardRef(card)} does not depend on ${formatCardRef(action.task)}`);
  }
  return {
    task: {
      ...withEvent(card, { type: 'undepended', task: action.task, reason: action.reason }, context),
      dependsOn: card.dependsOn.filter(dependency => !sameRef(dependency.task, action.task)),
    },
  };
};

// ---------------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------------

/** What another card already caches of the same PR (the freshest look), under this link's own spelling. */
const cachedElsewhere = (url: string, index: BoardIndex): PrLink | null => {
  const parts = prUrlParts(url);
  if (parts === null) return null;
  let freshest: PrLink | null = null;
  for (const other of index.cards) {
    for (const pr of other.links.prs) {
      if (pr.state === 'unknown' || pr.polledAt === null) continue;
      if (pr.number !== parts.number || pr.repo.toLowerCase() !== parts.repo.toLowerCase()) continue;
      if (freshest === null || (freshest.polledAt ?? '') < pr.polledAt) freshest = pr;
    }
  }
  return freshest === null ? null : { ...freshest, url, repo: parts.repo };
};

/** A newly linked PR: what another card already caches of it, else the URL and nothing GitHub has said yet. */
const unpolledPr = (url: string, index: BoardIndex): PrLink => {
  const parts = prUrlParts(url);
  if (parts === null) throw new BoardError('invalid', `${url} is not a GitHub pull request URL`);
  const cached = cachedElsewhere(url, index);
  if (cached !== null) return cached;
  return {
    url,
    number: parts.number,
    repo: parts.repo,
    state: 'unknown',
    draft: false,
    checks: 'none',
    mergedAt: null,
    mergeSha: null,
    releasedIn: null,
    polledAt: null,
  };
};

const link = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'link' }>,
  context: CardContext,
): CardOutcome => {
  requireStanding('link', context.standing, card);
  const ref = formatCardRef(card);
  const already = (value: string): never => {
    throw new BoardError('invalid', `${ref} already links ${value}`);
  };
  const { links } = card;
  if (action.pr !== undefined) {
    if (links.prs.some(pr => pr.url === action.pr)) already(action.pr);
    const linked: Card = {
      ...withEvent(card, { type: 'linked', field: 'pr', value: action.pr }, context),
      links: { ...links, prs: [...links.prs, unpolledPr(action.pr, context.index)] },
    };
    return { task: reconcileFacts(linked, context) ?? linked };
  }
  if (action.branch !== undefined) {
    if (links.branch === action.branch) already(action.branch);
    return {
      task: {
        ...withEvent(card, { type: 'linked', field: 'branch', value: action.branch }, context),
        links: { ...links, branch: action.branch },
      },
    };
  }
  if (action.commit !== undefined) {
    if (links.commits.includes(action.commit)) already(action.commit);
    return {
      task: {
        ...withEvent(card, { type: 'linked', field: 'commit', value: action.commit }, context),
        links: { ...links, commits: [...links.commits, action.commit] },
      },
    };
  }
  const doc = action.doc as string;
  if (links.docs.includes(doc)) already(doc);
  return {
    task: {
      ...withEvent(card, { type: 'linked', field: 'doc', value: doc }, context),
      links: { ...links, docs: [...links.docs, doc] },
    },
  };
};

// ---------------------------------------------------------------------------------------------------
// Re-plan and the rest
// ---------------------------------------------------------------------------------------------------

/** The fields only the owner side may rewrite: they change what the work IS. */
const PLAN_FIELDS: readonly BoardEditableField[] = ['title', 'brief'];

/** A card's status with the parts an edit names replaced, inside the card's own write (docs/board.md § The card's Status). */
const mergedProgress = (card: Card, parts: Partial<Progress> | undefined): Progress | undefined =>
  parts === undefined
    ? undefined
    : {
        now: parts.now ?? card.progress?.now ?? '',
        doneSoFar: parts.doneSoFar ?? card.progress?.doneSoFar ?? '',
        next: parts.next ?? card.progress?.next ?? '',
      };

const edit = (
  card: Card,
  request: Extract<CardActionRequest, { action: 'edit' }>,
  context: CardContext,
): CardOutcome => {
  requireStanding('edit', context.standing, card);
  const action = { ...request, progress: mergedProgress(card, request.progress) };
  // READ BEFORE WRITE (`fy card patch`): the writer read the card at `revision`; a change since would be overwritten unseen.
  if (action.revision !== undefined && cardRevision(card) !== action.revision) {
    throw new BoardError(
      'version-conflict',
      `${formatCardRef(card)} changed since you read it: read it again (card show ${card.id} --yaml), update every part that is out of date, and patch it back`,
    );
  }
  const changed = BoardEditableFieldSchema.options.filter(
    field => action[field] !== undefined && JSON.stringify(action[field]) !== JSON.stringify(card[field]),
  );
  if (changed.some(field => PLAN_FIELDS.includes(field))) requireStanding('replan', context.standing, card);
  const visibility =
    action.visibility === undefined || alreadyChosen(card, action.visibility) ? undefined : action.visibility;
  if (changed.length === 0 && visibility === undefined) {
    throw new BoardError('invalid', `that edit changes nothing on ${formatCardRef(card)}`);
  }
  let next = card;
  for (const field of changed)
    next = { ...withEvent(next, { type: 'field-edited', field }, context), [field]: action[field] };
  return { task: visibility === undefined ? next : visibilityChanged(next, card, visibility, undefined, context) };
};

/**
 * Whether `to` is already the card's recorded choice. The same value as the derived default is still a change when
 * nobody chose it: recording the choice is what keeps a later repair of the default from undoing it.
 */
const alreadyChosen = (card: Card, to: CardVisibility): boolean =>
  visibilityChosen(card) && cardVisibility(card) === to;

/**
 * Makes a card public or private ({@link visibilityVerdict} says who may). The change is stored on the card and
 * written to its history as a note, which every app already reads.
 */
const setVisibility = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'visibility' }>,
  context: CardContext,
): CardOutcome => {
  if (alreadyChosen(card, action.visibility)) {
    throw new BoardError('invalid', `${formatCardRef(card)} is already ${action.visibility}`);
  }
  return { task: visibilityChanged(card, card, action.visibility, action.reason, context) };
};

/**
 * `card` (which may already carry other edits) made `to`, if the caller's standing on `original` allows it. The choice
 * is stored as chosen, so no later repair of the derived default can undo it.
 */
const visibilityChanged = (
  card: Card,
  original: Card,
  to: CardVisibility,
  reason: string | undefined,
  context: CardContext,
): Card => {
  const refusal = visibilityVerdict(original, to, context.standing);
  if (refusal !== null) {
    throw new BoardError('forbidden', `${formatCardRef(original)}: ${refusal.message}`, refusal.allowed);
  }
  const why = reason === undefined ? '' : `: ${reason}`;
  const was = cardVisibility(original);
  const change = was === to ? `${to} (chosen)` : `${was} → ${to}`;
  return {
    ...withEvent(card, { type: 'note', text: `visibility: ${change}${why}` }, context),
    visibility: to,
    visibilitySource: 'chosen',
  };
};

const file = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'file' }>,
  context: CardContext,
): CardOutcome => {
  requireStanding('file', context.standing, card);
  const ref = formatCardRef(card);
  const held = card.files.includes(action.path);
  if (action.release === true) {
    if (!held) throw new BoardError('invalid', `${ref} has not claimed ${action.path}`);
    return {
      task: {
        ...withEvent(card, { type: 'file-released', path: action.path, reason: action.reason ?? null }, context),
        files: card.files.filter(path => path !== action.path),
      },
    };
  }
  if (held) throw new BoardError('invalid', `${ref} already claims ${action.path}`);
  // A claim that clashes with an open card's queues this one behind it (docs/design/clash-queue.md).
  return {
    task: queueBehindClashes(
      { ...withEvent(card, { type: 'file-claimed', path: action.path }, context), files: [...card.files, action.path] },
      [action.path],
      context,
    ),
  };
};

/**
 * Where a refiled card lands on the other board when its PR facts say nothing ({@link factsLandingLane}):
 * the named lane, else the first lane there of the category it is in now, else that board's first backlog
 * lane. A closed card stays closed: it lands in a closed lane of the other board even when its workflow does
 * not walk one, rather than being reopened.
 */
const refileLane = (card: Card, from: LaneSet, target: LaneSet, laneId: string | undefined): Lane => {
  if (laneId !== undefined) return requireLane(target, laneId);
  const category = categoryOf(from, card.laneId);
  const same = category.ok ? firstLaneOfCategory(target, card.workflow, category.value) : undefined;
  if (same?.ok === true) return same.value;
  const closed = category.ok && category.value === 'closed' ? target.lanes.find(isClosedLane) : undefined;
  return closed ?? entryLane(target, card.workflow);
};

const isClosedLane = (lane: Lane): boolean => lane.category === 'closed';

/**
 * Where an open card lands on the other board when its PR facts have a say there: the last active lane its
 * variant walks (where work resumes), for {@link reconcileFacts} to move on with the fact in its history.
 * Landing by category instead would put a card merged but not released, sitting in the Unfiled board's To
 * test, into a Released · to test lane, and facts never move a card back. `undefined` when the facts say
 * nothing, so the card lands by category.
 */
const factsLandingLane = (card: Card, target: LaneSet, context: CardContext): Lane | undefined => {
  const lanes = variantLanesOf(target, card.workflow);
  const resume = lanes.findLast(lane => lane.category === 'active') ?? entryLane(target, card.workflow);
  const move = laneFromFacts({ ...card, laneId: resume.id }, target, card.workflow, {
    prs: card.links.prs,
    runningVersion: context.runningVersion ?? null,
  });
  return move === null ? undefined : resume;
};

const variantLanesOf = (laneSet: LaneSet, workflow: Card['workflow']): readonly Lane[] => {
  const lanes = variantLanes(laneSet, workflow);
  return lanes.ok ? lanes.value : laneSet.lanes;
};

/** The first backlog lane a workflow walks, else its first lane: where a new card goes. */
const entryLane = (laneSet: LaneSet, workflow: Card['workflow']): Lane => {
  const backlog = firstLaneOfCategory(laneSet, workflow, 'backlog');
  return backlog.ok ? backlog.value : (laneSet.lanes[0] as Lane);
};

const refile = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'refile' }>,
  target: LaneSet | null,
  context: CardContext,
): CardOutcome => {
  requireStanding('refile', context.standing, card);
  const ref = formatCardRef(card);
  if (action.projectId === card.projectId) throw new BoardError('invalid', `${ref} is already on that board`);
  if (target === null) {
    throw new BoardError(
      'no-lane-set',
      `that project has no lanes yet; propose them with \`fy board lanes propose\` first`,
    );
  }
  // A refile keeps the card's state. The owner already closed a card that is closed here, so carrying it
  // into the other board's closed lane is no closing; the gate is for a card that is not closed yet.
  const source = categoryOf(context.laneSet, card.laneId);
  const alreadyClosed = source.ok && source.value === 'closed';
  // Its facts land it where work resumes there, and move it on from there only as far as the first gate.
  const atGate = card.dropped === null && !alreadyClosed && isGate(requireLane(context.laneSet, card.laneId));
  const byFacts =
    action.laneId === undefined && !alreadyClosed && card.dropped === null
      ? factsLandingLane(card, target, context)
      : undefined;
  const landing = byFacts ?? refileLane(card, context.laneSet, target, action.laneId);
  if (!(alreadyClosed && isClosedLane(landing))) requireOwnerForClosed(landing, context.standing, card);
  const lane =
    alreadyClosed || mayPassGate(context.standing, context.audience ?? 'external')
      ? landing
      : refileGateLanding(card, {
          from: context.laneSet,
          target,
          lane: landing,
          named: action.laneId !== undefined,
          atGate,
        });
  const fromProject: BoardProjectId = card.projectId;
  const refiled: Card = {
    ...withEvent(
      card,
      { type: 'refiled', fromProject, toProject: action.projectId, toLane: lane.id, reason: action.reason ?? null },
      context,
    ),
    projectId: action.projectId,
    laneId: lane.id,
  };
  return { task: reconcileFacts(refiled, { ...context, laneSet: target }) ?? refiled };
};

/**
 * Where a refile lands for anyone who may not pass a gate (docs/board.md § Cards show progress): never past a gate of
 * the other board's variant — a landing with one before it stops in that gate, and a lane NAMED past one is refused —
 * and a card waiting at a gate never lands in a later stage than that gate's, nor leaves it for a lane that is not a
 * gate. Throws `owner-gate` naming the gate.
 */
const refileGateLanding = (
  card: Card,
  facts: {
    readonly from: LaneSet;
    readonly target: LaneSet;
    readonly lane: Lane;
    readonly named: boolean;
    readonly atGate: boolean;
  },
): Lane => {
  const ref = formatCardRef(card);
  const source = requireLane(facts.from, card.laneId);
  const stage = (lane: Lane): number => LANE_CATEGORIES.indexOf(lane.category);
  if (
    facts.atGate &&
    (stage(facts.lane) > stage(source) || (!isGate(facts.lane) && stage(facts.lane) === stage(source)))
  ) {
    throw new BoardError(
      'owner-gate',
      `${ref} waits in ${source.name} for the owner; only the owner moves it on, to this board or another`,
      ['owner-human'],
    );
  }
  const entry = entryLane(facts.target, card.workflow);
  const passed = gatesBetween(facts.target, { laneId: entry.id, workflow: card.workflow }, facts.lane)[0];
  if (passed === undefined) return facts.lane;
  if (!facts.named) return passed;
  throw new BoardError(
    'owner-gate',
    `${ref} would land past ${passed.name} on that board, which waits for the owner; refile it without --lane, or to ${passed.name}`,
    ['owner-human'],
  );
};

const sameParent = (left: CardRef | null, right: CardRef | null): boolean =>
  left === null || right === null ? left === right : sameRef(left, right);

/**
 * Moves a card under another card, or to the top level. The card's owner, its leads and the owner (human)
 * may; the new parent must also be a card the caller may add a child under (`parentStanding`), so a card
 * never lands on a tree its caller cannot write.
 */
const reparent = (
  card: Card,
  action: Extract<CardActionRequest, { action: 'reparent' }>,
  context: CardContext,
  parentStanding: BoardStanding | null,
): CardOutcome => {
  requireStanding('reparent', context.standing, card);
  const ref = formatCardRef(card);
  let to: CardRef | null = null;
  if (action.parent !== null) {
    const parent = requireLocalCard(context.index, action.parent, 'parent');
    requireStanding('adopt', parentStanding ?? 'reader', parent);
    if (parentLoop(context.index, card.id, { id: parent.id })) {
      throw new BoardError(
        'cycle',
        `${ref} cannot sit under ${formatCardRef(parent)}: that card is ${ref} or inside it`,
      );
    }
    to = { id: parent.id };
  }
  if (sameParent(card.parent, to)) {
    throw new BoardError(
      'invalid',
      `${ref} is already ${to === null ? 'at the top level' : `under ${formatCardRef(to)}`}`,
    );
  }
  const sitting = { ...card, parent: to };
  const moved = card.visibility === undefined ? sitting : withDefaultVisibility(sitting);
  const was = cardVisibility(card);
  const now = cardVisibility(moved);
  // Where a card sits is part of what decides who can see it: a card never becomes a public sub-card, and a
  // person's card is never hidden, by a caller the visibility rules would stop doing either directly.
  const refusal =
    now === 'public' && card.parent === null && to !== null
      ? visibilityVerdict(moved, 'public', context.standing)
      : was === 'public' && now === 'private'
        ? visibilityVerdict(moved, 'private', context.standing)
        : null;
  if (refusal !== null) {
    throw new BoardError('forbidden', `${ref}: ${refusal.message}, and moving it there would do that`, refusal.allowed);
  }
  return {
    task: {
      ...withEvent(moved, { type: 'reparented', from: card.parent, to, reason: action.reason ?? null }, context),
      parent: to,
    },
  };
};

/**
 * Applies one action request to one card. `focus` changes nothing on the card (the service records it
 * on the session), so it answers `task: null` once its authority is proved. `refile` needs the target
 * board's lanes, which the service reads first. `reparent` needs the caller's standing on the NEW parent.
 */
export const applyAction = (
  card: Card,
  action: CardActionRequest,
  context: CardContext,
  refileTarget: LaneSet | null = null,
  parentStanding: BoardStanding | null = null,
): CardOutcome => {
  const ref = formatCardRef(card);
  switch (action.action) {
    case 'move':
      return move(card, action.to, action.reason, context);
    case 'focus':
      requireStanding('focus', context.standing, card);
      return { task: null };
    case 'block':
      requireStanding('block', context.standing, card);
      requireOpen(card, 'block');
      return {
        task: {
          ...withEvent(card, { type: 'blocked', reason: action.reason }, context),
          blocked: { on: 'external', reason: action.reason, since: context.now },
        },
      };
    case 'unblock':
      requireStanding('unblock', context.standing, card);
      if (card.blocked === null) throw new BoardError('invalid', `${ref} is not blocked`);
      return {
        task: { ...withEvent(card, { type: 'unblocked', reason: action.reason ?? null }, context), blocked: null },
      };
    case 'depend':
      return depend(card, action, context);
    case 'undepend':
      return undepend(card, action, context);
    case 'drop':
      requireStanding('drop', context.standing, card);
      requireOpen(card, 'drop');
      return {
        task: {
          ...withEvent(card, { type: 'dropped', reason: action.reason }, context),
          dropped: { reason: action.reason, at: context.now },
        },
      };
    case 'reopen':
      return reopen(card, action, context);
    case 'clarify': {
      requireStanding('clarify', context.standing, card);
      const clarification: BoardClarification = {
        text: action.text,
        source: action.source,
        at: context.now,
        by: context.actor,
      };
      return {
        task: {
          ...withEvent(card, { type: 'clarified', text: action.text, source: action.source }, context),
          clarifications: [...card.clarifications, clarification],
        },
      };
    }
    case 'link':
      return link(card, action, context);
    case 'trigger':
      return report(card, action, context);
    case 'assign':
      if (context.handsDown !== true) requireAssign(context.standing, card);
      if (action.assignee === card.assignee) throw new BoardError('invalid', `${ref} is already assigned that way`);
      return {
        task: {
          ...withEvent(
            card,
            {
              type: 'assigned',
              from: card.assignee,
              to: action.assignee,
              ...(context.handsDown === true ? { handedDown: true as const } : {}),
            },
            context,
          ),
          assignee: action.assignee,
        },
      };
    case 'claim': {
      const actor = context.actor;
      if (context.claimedFrom === undefined || actor.kind !== 'ferret') {
        const caller: BoardCaller =
          actor.kind === 'ferret' ? { kind: 'ferret', ferret: actor.ferret } : { kind: 'owner' };
        throw new BoardError('forbidden', claimRefusalMessage(card, caller));
      }
      const claimer = actor.ferret;
      return {
        task: {
          ...withEvent(
            card,
            { type: 'assigned', from: card.assignee, to: claimer, claimedFrom: context.claimedFrom },
            context,
          ),
          assignee: claimer,
        },
      };
    }
    case 'adopt': {
      const actor = context.actor;
      if (context.adoptedFrom === undefined || actor.kind !== 'ferret') {
        throw new BoardError(
          'forbidden',
          `only a live lead may adopt ${ref}, and only when its owner ferret and its assignee have both ended`,
        );
      }
      const adopter = actor.ferret;
      return {
        task: {
          ...withEvent(
            card,
            {
              type: 'assigned',
              from: card.assignee,
              to: adopter,
              adopted: {
                from: context.adoptedFrom,
                reason: action.reason ?? `owner ferret ${card.owner} and assignee ${effectiveAssignee(card)} ended`,
              },
            },
            context,
          ),
          owner: adopter,
          assignee: adopter,
        },
      };
    }
    case 'note':
      requireStanding('note', context.standing, card);
      return { task: withEvent(card, { type: 'note', text: action.text }, context) };
    case 'edit':
      return edit(card, action, context);
    case 'file':
      return file(card, action, context);
    case 'order':
      requireStanding('order', context.standing, card);
      if (action.order === card.order) throw new BoardError('invalid', `${ref} already has that order`);
      return {
        task: {
          ...withEvent(card, { type: 'ordered', from: card.order, to: action.order }, context),
          order: action.order,
        },
      };
    case 'snooze':
      requireStanding('snooze', context.standing, card);
      if (action.until === null) {
        if (card.snoozed == null) throw new BoardError('invalid', `${ref} is not snoozed`);
      } else if (Date.parse(action.until) <= Date.parse(context.now)) {
        throw new BoardError('invalid', `${ref} can only be snoozed to a time that has not passed`);
      }
      return {
        task: {
          ...withEvent(card, { type: 'snoozed', until: action.until }, context),
          snoozed: action.until === null ? null : { until: action.until, laneId: card.laneId },
        },
      };
    case 'refile':
      return refile(card, action, refileTarget, context);
    case 'reparent':
      return reparent(card, action, context, parentStanding);
    case 'visibility':
      return setVisibility(card, action, context);
  }
};

// ---------------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------------

export interface NewCardContext {
  readonly id: CardId;
  readonly machineId: string;
  readonly now: string;
  readonly actor: CardActor;
  readonly standing: BoardStanding;
  /** The accountable ferret: the creating session, or the assignee the owner named. */
  readonly owner: string;
  readonly projectId: BoardProjectId;
  readonly laneSet: LaneSet;
  readonly index: BoardIndex;
}

/** A new card, before the store has it: in its variant's first backlog lane unless one is named. */
export const newCard = (request: CardCreateRequest, context: NewCardContext): Card => {
  const lane =
    request.laneId === undefined
      ? entryLane(context.laneSet, request.workflow)
      : requireLane(context.laneSet, request.laneId);
  requireOwnerForClosed(lane, context.standing, { id: context.id });
  for (const dependency of request.dependsOn) requireLocalCard(context.index, dependency.task, 'dependency');
  return {
    format: 1,
    id: context.id,
    machineId: context.machineId,
    projectId: context.projectId,
    laneId: lane.id,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    ask: request.ask,
    clarifications: [],
    premise: request.premise,
    context: request.context,
    terms: request.terms,
    brief: request.brief,
    howToTest: request.howToTest,
    ...(request.progress === undefined ? {} : { progress: request.progress }),
    owner: context.owner,
    assignee: request.assignee,
    parent: request.parent,
    dependsOn: request.dependsOn.map(dependency => ({ task: { id: dependency.task.id }, until: dependency.until })),
    blocked: null,
    dropped: null,
    workflow: request.workflow,
    links: { prs: [], branch: request.branch ?? null, commits: [], docs: request.docs },
    files: request.files,
    order: null,
    createdAt: context.now,
    createdBy: context.actor,
    history: [{ seq: 1, at: context.now, actor: context.actor, type: 'created', laneId: lane.id }],
  };
};
