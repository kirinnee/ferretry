/**
 * THE BOARD SWEEP: the board's own tick (`board-design.md` §3.3 nudges, §2.7 unblocks). Owned by the
 * board, not the Warden: it is about cards, and a card's ferret may be perfectly healthy while the card
 * goes stale.
 *
 * Each tick reads the board once, compares it with what the last tick saw ({@link SweepMemory}, a small
 * state file that survives restarts) and sends only what somebody has to ACT on, through the ordinary
 * send path, as a plain sentence. Who sent it is the queue item's metadata (`QueuedMessage.by`, which the
 * app shows as "Ferretry · Board"), never text in the message:
 *
 * 1. **A stale card's ferret is nudged**: `&F412 has had no activity for 3h in Implement. Move it, note
 *    why, block it, or drop it.` The assignee while it is alive; else the nearest live lead above it; the
 *    card's OWNER (its creator) only when nobody in that line is left, and an interactive session last of all
 *    ({@link noticeRecipient}). At most once per card per its lane's `staleAfter` whoever it goes to; never
 *    to a session that declared a wait; never for a waiting card (a waiting card is not stale, by
 *    derivation).
 * 2. **A dependent card's assignee is told it can go ahead** once its last blocker ships:
 *    `&F20 can go ahead: &F18 merged.` Nobody else is.
 *
 * NO NEWS. A card's move, block, drop, reopen or done is never typed into anybody's chat — not the
 * lead's, not alone, and not in any digest: the owner's "no batched digest" rule (2026-10-30: "there should
 * not be any append or prepend on any feature") still holds for everything the board, and every other part
 * of Ferretry, sends. The one digest the owner has allowed (2026-11-03) is for FERRET messages that a
 * ferret labelled `fyi` (`fy send --kind fyi`), which the queue holds and delivers together with the
 * receiver's other pending ferret messages (docs/message-delivery.md § Labels and combined delivery). A
 * board message is the daemon's, never labelled, and never held. The ferret that finished tells its lead in
 * its own words, the board shows the state, and the card's history keeps every event.
 *
 * 3. **A helper whose ferret ended is closed**: a sub-card with no PR to ship, assigned to a ferret that is gone for
 *    longer than {@link HELPER_ENDED_GRACE_MS}, closes as "helper finished" (docs/board.md § Sub-cards close
 *    themselves). A sub-card whose ferret is merely idle, unreadable or the lead itself is never closed here.
 *
 * 4. **A card whose ferret ended goes back to its lead**: an open card in a working lane (`active` or `review`),
 *    whose assignee is gone for longer than the grace, is assigned to the nearest live ancestor of that ferret,
 *    with `returned to <lead>: <ferret> finished` in its history (docs/board.md § A finished helper's card goes
 *    back to its lead). It sits behind rule 3: a helper that closes is not also returned.
 *
 * The first sight of a card is a baseline: a daemon that boots onto a board with a thousand cards says
 * nothing about any of them.
 *
 * {@link planSweep} is pure; {@link BoardSweep} does the IO through its ports.
 */
import { BoardInstantSchema as InstantSchema, type CardId, type CardRef, type CardView, formatCardRef, isBlockerDone, laneOf } from '../../../contract/index.ts';
import { z } from 'zod';
import {
  cardStaleAfterMs,
  presenceOf,
  type FerretLivenessGuard,
  type FerretLivenessSource,
  type FerretRoster,
} from './activity.ts';
import { effectiveAssignee } from './authority.ts';
import { cardCategory, type LaneSets } from './graph.ts';
import { noticeRecipient } from './notice-route.ts';
import { endedForGrace, lineageThrough, returnTarget } from './return-to-lead.ts';
import { isHandedHelper, isPrFreeHelper } from './sub-card-close.ts';
import type { BoardClock, BoardDiagnostics } from './ports.ts';

/** How often the daemon sweeps the board. */
export const BOARD_SWEEP_INTERVAL_MS = 60_000;

/**
 * What the last tick saw of one card: its unfinished blockers, as `machine/id` keys. Not strict, so a
 * memory written when the sweep also kept a card's history position and asks still reads.
 */
