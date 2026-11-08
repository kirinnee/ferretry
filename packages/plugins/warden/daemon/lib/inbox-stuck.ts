/**
 * INBOX STUCK: a ferret whose oldest undelivered message has waited in Ferretry's own queue far past the
 * moment it was due — whatever is in the way.
 *
 * ═══ WHY ═══
 *
 * Between 2026-11-02 and 2026-11-04 the messages sent to ryu, a lead in a declared wait, sat undelivered for
 * 38 minutes to almost six hours, eleven times. Each time ONE message was `typing` — handed to the send path,
 * whose transport had thrown before its first key and left its ledger row `accepted` with nothing watching it —
 * and the queue, which types one message at a time, held everything behind it with no reason given. Only a
 * daemon restart, or somebody else's `fy send --wait`, made the tracker look again. On 2026-11-03 elta's queue
 * held 28 messages for five hours as "waiting behind a draft" that was a send of ours whose landing was never
 * confirmed, so nothing proved it ours. `input_stuck` saw neither: nothing was typed in ryu's box, ryu's turn
 * state was not `your-turn` while it waited, and elta's send was never seen in its composer.
 *
 * ═══ WHAT IT IS ═══
 *
 * Facts only, from the session's queue and its send ledger. A message is UNDELIVERED while it is `queued` or
 * `typing`. A hold the queue means — a message still inside its combining window, an FYI that will not revive a
 * stopped ferret, a question only its answer may follow — is not stuck; a declared wait is no hold at all (the
 * queue never waits for one, and a reply is what a waiting ferret wants). A message is stuck once it is overdue
 * by its urgency's limit ({@link INBOX_STUCK_LIMITS_MS}); the flag names the oldest such message, how many are
 * waiting, and the CAUSE read off the head of the queue ({@link InboxStuckCause}).
 *
 * ═══ WHAT IS DONE ═══
 *
 * Once per EPISODE (one oldest message): the safe unstick for its cause ({@link unstickActs}) — the tracker's
 * own look, which re-proves a send from the transcript and the screen and types it again only when it is proven
 * never to have arrived; the send path's verified finish of a draft that is provably ours; and one more look by
 * the deliverer. Nothing is deleted or resent on a guess, and a person's draft is never touched. If the same
 * episode is still flagged a sweep later, the ferret is named on ONE machine notice listing every stuck inbox,
 * which clears itself as each drains, and the flag is handed to ONE investigation per episode — never in place of the
 * ferret's own — whose verdict can only run the same safe unstick again.
 *
 * Pure: the fleet, the queues, the ledgers and the memory arrive through the arguments.
 */
import type { QueuedMessage } from './protocol.ts';
import { inWardenLineage, type WardenAnomaly } from './detect.ts';
import { isoFromMs } from './time.ts';
import { isTerminalStatus, type WardenSessionView } from './types.ts';

/** How urgent a waiting message is, which decides how long it may wait past due. */
export type InboxUrgency = 'blocker' | 'action' | 'fyi';

/**
 * How long past due a message may wait before its inbox is stuck. A delivery takes seconds, and a message held
 * on purpose is not due until its hold ends, so each limit leaves a wide margin; a blocker's is the shortest.
 */
export const INBOX_STUCK_LIMITS_MS: Readonly<Record<InboxUrgency, number>> = {
  blocker: 10 * 60_000,
  action: 20 * 60_000,
  fyi: 45 * 60_000,
};

/** A message overdue by more than this is wreckage, not news: it is not reported however it ended. */
export const INBOX_STUCK_HORIZON_MS = 3 * 24 * 60 * 60_000;

/**
 * The longest a message can be held to combine with others: the most `fyiMaxHoldMs` may be set to
 * (`runtime/config.ts`), which is longer than any action window.
 */
const LONGEST_HOLD_MS = 24 * 60 * 60_000;

/**
 * A queue not written to for longer than this cannot hold a message inside the horizon — every message is appended
 * when it is accepted, and none is due later than its longest hold after that — so it is not read at all. Finished
 * ferrets keep their queues for good; reading every one of them every sweep would grow without bound.
 */
