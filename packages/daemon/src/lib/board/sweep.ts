/**
 * THE BOARD SWEEP: the board's own tick (`board-design.md` §3.3 nudges, §2.8 quiet events, §2.7
 * unblocks). Owned by the board, not the Warden: it is about cards, and a card's ferret may be perfectly
 * healthy while the card goes stale.
 *
 * Each tick reads the board once, compares it with what the last tick saw ({@link SweepMemory}, a small
 * state file that survives restarts) and does two things:
 *
 * 1. **Nudges a stale card's ferret** with a queued message, through the ordinary send path:
 *    `[board] &F412 untouched 3h in Implement — move it, note why, block it, or drop it`. The assignee
 *    when it is alive and idle; the card's OWNER when the assignee is busy on another card (or gone). At
 *    most once per card per its lane's `staleAfter`; never to a session that declared a wait; never for a
 *    waiting card (a waiting card is not stale, by derivation).
 * 2. **Queues quiet events** in a ferret's pending context (`pending-context.ts`), delivered with its next
 *    turn and never starting one: a child card's move, block, unblock, drop or new blocking ask to its
 *    LEAD — the ferret working the parent card — and `&F20 unblocked: &F18 merged` to a dependent's
 *    assignee once its last blocker ships.
 *
 * The first sight of a card is a baseline, not news: a daemon that boots onto a board with a thousand
 * cards says nothing about any of them. A card created since the last tick is news from its first event.
 *
 * {@link planSweep} is pure; {@link BoardSweep} does the IO through its ports.
 */
import {
  type AgendaRef,
  type BoardTaskEvent,
  type BoardTaskId,
  type BoardTaskView,
  formatTaskRef,
  InstantSchema,
  isBlockerDone,
  laneOf,
  type TaskRef,
} from '@ferretry/protocol';
import { z } from 'zod';
import { cardStaleAfterMs, isWorking, presenceOf, type SessionLivenessSource, type SessionRoster } from './activity.ts';
import { effectiveAssignee } from './authority.ts';
import { cardCategory, type LaneSets } from './graph.ts';
import {
  BOARD_MARK,
  type PendingContext,
  PendingContextDelivery,
  type PendingContextQueue,
  type QuietItem,
} from './pending-context.ts';
import type { BoardClock, BoardDiagnostics } from './ports.ts';

/** How often the daemon sweeps the board. */
export const BOARD_SWEEP_INTERVAL_MS = 60_000;

/** A quiet event's reason, clipped to stay one short line. */
const MAX_REASON_IN_LINE = 80;

const CardMarkSchema = z.strictObject({
  /** The last history event already told. */
  seq: z.number().int().min(0),
  /** Its unfinished blockers, as `machine/id` keys. */
  blockedBy: z.array(z.string()),
  /** Its blocking asks, as `session/id` keys. */
  waiting: z.array(z.string()),
});
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

/** A nudge to send: one queued message to one ferret about one card. */
interface BoardNudge {
  readonly taskId: BoardTaskId;
  readonly sessionId: string;
  readonly message: string;
}

/** A quiet event for one ferret's pending context. */
interface QuietDelivery {
  readonly sessionId: string;
  readonly item: QuietItem;
}

export interface SweepPlan {
  /** The memory to keep, before any nudge is recorded as sent. */
  readonly memory: SweepMemory;
  readonly nudges: readonly BoardNudge[];
  readonly quiet: readonly QuietDelivery[];
}

export interface SweepBoard {
  readonly views: readonly BoardTaskView[];
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
export const nudgeMessage = (card: Pick<BoardTaskView, 'id'>, idleMs: number, lane: string): string =>
  `${BOARD_MARK} ${formatTaskRef(card)} untouched ${formatIdle(idleMs)} in ${lane} — move it, note why, block it, or drop it`;

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= MAX_REASON_IN_LINE ? flat : `${flat.slice(0, MAX_REASON_IN_LINE - 1)}…`;
};

const laneName = (board: SweepBoard, card: Pick<BoardTaskView, 'projectId'>, laneId: string): string => {
  const laneSet = board.laneSets.get(card.projectId);
  const lane = laneSet === undefined ? undefined : laneOf(laneSet, laneId);
  return lane?.ok === true ? lane.value.name : laneId;
};

const refKey = (ref: TaskRef): string => `${ref.machineId ?? ''}/${ref.id}`;
const askKey = (ref: AgendaRef): string => `${ref.sessionId}/${ref.id}`;
const askRef = (key: string): string => `!${key.slice(key.lastIndexOf('/') + 1)}`;

// ---------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------

const isOpen = (view: BoardTaskView, board: SweepBoard): boolean =>
  view.dropped === null && cardCategory(view, board.laneSets) !== 'closed';

/**
 * Who hears a card's quiet events: the ferret working its parent card, else the card's owner when
 * somebody else does the card. Nobody for a top-level card, and never the card's own ferret.
 */