const CardMarkSchema = z.object({ blockedBy: z.array(z.string()) });
type CardMark = z.infer<typeof CardMarkSchema>;

/** What the last tick saw, and when each card was last nudged. Open cards only: closed ones are forgotten. */
export const SweepMemorySchema = z.strictObject({
  v: z.literal(1),
  sweptAt: InstantSchema.nullable(),
  nudged: z.record(z.string(), InstantSchema),
  seen: z.record(z.string(), CardMarkSchema),
});
export type SweepMemory = z.infer<typeof SweepMemorySchema>;

export const EMPTY_SWEEP_MEMORY: SweepMemory = { v: 1, sweptAt: null, nudged: {}, seen: {} };

/**
 * A message to send: one queued message to one ferret about one card. `stale` is throttled by the card's
 * lane threshold; `unblocked` is said once, when the last blocker ships.
 */
interface BoardNudge {
  readonly kind: 'stale' | 'unblocked';
  readonly taskId: CardId;
  readonly ferret: string;
  readonly message: string;
}

export interface SweepPlan {
  /** The memory to keep, before any nudge is recorded as sent. */
  readonly memory: SweepMemory;
  readonly nudges: readonly BoardNudge[];
  /** The open helpers whose ferret ended with no PR to ship: they close. */
  readonly closes: readonly CardId[];
  /** The open cards whose ferret ended and that have a live lead above it: they go back to that lead. */
  readonly returns: readonly CardReturn[];
}

/** One card going back: to `lead`, because `from` (its ferret) ended. */
interface CardReturn {
  readonly id: CardId;
  readonly lead: string;
  readonly from: string;
}

export interface SweepBoard {
  readonly views: readonly CardView[];
  readonly laneSets: LaneSets;
}

// ---------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------