export const INBOX_STALE_QUEUE_MS = INBOX_STUCK_HORIZON_MS + LONGEST_HOLD_MS;

/** One send of the session's ledger, as far as this module reads it: the latest line of each. */
export interface InboxSend {
  readonly sendId: string;
  readonly path: string;
  readonly fate: string;
  readonly held?: boolean | undefined;
  readonly untyped?: boolean | undefined;
  readonly typedNotSent?: boolean | undefined;
}

/**
 * Why the head of the queue is not moving, as the facts show it.
 *
 * - `hung_handover` — a message is `typing` and its send is `accepted` with nothing typed and nothing watching:
 *   the transport gave up before its first key and the tracker was never told (ryu).
 * - `held_for_revive` — its send is held for an explicit revive the reviver refused; nobody was told to revive.
 * - `draft_own` — the box holds a send of ours that did not submit (`input_stuck` presses at a ferret whose turn ended).
 * - `draft_unattributed` — the box holds text nothing proves ours, at a ferret nobody is typing into (elta).
 * - `dialog`, `unreadable`, `launching` — the queue's own wait reason, held far longer than it ever should be;
 *   `unreadable` also for a person's send the screen would not let be typed, which the tracker types once it reads clear.
 * - `no_reason` — waiting with nothing in front of it and no reason given: the deliverer has not looked.
 */
export type InboxStuckCause =
  | 'hung_handover'
  | 'held_for_revive'
  | 'draft_own'
  | 'draft_unattributed'
  | 'dialog'
  | 'unreadable'
  | 'launching'
  | 'no_reason';

/** A stuck inbox: the anomaly, plus what the Warden acts on. */
export interface InboxStuckFlag extends WardenAnomaly {
  readonly kind: 'inbox_stuck';
  /** The oldest stuck message: the episode. */
  readonly messageId: string;
  readonly cause: InboxStuckCause;
  /** Undelivered messages in the queue, intended holds left out. */
  readonly waiting: number;
  /** The send that holds the head of the queue, when one does. */
  readonly blockingSendId?: string;
}

/**
 * The sessions whose queues are worth reading: autonomous and not a warden's. Status and turn state do not
 * matter — a declared wait (ryu's turn state was `null`) and a stopped ferret an action should have revived are
 * both places a message sticks. An interactive session is the owner's own terminal, watched by its owner.
 */
export function inboxStuckCandidates(fleet: readonly WardenSessionView[]): readonly WardenSessionView[] {
  const byId = new Map(fleet.map(view => [view.config.id, view]));
  return fleet.filter(view => view.config.mode === 'auto' && !inWardenLineage(view, byId));
}

/** How urgent a message is — the queue's own rule (`effectiveLabel`): a person's, a blocker, `--now`, a question. */
export function inboxUrgency(message: QueuedMessage): InboxUrgency {
  if (
    message.sender === 'human' ||
    message.label === 'blocker' ||
    message.interrupt === true ||
    message.replyExpected === true
  )
    return 'blocker';
  return message.sender === 'agent' && message.label === 'fyi' ? 'fyi' : 'action';
}

/** When a message was due to go: at once, or when the hold it was given to combine with others ends. */
export function inboxDueMs(message: QueuedMessage): number {
  const enqueued = Date.parse(message.enqueuedAt);
  if (inboxUrgency(message) === 'blocker' || message.holdUntil === undefined) return enqueued;
  return Math.max(enqueued, Date.parse(message.holdUntil));
}

/** Whether a waiting message is one the queue is holding ON PURPOSE, so it is never stuck. */
function intendedHold(message: QueuedMessage, view: WardenSessionView): boolean {
  if (message.state !== 'queued') return false;
  // Only its answer may go into a pane with a question on it; the owner already has the question.
  if (message.waitReason === 'question') return true;
  // An FYI never revives a stopped ferret.
  const fyi = message.sender === 'agent' && message.label === 'fyi';
  return fyi && (message.waitReason === 'stopped' || isTerminalStatus(view.state.status));
}

