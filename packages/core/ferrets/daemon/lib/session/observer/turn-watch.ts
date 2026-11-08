import type { SessionTurnState } from '../../protocol/session.ts';
import type { SessionId } from '../../session-id.ts';
import {
  isTurnStatus,
  type SessionTurnPorts,
  type SessionTurnWatcher,
  TURN_WATCH_INTERVAL_MS,
  type TurnObservation,
  type TurnWatchReport,
  type TurnWatchSession,
} from '../peers/turn.ts';
import { stepTurn, type TurnFacts, type TurnLook, type TurnStateChange } from './turn.ts';

/** The longest a quiet pane waits between two looks (RULING #44: 2 s up to 10 s, back to 2 s on any change). */
export const TURN_WATCH_QUIET_MAX_MS = 10_000;

/**
 * How long a pane waits before its next look: back to the 2 s tick on anything that moved, and one tick longer each
 * time a look found it quiet, up to {@link TURN_WATCH_QUIET_MAX_MS}. Pure.
 */
export function nextLookDelayMs(delayMs: number, quiet: boolean): number {
  if (!quiet) return TURN_WATCH_INTERVAL_MS;
  return Math.min(TURN_WATCH_QUIET_MAX_MS, Math.max(TURN_WATCH_INTERVAL_MS, delayMs) + TURN_WATCH_INTERVAL_MS);
}

/** What a session's pace remembers: how long it waits, when it is next due, the frame and facts it last saw. */
interface Pace {
  readonly delayMs: number;
  readonly dueMs: number;
  readonly frame: string | undefined;
  readonly facts: string;
}

/** The ports the paced watch reads through: today's turn ports, plus the hand-back to the loop and the failure sink. */
export interface PacedTurnPorts extends SessionTurnPorts {
  /** Hands the event loop back (one pane per turn of the loop): no tick is one long synchronous slice. */
  yieldToLoop(): Promise<void>;
  /**
   * Told of a session a tick could not decide, so the host can say so; the tick goes on with the next one. A failure
   * {@link failureKey} names is told ONCE, until its key changes or the session records a turn again.
   */
  failed?(id: SessionId, error: unknown): void;
  /**
   * What makes a failure the SAME failure (a damaged document: its file and a digest of what is wrong with it), or
   * `undefined` for one that is told every time it happens. No key, no dedupe.
   */
  failureKey?(error: unknown): string | undefined;
}

/** The frame identity a look carries: its digest, `absent` for no pane, `undefined` when the runner gave none. */
function frameOf(look: TurnLook | undefined): string | undefined {
  if (look === undefined) return undefined;
  return look.pane === undefined ? 'absent' : look.pane.frame;
}

/** Everything a recorded fact a look decides against: a change to any of them is a reason to look again at once. */
function factsKey(facts: TurnFacts): string {
  return JSON.stringify([
    facts.status,
    facts.turn,
    facts.pendingQuestion ?? null,
    facts.turnState ?? null,
    facts.turnPrompt ?? null,
    facts.permissionRequest?.id ?? null,
    facts.harnessDialog?.id ?? null,
  ]);
}