export const leadOf = (view: BoardTaskView, byId: ReadonlyMap<BoardTaskId, BoardTaskView>): string | null => {
  if (view.parent === null) return null;
  const parent = localView(view, view.parent, byId);
  const lead = parent === undefined ? view.owner : effectiveAssignee(parent);
  return lead === effectiveAssignee(view) ? null : lead;
};

/** The card a ref names on this card's own machine; `undefined` for one elsewhere or not here. */
const localView = (
  view: Pick<BoardTaskView, 'machineId'>,
  ref: TaskRef,
  byId: ReadonlyMap<BoardTaskId, BoardTaskView>,
): BoardTaskView | undefined =>
  ref.machineId === undefined || ref.machineId === view.machineId ? byId.get(ref.id) : undefined;

/** A history event, as a quiet item, or `null` for an event the lead does not need. */
const eventItem = (view: BoardTaskView, event: BoardTaskEvent, board: SweepBoard): QuietItem | null => {
  const ref = formatTaskRef(view);
  const item = (key: string, text: string): QuietItem => ({ key: `${view.id}:${key}`, text, at: event.at });
  switch (event.type) {
    case 'moved': {
      const pr = view.links.prs.at(-1);
      const fromPr = event.trigger?.startsWith('pr.') === true || event.trigger === 'ci.green';
      const suffix = fromPr && pr !== undefined ? ` (PR #${pr.number})` : '';
      return item('lane', `${ref} → ${laneName(board, view, event.to)}${suffix}`);
    }
    case 'reopened':
      return item('lane', `${ref} reopened → ${laneName(board, view, event.to)}: ${oneLine(event.reason)}`);
    case 'dropped':
      return item('lane', `${ref} dropped: ${oneLine(event.reason)}`);
    case 'blocked':
      return item('block', `${ref} blocked: ${oneLine(event.reason)}`);
    case 'unblocked':
      return item('block', `${ref} unblocked`);
    default:
      return null;
  }
};

/** The blockers that left `previous` because they shipped, as `&F18 merged`. */
const shippedBlockers = (
  view: BoardTaskView,
  previous: readonly string[],
  board: SweepBoard,
  byId: ReadonlyMap<BoardTaskId, BoardTaskView>,
): readonly string[] => {
  const words: string[] = [];
  for (const dependency of view.dependsOn) {
    if (dependency.override !== undefined || !previous.includes(refKey(dependency.task))) continue;
    const blocker = localView(view, dependency.task, byId);
    if (blocker === undefined) continue;
    const category = cardCategory(blocker, board.laneSets);
    if (category === undefined || !isBlockerDone(category, dependency.until, blocker.shippedIn !== null)) continue;
    words.push(`${formatTaskRef(blocker)} ${laneName(board, blocker, blocker.laneId).toLowerCase()}`);
  }
  return words;
};

/** The quiet events one card makes since `mark`. */
const cardQuiet = (
  view: BoardTaskView,
  mark: CardMark,
  board: SweepBoard,
  byId: ReadonlyMap<BoardTaskId, BoardTaskView>,
  at: string,
): readonly QuietDelivery[] => {
  const deliveries: QuietDelivery[] = [];
  const ref = formatTaskRef(view);
  const lead = leadOf(view, byId);
  if (lead !== null) {
    for (const event of view.history) {
      if (event.seq <= mark.seq || event.actor.sessionId === lead) continue;
      const item = eventItem(view, event, board);
      if (item !== null) deliveries.push({ sessionId: lead, item });
    }
  }
  if (lead !== null && mark.blockedBy.length === 0 && view.blockedBy.length > 0) {
    const on = view.blockedBy.map(formatTaskRef).join(', ');
    deliveries.push({ sessionId: lead, item: { key: `${view.id}:deps`, text: `${ref} waiting on ${on}`, at } });
  }
  if (mark.blockedBy.length > 0 && view.blockedBy.length === 0) {
    const shipped = shippedBlockers(view, mark.blockedBy, board, byId);
    const text = shipped.length === 0 ? `${ref} unblocked` : `${ref} unblocked: ${shipped.join(', ')}`;
    if (lead !== null) deliveries.push({ sessionId: lead, item: { key: `${view.id}:deps`, text, at } });
    if (shipped.length > 0) {
      deliveries.push({ sessionId: effectiveAssignee(view), item: { key: `${view.id}:unblocked`, text, at } });
    }
  }
  const asked = view.waitingOnOwner.map(askKey).filter(key => !mark.waiting.includes(key));
  if (lead !== null && asked.length > 0) {
    const text = `${ref} waiting on owner (${asked.map(askRef).join(', ')})`;
    deliveries.push({ sessionId: lead, item: { key: `${view.id}:asks`, text, at } });
  }
  return deliveries;
};

/** Who a stale card's nudge goes to, or `null` when nobody should be nudged now. */
export const nudgeRecipient = (view: BoardTaskView, roster: SessionRoster): string | null => {
  const assignee = effectiveAssignee(view);
  const doing = roster.sessions.get(assignee);
  if (doing !== undefined && presenceOf(roster, assignee) === 'alive') {
    if (doing.declaredWait) return null;
    if (!isWorking(doing)) return assignee;
  } else if (presenceOf(roster, assignee) === 'unknown') {
    return null;
  }
  // Busy on another card, or gone: the card's owner answers for it.
  const owner = roster.sessions.get(view.owner);
  if (view.owner === assignee || owner === undefined || presenceOf(roster, view.owner) !== 'alive') return null;
  return owner.declaredWait ? null : view.owner;
};