/** Messages the queue has not delivered, in the order they were accepted. */
function undelivered(messages: readonly QueuedMessage[]): readonly QueuedMessage[] {
  return messages.filter(message => message.state === 'queued' || message.state === 'typing');
}

/** The cause the head of the queue shows. */
function inboxStuckCause(
  messages: readonly QueuedMessage[],
  sends: readonly InboxSend[],
  oldest: QueuedMessage,
): { readonly cause: InboxStuckCause; readonly blockingSendId?: string } {
  const typing = messages.find(message => message.state === 'typing');
  if (typing !== undefined) {
    const sendId = typing.deliveredAs ?? typing.id;
    const send = sends.find(each => each.sendId === sendId);
    if (send?.held === true || send?.path === 'revive-queue')
      return { cause: 'held_for_revive', blockingSendId: sendId };
    if (send?.typedNotSent === true) return { cause: 'draft_own', blockingSendId: sendId };
    // A person's send the screen refused before any key: the tracker is watching it, and types it once the
    // screen reads clear.
    if (send?.untyped === true) return { cause: 'unreadable', blockingSendId: sendId };
    return { cause: 'hung_handover', blockingSendId: sendId };
  }
  switch (oldest.waitReason) {
    case 'draft':
      return oldest.waitBehind === undefined
        ? { cause: 'draft_unattributed' }
        : { cause: 'draft_own', blockingSendId: oldest.waitBehind };
    case 'dialog':
    case 'unreadable':
    case 'launching':
      return { cause: oldest.waitReason };
    default:
      return { cause: 'no_reason' };
  }
}

/** The episode a stuck inbox is: its oldest stuck message, for that ferret. */
export function inboxStuckEpisode(sessionId: string, messageId: string): string {
  return `inbox:${sessionId}:${messageId}`;
}

/** What each cause is, in a line a person reads. */
const CAUSE_WORDS: Readonly<Record<InboxStuckCause, string>> = {
  hung_handover: 'a message handed to the send path was never typed and nothing is watching it',
  held_for_revive: 'a message is held for a revive that was refused',
  draft_own: 'a message of ours sits typed in its box, not submitted',
  draft_unattributed: 'its box holds text Ferretry cannot prove is its own',
  dialog: 'a dialog on its screen holds the queue',
  unreadable: 'its screen cannot be read to prove the box empty',
  launching: 'it has been launching all this time',
  no_reason: 'nothing has looked at its queue',
};

/** How long, in whole minutes, from `fromMs` to `nowMs`. */
const minutes = (nowMs: number, fromMs: number): number => Math.max(0, Math.floor((nowMs - fromMs) / 60_000));

/** The flag for one session's queue, or `undefined` when nothing in it is stuck. */
export function inboxStuckOf(
  view: WardenSessionView,
  messages: readonly QueuedMessage[],
  sends: readonly InboxSend[],
  nowMs: number,
  limits: Readonly<Record<InboxUrgency, number>> = INBOX_STUCK_LIMITS_MS,
): InboxStuckFlag | undefined {
  const open = undelivered(messages).filter(message => !intendedHold(message, view));
  let oldest: QueuedMessage | undefined;
  for (const message of open) {
    const due = inboxDueMs(message);
    const overdue = nowMs - due;
    if (!Number.isFinite(due) || overdue < limits[inboxUrgency(message)] || overdue > INBOX_STUCK_HORIZON_MS) continue;
    if (oldest === undefined || due < inboxDueMs(oldest)) oldest = message;
  }
  if (oldest === undefined) return undefined;
  const { cause, blockingSendId } = inboxStuckCause(messages, sends, oldest);
  const due = inboxDueMs(oldest);
  const idleMinutes = minutes(nowMs, due);
  const from =
    oldest.sender === 'human'
      ? 'from you'
      : oldest.sender === 'daemon'
        ? 'from Ferretry'
        : oldest.fromName === undefined
          ? 'from a ferret'
          : `from ${oldest.fromName}`;
  const count = open.length === 1 ? '1 message' : `${open.length} messages`;
  return {
    kind: 'inbox_stuck',
    sessionId: view.config.id,
    ...(view.config.teammate === undefined ? {} : { teammate: view.config.teammate }),
    ...(view.config.label === undefined ? {} : { label: view.config.label }),
    status: view.state.status,
    detail: `${count} undelivered in Ferretry's queue; the oldest (${inboxUrgency(oldest)} ${from}) has waited ${idleMinutes}m past due — ${CAUSE_WORDS[cause]}`,
    since: isoFromMs(due),
    idleMinutes,
    subject: inboxStuckEpisode(view.config.id, oldest.id),
    messageId: oldest.id,
    cause,
    waiting: open.length,
    ...(blockingSendId === undefined ? {} : { blockingSendId }),
  };
}