/** An idle span the way the owner reads it: `14m`, `3h`, `4d`. */
export const formatIdle = (ms: number): string => {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

/** The nudge a stale card's ferret is sent. */
export const nudgeMessage = (card: Pick<CardView, 'id'>, idleMs: number, lane: string): string =>
  `${formatCardRef(card)} has had no activity for ${formatIdle(idleMs)} in ${lane}. Move it, note why, block it, or drop it.`;

/** What a dependent card's assignee is told once its last blocker ships: `&F20 can go ahead: &F18 merged.` */
const unblockedMessage = (card: Pick<CardView, 'id'>, shipped: readonly string[]): string =>
  `${formatCardRef(card)} can go ahead: ${shipped.join(', ')}.`;

const laneName = (board: SweepBoard, card: Pick<CardView, 'projectId'>, laneId: string): string => {
  const laneSet = board.laneSets.get(card.projectId);
  const lane = laneSet === undefined ? undefined : laneOf(laneSet, laneId);
  return lane?.ok === true ? lane.value.name : laneId;
};

const refKey = (ref: CardRef): string => `${ref.machineId ?? ''}/${ref.id}`;

// ---------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------

const isOpen = (view: CardView, board: SweepBoard): boolean =>
  view.dropped === null && cardCategory(view, board.laneSets) !== 'closed';

/** The card a ref names on this card's own machine; `undefined` for one elsewhere or not here. */
const localView = (
  view: Pick<CardView, 'machineId'>,
  ref: CardRef,
  byId: ReadonlyMap<CardId, CardView>,
): CardView | undefined =>
  ref.machineId === undefined || ref.machineId === view.machineId ? byId.get(ref.id) : undefined;

/** The blockers that left `previous` because they shipped, as `&F18 merged`. */
const shippedBlockers = (
  view: CardView,
  previous: readonly string[],
  board: SweepBoard,
  byId: ReadonlyMap<CardId, CardView>,
): readonly string[] => {
  const words: string[] = [];
  for (const dependency of view.dependsOn) {
    if (dependency.override !== undefined || !previous.includes(refKey(dependency.task))) continue;
    const blocker = localView(view, dependency.task, byId);
    if (blocker === undefined) continue;
    const category = cardCategory(blocker, board.laneSets);
    if (category === undefined || !isBlockerDone(category, dependency.until, blocker.shippedIn !== null)) continue;
    words.push(`${formatCardRef(blocker)} ${laneName(board, blocker, blocker.laneId).toLowerCase()}`);
  }
  return words;
};

/**
 * Who a card's go-ahead is for, or `null`: its assignee, when its last blocker SHIPPED since `mark` (one
 * that left without shipping — a dependency dropped, an override — is no news) and it is alive to act.
 */
const unblockNudge = (
  view: CardView,
  mark: CardMark | undefined,
  board: SweepBoard,
  byId: ReadonlyMap<CardId, CardView>,
  roster: FerretRoster,
): BoardNudge | null => {
  if (mark === undefined || mark.blockedBy.length === 0 || view.blockedBy.length > 0) return null;
  const shipped = shippedBlockers(view, mark.blockedBy, board, byId);
  const assignee = effectiveAssignee(view);
  if (shipped.length === 0 || presenceOf(roster, assignee) !== 'alive') return null;
  return { kind: 'unblocked', taskId: view.id, ferret: assignee, message: unblockedMessage(view, shipped) };
};

/**
 * Whether a card is a helper whose ferret has ended: a sub-card handed to another ferret (never the lead's own
 * bookkeeping), with no PR to ship, whose session is gone and untouched for the grace.
 */
const helperEnded = (view: CardView, roster: FerretRoster, nowMs: number): boolean => {
  return isHandedHelper(view) && isPrFreeHelper(view) && endedForGrace(view, roster, effectiveAssignee(view), nowMs);
};

/**
 * Who a stale card's nudge goes to, or `null` when nobody should be nudged now: the card's assignee while it is
 * alive, else the nearest live lead above it, the card's owner only when nobody in that line is left
 * ({@link noticeRecipient}). A session that declared a wait is never nudged, and nobody is nudged in its place.
 */
export const nudgeRecipient = (view: CardView, roster: FerretRoster): string | null => {
  const recipient = noticeRecipient(roster, view);
  return recipient === null || recipient.session.declaredWait ? null : recipient.ferret;
};

/** One tick's decisions. Pure. */
export const planSweep = (memory: SweepMemory, board: SweepBoard, roster: FerretRoster, now: string): SweepPlan => {
  const nowMs = Date.parse(now);
  const byId = new Map(board.views.map(view => [view.id, view]));
  const seen: Record<string, CardMark> = {};
  const nudged: Record<string, string> = {};
  const nudges: BoardNudge[] = [];
  const closes: CardId[] = [];
  const returns: CardReturn[] = [];
  for (const view of board.views) {
    if (!isOpen(view, board)) continue;
    if (helperEnded(view, roster, nowMs)) {
      closes.push(view.id);
      continue;
    }
    const lead = returnTarget(view, cardCategory(view, board.laneSets), roster, nowMs);
    if (lead !== null) {
      returns.push({ id: view.id, lead, from: effectiveAssignee(view) });
      continue;
    }
    const unblocked = unblockNudge(view, memory.seen[view.id], board, byId, roster);
    if (unblocked !== null) nudges.push(unblocked);
    seen[view.id] = { blockedBy: view.blockedBy.map(refKey) };
    const last = memory.nudged[view.id];
    if (last !== undefined) nudged[view.id] = last;
    if (view.activity !== 'stale') continue;
    const staleAfter = cardStaleAfterMs(view, board);
    if (staleAfter === null || (last !== undefined && nowMs - Date.parse(last) < staleAfter)) continue;
    const ferret = nudgeRecipient(view, roster);
    if (ferret === null) continue;
    const idle = nowMs - Date.parse(view.lastTouchedAt ?? view.createdAt);
    nudges.push({
      kind: 'stale',
      taskId: view.id,
      ferret,
      message: nudgeMessage(view, idle, laneName(board, view, view.laneId)),
    });
  }
  return { memory: { v: 1, sweptAt: now, nudged, seen }, nudges, closes, returns };
};

// ---------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------

/** The sweep's memory, as a durable document. */
export interface SweepMemoryStore {
  /** The memory as last written; {@link EMPTY_SWEEP_MEMORY} when there is none or it is damaged. */
  read(): Promise<SweepMemory>;
  write(memory: SweepMemory): Promise<void>;
}

/** Queues a message to a session through the ordinary send path, as the board's. */
interface BoardNudgeSender {
  /** `kind` lets a sender treat a stale nudge (already routed to its recipient) apart from a go-ahead. */
  send(ferret: string, message: string, kind: BoardNudge['kind']): Promise<void>;
}

export interface BoardSweepPorts {
  readonly board: {
    sweepBoard(): Promise<SweepBoard>;
    /** Closes a helper whose ferret ended; `true` when it closed. */
    closeEndedHelper(id: CardId): Promise<boolean>;
    /**
     * Hands a card whose ferret ended to its live lead; `true` when it moved. `settle` holds the standing of the
     * sessions the return rests on and hands the card's write a fresh roster of them (see {@link FerretLivenessGuard}).
     */
    returnToLead(
      id: CardId,
      plan: { readonly lead: string; readonly from: string },
      settle: <T>(work: (fresh: FerretRoster) => Promise<T>) => Promise<T>,
    ): Promise<boolean>;
  };
  readonly sessions: FerretLivenessSource;
  readonly guard: FerretLivenessGuard;
  readonly memory: SweepMemoryStore;
  readonly nudges: BoardNudgeSender;
  readonly clock: BoardClock;
  readonly diagnostics: BoardDiagnostics;
}

/** What one tick did: the stale cards nudged, the cards whose assignee was told to go ahead, and helpers closed. */
export interface SweepReport {
  readonly nudged: readonly CardId[];
  readonly unblocked: readonly CardId[];
  readonly closed: readonly CardId[];
  readonly returned: readonly CardId[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The sweep, one tick at a time. A tick that overlaps a running one does nothing. A nudge is recorded
 * only once it was sent; a go-ahead that could not be sent keeps the card's previous mark, so the next
 * tick says it again. A failure is reported and the rest of the tick goes on.
 */
export class BoardSweep {
  private running = false;

  constructor(private readonly ports: BoardSweepPorts) {}

  async tick(): Promise<SweepReport> {
    if (this.running) return { nudged: [], unblocked: [], closed: [], returned: [] };
    this.running = true;
    try {
      return await this.sweep();
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<SweepReport> {
    const [memory, board, roster] = await Promise.all([
      this.ports.memory.read(),
      this.ports.board.sweepBoard(),
      this.ports.sessions.roster(),
    ]);
    const now = this.ports.clock.now();
    const plan = planSweep(memory, board, roster, now);
    const nudged: CardId[] = [];
    const unblocked: CardId[] = [];
    const seen = { ...plan.memory.seen };
    for (const nudge of plan.nudges) {
      await this.ports.nudges.send(nudge.ferret, nudge.message, nudge.kind).then(
        () => (nudge.kind === 'stale' ? nudged : unblocked).push(nudge.taskId),
        (error: unknown) => {
          const previous = memory.seen[nudge.taskId];
          if (nudge.kind === 'unblocked' && previous !== undefined) seen[nudge.taskId] = previous;
          this.ports.diagnostics.warn(`could not nudge ${nudge.ferret} about &${nudge.taskId}: ${messageOf(error)}`);
        },
      );
    }
    const closed: CardId[] = [];
    for (const id of plan.closes) {
      await this.ports.board.closeEndedHelper(id).then(
        done => {
          if (done) closed.push(id);
        },
        (error: unknown) => this.ports.diagnostics.warn(`could not close helper &${id}: ${messageOf(error)}`),
      );
    }
    const returned: CardId[] = [];
    for (const { id, lead, from } of plan.returns) {
      const line = lineageThrough(roster, from, lead);
      if (line === null) continue;
      await this.ports.board
        .returnToLead(id, { lead, from }, async work => await this.ports.guard.settled(line, work))
        .then(
          done => {
            if (done) returned.push(id);
          },
          (error: unknown) => this.ports.diagnostics.warn(`could not return &${id} to ${lead}: ${messageOf(error)}`),
        );
    }
    const marks = Object.fromEntries(nudged.map(id => [id, now]));
    await this.ports.memory.write({ ...plan.memory, seen, nudged: { ...plan.memory.nudged, ...marks } });
    return { nudged, unblocked, closed, returned };
  }
}