/** Whether the next look could decide nothing new: what was seen agrees with what is recorded. */
function settled(observation: TurnObservation | undefined, recorded: SessionTurnState | undefined): boolean {
  return observation === undefined || observation.state === recorded;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * THE TURN WATCH, PACED PER PANE — today's `SessionTurnWatcher` (`lib/session/turn/service.ts`), the one owner of
 * `turnState`, run on the main thread at today's 2 s tick (RULING #44, the inline host instead of a worker per ferret).
 *
 * WHAT IS NEW: IDLE BACK-OFF. Today a quiet pane cost nothing on the main thread because its worker slept until tmux
 * said it drew. Here the tick looks, so a pane whose frame did not change, whose recorded facts did not change and
 * whose look decided nothing waits one tick longer before its next look, up to 10 s; a recorded fact that moves — a
 * recorded turn, a send that recorded `working` — brings it back to 2 s at once, and a redraw is seen at the next
 * look that is due (so a short turn that starts and ends inside a backed-off pane's wait is missed; GAP(observer)).
 * A session the tick could not decide (a damaged document) waits the full 10 s, not one tick. A pane that is drawing (a spinner, a
 * clock) changes every frame and is looked at every 2 s, exactly as today's worker throttle did. The two-frame
 * confirmation of an unconfirmed `your-turn` is never slowed: an observation that disagrees with the record is not
 * quiet.
 *
 * NO LONG BLOCK: one session at a time, the loop handed back between every two (`yieldToLoop`), so a tick over a large
 * fleet is many short slices, never one long one.
 *
 * Everything else is today's: one session at a time, a tick never overlaps the next, the previous observation is the
 * only memory, and a failure is reported per session while the others are still watched.
 */
export class PacedTurnWatcher implements SessionTurnWatcher {
  readonly intervalMs = TURN_WATCH_INTERVAL_MS;
  private readonly previous = new Map<SessionId, TurnObservation | undefined>();
  private readonly paces = new Map<SessionId, Pace>();
  /** How many times each session was woken: a look compares it across itself, so a wake it overlapped is kept. */
  private readonly wakes = new Map<SessionId, number>();
  /** The key of the failure last told per session (see {@link tell}). */
  private readonly told = new Map<SessionId, string>();
  private running = false;

  constructor(private readonly ports: PacedTurnPorts) {}

  async run(): Promise<TurnWatchReport | undefined> {
    // A tick slower than the interval must not overlap the next one: two would race the same record.
    if (this.running) return undefined;
    this.running = true;
    try {
      return await this.tick();
    } catch {
      return undefined;
    } finally {
      this.running = false;
    }
  }

  async tick(): Promise<TurnWatchReport> {
    const sessions = await this.ports.sessions();
    const changed = new Map<SessionId, TurnStateChange>();
    const failures = new Map<SessionId, string>();
    for (const session of sessions) {
      try {
        const change = await this.watch(session);
        if (change !== undefined) changed.set(session.id, change);
      } catch (error) {
        failures.set(session.id, message(error));
        this.backOff(session);
        this.tell(session.id, error);
      }
      await this.ports.yieldToLoop();
    }
    const roster = new Set(sessions.map(session => session.id));
    for (const id of this.previous.keys()) if (!roster.has(id)) this.previous.delete(id);
    for (const id of this.paces.keys()) if (!roster.has(id)) this.paces.delete(id);
    for (const id of this.told.keys()) if (!roster.has(id)) this.told.delete(id);
    for (const id of this.wakes.keys()) if (!roster.has(id)) this.wakes.delete(id);
    return { changed, failures };
  }

  /**
   * Tells the host of a failure, once per distinct failure: one damaged `state.json` is said once, not on every look
   * that meets it again, and said again only when what is wrong with it changes (its key), or after the session recorded
   * a turn (it was mended) and then broke again. A failure with no key is told every time.
   */
  private tell(id: SessionId, error: unknown): void {
    let key: string | undefined;
    try {
      key = this.ports.failureKey?.(error);
    } catch {}
    if (key !== undefined && this.told.get(id) === key) return;
    if (key === undefined) this.told.delete(id);
    else this.told.set(id, key);
    try {
      this.ports.failed?.(id, error);
    } catch {}
  }

  /**
   * A session this tick could not decide (a damaged document, a refused write) waits the longest quiet wait before
   * its next look, so it is looked at once per {@link TURN_WATCH_QUIET_MAX_MS} and not on every tick (and told once:
   * {@link tell}). Anything recorded about it that moves (its facts) still brings it back at once.
   */
  private backOff(session: TurnWatchSession): void {
    const nowMs = Date.parse(this.ports.clock.now());
    const previous = this.paces.get(session.id);
    this.paces.set(session.id, {
      delayMs: TURN_WATCH_QUIET_MAX_MS,
      dueMs: nowMs + TURN_WATCH_QUIET_MAX_MS - TURN_WATCH_INTERVAL_MS / 2,
      frame: previous?.frame,
      facts: factsKey(session.state),
    });
  }

  /**
   * Something the watch did not see happened to this session's pane (Ferrets typed into it): forget its pace, so its next
   * look is due on the next tick and the wait starts over at 2 s. A session never seen is left as it is. A wake that lands
   * while that session's look is in flight is not lost: that look's pace was decided before the delivery, so it keeps
   * no frame and is due again on the next tick.
   */
  wake(id: SessionId): void {
    this.paces.delete(id);
    this.wakes.set(id, (this.wakes.get(id) ?? 0) + 1);
  }

  /** How long the session waits between looks now (for the live readout and tests); `undefined` before its first. */
  delayOf(id: SessionId): number | undefined {
    return this.paces.get(id)?.delayMs;
  }

  private async watch(session: TurnWatchSession): Promise<TurnStateChange | undefined> {
    const live = isTurnStatus(session.state.status);
    const nowMs = Date.parse(this.ports.clock.now());
    const facts = factsKey(session.state);
    const pace = this.paces.get(session.id);
    // Not due yet, and nothing recorded about it moved: this tick leaves it alone.
    if (live && pace !== undefined && pace.facts === facts && nowMs < pace.dueMs) return undefined;
    const woken = this.wakes.get(session.id);
    let look: TurnLook | undefined;
    if (live) {
      const [transcript, pane] = await Promise.all([this.ports.transcript(session.id), this.ports.pane(session.id)]);
      look = { transcript, pane };
    }
    const before = this.previous.get(session.id);
    const step = stepTurn(session.state, before, look);
    this.previous.set(session.id, step.observation);
    const change = step.change;
    const frame = frameOf(look);
    const quiet =
      pace !== undefined &&
      frame !== undefined &&
      pace.frame === frame &&
      pace.facts === facts &&
      change === undefined &&
      settled(step.observation, session.state.turnState);
    // Woken while this look was out: what it saw is from before the delivery, so the next tick looks again, afresh.
    const wokenSince = this.wakes.get(session.id) !== woken;
    const delayMs = wokenSince
      ? TURN_WATCH_INTERVAL_MS
      : nextLookDelayMs(pace?.delayMs ?? TURN_WATCH_INTERVAL_MS, quiet);
    // Due half a tick early, so a timer that fires a little late never costs a pane a whole extra tick.
    this.paces.set(session.id, {
      delayMs,
      dueMs: nowMs + delayMs - TURN_WATCH_INTERVAL_MS / 2,
      frame: wokenSince ? undefined : frame,
      facts,
    });
    if (change === undefined) return undefined;
    const recorded = await this.ports.record(session.id, change, this.ports.clock.now());
    // The writer read the document under its lock and did not throw: whatever was wrong with it has been mended.
    this.told.delete(session.id);
    return recorded ? change : undefined;
  }
}