/** Whether a queue still holds a message it waits on for real that is older than the horizon: it EXPIRED, not drained. */
export function inboxExpired(view: WardenSessionView, messages: readonly QueuedMessage[], nowMs: number): boolean {
  return undelivered(messages).some(
    message => !intendedHold(message, view) && nowMs - inboxDueMs(message) > INBOX_STUCK_HORIZON_MS,
  );
}

/**
 * The flag for each candidate whose queue is stuck, and the candidates not flagged only because what waits in
 * them is past the horizon. A candidate whose queue or ledger is missing from the maps was not read, and is in
 * neither: it proves nothing.
 */
export function detectInboxStuck(
  candidates: readonly WardenSessionView[],
  queues: ReadonlyMap<string, readonly QueuedMessage[]>,
  ledgers: ReadonlyMap<string, readonly InboxSend[]>,
  nowMs: number,
  limits: Readonly<Record<InboxUrgency, number>> = INBOX_STUCK_LIMITS_MS,
): { readonly flags: readonly InboxStuckFlag[]; readonly expired: readonly string[] } {
  const flags: InboxStuckFlag[] = [];
  const expired: string[] = [];
  for (const view of candidates) {
    const messages = queues.get(view.config.id);
    const sends = ledgers.get(view.config.id);
    if (messages === undefined || sends === undefined) continue;
    const flag = inboxStuckOf(view, messages, sends, nowMs, limits);
    if (flag !== undefined) flags.push(flag);
    else if (inboxExpired(view, messages, nowMs)) expired.push(view.config.id);
  }
  return { flags, expired };
}

/** The flag as the anomaly every other surface reads: the Warden's own fields left behind. */
export function inboxStuckAnomaly(flag: InboxStuckFlag): WardenAnomaly {
  const { messageId: _message, cause: _cause, waiting: _waiting, blockingSendId: _send, ...anomaly } = flag;
  return anomaly;
}

// ── What the Warden does ───────────────────────────────────────────────────────────────────────────────

/**
 * One safe act toward a stuck inbox, each the daemon's own and each verified where it acts:
 *
 * - `tracker_look` — the send tracker's look (`SendTracker.check`), the one a boot and a `fy send --wait` make.
 *   The transcript's proof wins; a message held in the pane or the harness's queue is waited for; one typed
 *   into a busy turn is waited for; an unreadable screen settles it unconfirmed. Only a send PROVEN never to
 *   have arrived is typed again, under the send lock, its attempt ledgered before any key.
 * - `finish_own_draft` — the send path's verified finish of the box's text, which presses Enter only when the
 *   box holds exactly a send of ours. A person's draft is never touched.
 * - `delivery_look` — one more look by the queue's deliverer, which only ever applies its normal rules.
 */
export type InboxUnstickAct = 'tracker_look' | 'finish_own_draft' | 'delivery_look';

/**
 * The safe unstick for a cause, in order. A send of ours typed in the box gets the verified finish (`input_stuck`
 * presses for it only at a ferret whose turn has ended, never in a declared wait). A send held for a refused
 * revive gets nothing of its own — a revive is a decision, and the reviver already refused it. Every cause gets a
 * delivery look, which can do nothing but the queue's normal work.
 */