/** One tick's decisions. Pure. */
export const planSweep = (memory: SweepMemory, board: SweepBoard, roster: SessionRoster, now: string): SweepPlan => {
  const nowMs = Date.parse(now);
  const byId = new Map(board.views.map(view => [view.id, view]));
  const seen: Record<string, CardMark> = {};
  const nudged: Record<string, string> = {};
  const quiet: QuietDelivery[] = [];
  const nudges: BoardNudge[] = [];
  for (const view of board.views) {
    const open = isOpen(view, board);
    const known = memory.seen[view.id];
    const fresh = memory.sweptAt !== null && Date.parse(view.createdAt) > Date.parse(memory.sweptAt);
    const mark = known ?? (fresh ? { seq: 0, blockedBy: [], waiting: [] } : undefined);
    if (mark !== undefined && (open || known !== undefined)) {
      quiet.push(...cardQuiet(view, mark, board, byId, now).filter(each => roster.held.has(each.sessionId)));
    }
    if (!open) continue;
    seen[view.id] = {
      seq: view.history.at(-1)?.seq ?? 0,
      blockedBy: view.blockedBy.map(refKey),
      waiting: view.waitingOnOwner.map(askKey),
    };
    const last = memory.nudged[view.id];
    if (last !== undefined) nudged[view.id] = last;
    if (view.activity !== 'stale') continue;
    const staleAfter = cardStaleAfterMs(view, board);
    if (staleAfter === null || (last !== undefined && nowMs - Date.parse(last) < staleAfter)) continue;
    const sessionId = nudgeRecipient(view, roster);
    if (sessionId === null) continue;
    const idle = nowMs - Date.parse(view.lastTouchedAt ?? view.createdAt);
    nudges.push({ taskId: view.id, sessionId, message: nudgeMessage(view, idle, laneName(board, view, view.laneId)) });
  }
  return { memory: { v: 1, sweptAt: now, nudged, seen }, nudges, quiet };
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

/** Queues a message to a session through the ordinary send path. */
interface BoardNudgeSender {
  send(sessionId: string, message: string): Promise<void>;
}

export interface BoardSweepPorts {
  readonly board: { sweepBoard(): Promise<SweepBoard> };
  readonly sessions: SessionLivenessSource;
  readonly memory: SweepMemoryStore;
  /** Where quiet events wait for their ferret's next turn. */
  readonly quiet: PendingContext;
  /** What a nudge takes from on its way out: usually the same store as {@link quiet}. */
  readonly context: PendingContextQueue;
  readonly nudges: BoardNudgeSender;
  readonly clock: BoardClock;
  readonly diagnostics: BoardDiagnostics;
}

/** What one tick did. */
export interface SweepReport {
  readonly nudged: readonly BoardTaskId[];
  readonly quiet: number;
}

const groupBySession = (quiet: readonly QuietDelivery[]): ReadonlyMap<string, readonly QuietItem[]> => {
  const grouped = new Map<string, QuietItem[]>();
  for (const { sessionId, item } of quiet) {
    const list = grouped.get(sessionId);
    if (list === undefined) grouped.set(sessionId, [item]);
    else list.push(item);
  }
  return grouped;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The sweep, one tick at a time. A tick that overlaps a running one does nothing. A nudge is recorded
 * only once it was sent, and carries the recipient's pending context on top; a quiet event that cannot be
 * queued, or a nudge that cannot be sent, is reported and the rest of the tick goes on.
 */
export class BoardSweep {
  private running = false;

  constructor(private readonly ports: BoardSweepPorts) {}

  async tick(): Promise<SweepReport> {
    if (this.running) return { nudged: [], quiet: 0 };
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
    let quiet = 0;
    for (const [sessionId, items] of groupBySession(plan.quiet)) {
      await this.ports.quiet.append(sessionId, items).then(
        () => {
          quiet += items.length;
        },
        (error: unknown) =>
          this.ports.diagnostics.warn(`could not queue board events for ${sessionId}: ${messageOf(error)}`),
      );
    }
    const delivery = new PendingContextDelivery(this.ports.context);
    const nudged: BoardTaskId[] = [];
    for (const nudge of plan.nudges) {
      await delivery
        .send(nudge.sessionId, nudge.message, async message => await this.ports.nudges.send(nudge.sessionId, message))
        .then(
          () => nudged.push(nudge.taskId),
          (error: unknown) =>
            this.ports.diagnostics.warn(
              `could not nudge ${nudge.sessionId} about &${nudge.taskId}: ${messageOf(error)}`,
            ),
        );
    }
    const marks = Object.fromEntries(nudged.map(id => [id, now]));
    await this.ports.memory.write({ ...plan.memory, nudged: { ...plan.memory.nudged, ...marks } });
    return { nudged, quiet };
  }
}