export function unstickActs(cause: InboxStuckCause): readonly InboxUnstickAct[] {
  switch (cause) {
    case 'hung_handover':
    case 'unreadable':
      return ['tracker_look', 'delivery_look'];
    case 'draft_unattributed':
      return ['tracker_look', 'finish_own_draft', 'delivery_look'];
    case 'draft_own':
      return ['finish_own_draft', 'delivery_look'];
    default:
      return ['delivery_look'];
  }
}

/** What the Warden did about one ferret's stuck inbox, this episode. */
export interface InboxStuckTold {
  readonly messageId: string;
  readonly cause: InboxStuckCause;
  readonly unstuckAt?: string;
  /** When the ferret was named on the machine notice. */
  readonly noticedAt?: string;
  /** When an investigation of this episode was started: one per episode. */
  readonly investigatedAt?: string;
}

/** Keyed by session id, kept while the ferret is flagged. */
export type InboxStuckMemory = Readonly<Record<string, InboxStuckTold>>;

/** The next step for one flagged ferret. */
export type InboxStuckStep =
  | {
      readonly kind: 'unstick';
      readonly sessionId: string;
      readonly messageId: string;
      readonly cause: InboxStuckCause;
    }
  | { readonly kind: 'notice'; readonly sessionId: string; readonly messageId: string };

/**
 * What to do this sweep: the safe unstick once for a new episode; the notice once that episode outlives it (a
 * sweep later, still flagged); and every ferret no longer flagged taken off — except one whose queue or ledger
 * could not be read this sweep (`unread`), which proves nothing and is left as it stands. Nothing is done while
 * the Warden is off; recoveries are cleared either way.
 */
export function planInboxStuck(input: {
  readonly stuck: readonly Pick<InboxStuckFlag, 'sessionId' | 'messageId' | 'cause'>[];
  readonly memory: InboxStuckMemory;
  readonly enabled: boolean;
  readonly unread?: ReadonlySet<string>;
}): { readonly steps: readonly InboxStuckStep[]; readonly recovered: readonly string[] } {
  const flagged = new Set(input.stuck.map(each => each.sessionId));
  const recovered = Object.keys(input.memory).filter(
    sessionId => !flagged.has(sessionId) && input.unread?.has(sessionId) !== true,
  );
  if (!input.enabled) return { steps: [], recovered };
  const steps: InboxStuckStep[] = [];
  for (const { sessionId, messageId, cause } of input.stuck) {
    const told = input.memory[sessionId];
    if (told === undefined || told.messageId !== messageId) {
      steps.push({ kind: 'unstick', sessionId, messageId, cause });
      continue;
    }
    if (told.noticedAt === undefined) steps.push({ kind: 'notice', sessionId, messageId });
  }
  return { steps, recovered };
}

/**
 * The flags to hand to an investigation: those already on the notice — the safe unstick did not clear them — and
 * not yet investigated this episode, as an assigned warden's one session each.
 */
export function inboxStuckForInvestigation(
  stuck: readonly InboxStuckFlag[],
  memory: InboxStuckMemory,
): readonly WardenAnomaly[] {
  return stuck
    .filter(flag => {
      const told = memory[flag.sessionId];
      return told?.messageId === flag.messageId && told.noticedAt !== undefined && told.investigatedAt === undefined;
    })
    .map(flag => ({ ...inboxStuckAnomaly(flag), assignedWarden: true }));
}

/** The line a ferret gets on the machine notice: who, how many, how long, why, and that the unstick did not move it. */
export function inboxStuckNoticeLine(flag: InboxStuckFlag): string {
  const who = flag.teammate === undefined ? flag.sessionId : `${flag.teammate} (${flag.sessionId})`;
  const count = flag.waiting === 1 ? '1 message waiting' : `${flag.waiting} messages waiting`;
  const send = flag.blockingSendId === undefined ? '' : ` (send ${flag.blockingSendId})`;
  return `${who}: ${count}, oldest ${flag.idleMinutes ?? 0}m past due — ${CAUSE_WORDS[flag.cause]}${send}; the safe re-check did not move it`;
}
