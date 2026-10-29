/**
 * The liveness monitor: one look at every working ferret per tick, folded into a ledger per ferret, and
 * the reflex step over it.
 *
 * WHAT IT FEEDS. The sweep reads {@link WardenLivenessMonitor.ledger} as the ferret's liveness ledger —
 * so the sus classifiers finally reason over real evidence — and {@link WardenLivenessMonitor.watching}
 * as "this daemon holds a live monitor for it": a working ferret it could not look at recently is the
 * `dead_monitor` it always claimed to be, rather than every ferret at once.
 *
 * WHAT IT DOES ITSELF. Nothing but report. A tick answers which ferrets the reflex would nudge and which
 * it has just confirmed frozen; the composition root nudges only when the owner let the Warden nudge,
 * and a frozen ferret becomes a flag. It never stops, kills or relaunches anything.
 *
 * IN MEMORY ON PURPOSE, as kteam's was: a restarted daemon starts every ferret's clock again rather than
 * judging it on silence it did not observe. A ferret that stops working, finishes or leaves the fleet
 * is forgotten.
 *
 * ═══ UNWATCHED IS COUNTED IN LOOKS, NOT IN WALL-CLOCK TIME ═══
 *
 * A ferret is unwatched after {@link MISSED_LOOKS_LIMIT} on-time looks in a row saw nothing of it — never
 * because time passed. Measured in time, two things that are not a ferret's fault read as one fault per
 * ferret (both seen on 2026-10-29): a starved host, whose ticks ran minutes late, aged EVERY ferret out
 * together and raised fifteen `dead_monitor` flags in one sweep, twice; and a ferret started between
 * two ticks was "not looked at recently" seconds after it was born. A look the host starved, and a tick
 * in which every ferret came back blind, are the monitor's own failure: they count against
 * {@link WardenLivenessMonitor.stalled}, which the sweep reports as ONE daemon fault, never per ferret.
 */

import type { SessionTurnState } from '@ferretry/protocol';
import { ACTIVE_MONITORED } from './detect.ts';
import {
  foldLivenessSample,
  type LivenessSample,
  type LivenessTrack,
  type ReflexAssessment,
  reflexSettingsFor,
  reflexStep,
} from './liveness.ts';
import { waitingOnOwner } from './sus.ts';
import type { WardenLivenessLedger, WardenSessionStatus } from './types.ts';

/** One ferret the monitor may look at. */
export interface LivenessTarget {
  readonly id: string;
  readonly status: WardenSessionStatus;
  readonly turn: number;
  readonly mode: 'auto' | 'interactive';
  /** A declared wait: the ferret said it is parked, so silence is expected. */
  readonly waiting: boolean;
  /** Whose move it is. A ferret whose turn is over waits on its owner: its silence is expected too. */
  readonly turnState?: SessionTurnState;
  readonly nudgeAfterSeconds?: number;
  readonly killAfterSeconds?: number;
  /** The tmux session its pane lives in, when it has one. */
  readonly tmuxSession?: string;
}

export interface WardenLivenessPorts {
  /** Every ferret this daemon runs, warden sessions excluded. */
  targets(): Promise<readonly LivenessTarget[]>;
  /** One look at a ferret. Total: what could not be read is left undefined. */
  sample(target: LivenessTarget): Promise<LivenessSample>;
  nowMs(): number;
}

/** What one tick found worth acting on. */
export interface ReflexEvent {
  readonly sessionId: string;
  readonly kind: 'nudge' | 'frozen';
  readonly assessment: ReflexAssessment;
}

/** A tick is late enough to discount when it ran this long after it was due. */
export const LIVENESS_LAG_MS = 30_000;

/** On-time looks in a row that saw nothing of a ferret before it counts as unwatched. */
export const MISSED_LOOKS_LIMIT = 3;

/** Ticks without one that saw anything before the monitor itself counts as stalled: five minutes at 30 s. */
export const STALLED_TICKS = 10;

export class WardenLivenessMonitor {
  private readonly tracks = new Map<string, LivenessTrack>();
  /** On-time looks in a row that saw nothing of each ferret. Absent: never missed, or not looked at yet. */
  private readonly missedLooks = new Map<string, number>();
  /** When this daemon first looked at each working ferret, this run. */
  private readonly firstLookAt = new Map<string, number>();
  private armedAtMs: number | undefined;
  private lastTickMs: number | undefined;
  /** When the last tick that saw anything finished — however late: the monitor is alive while it sees. */
  private lastSightedTickMs: number | undefined;

  constructor(
    private readonly ports: WardenLivenessPorts,
    readonly tickSeconds: number,
  ) {}

  /** Start the grace period: until a tick has had the chance to run, every ferret counts as watched. */
  arm(): void {
    this.armedAtMs = this.ports.nowMs();
  }

  disarm(): void {
    this.armedAtMs = undefined;
    this.lastSightedTickMs = undefined;
  }

  /**
   * One tick. A tick that runs well after it was due — the host was starved — moves every ferret's
   * anchor to now instead of judging it: the silence it would measure is partly the machine's.
   */
  async tick(options: { readonly nudgeAllowed: boolean }): Promise<readonly ReflexEvent[]> {
    const nowMs = this.ports.nowMs();
    const late = this.lastTickMs !== undefined && nowMs - this.lastTickMs - this.tickSeconds * 1000 >= LIVENESS_LAG_MS;
    this.lastTickMs = nowMs;
    const targets = (await this.ports.targets()).filter(target => ACTIVE_MONITORED.includes(target.status));
    const present = new Set(targets.map(target => target.id));
    for (const id of new Set([...this.tracks.keys(), ...this.missedLooks.keys(), ...this.firstLookAt.keys()])) {
      if (present.has(id)) continue;
      this.tracks.delete(id);
      this.missedLooks.delete(id);
      this.firstLookAt.delete(id);
    }
    const events: ReflexEvent[] = [];
    const blind: string[] = [];
    for (const target of targets) {
      if (!this.firstLookAt.has(target.id)) this.firstLookAt.set(target.id, nowMs);
      const sample = await this.ports.sample(target).catch((): LivenessSample => ({}));
      const folded = foldLivenessSample(this.tracks.get(target.id), sample, target.turn, nowMs);
      const anchored = late ? { ...folded, anchorAt: new Date(nowMs).toISOString(), frozenTicks: 0 } : folded;
      const step = reflexStep(anchored, nowMs, reflexSettingsFor(target, this.tickSeconds), {
        nudgeAllowed: options.nudgeAllowed,
        // A ferret at its prompt or on a question is waiting on its owner: a nudge would only type into
        // their conversation. (Its helpers used to look like a live subprocess and hid this.)
        suspended: late || target.waiting || target.mode === 'interactive' || waitingOnOwner(target.turnState, false),
      });
      this.tracks.set(target.id, step.track);
      // Watched only when the look SAW something: a ferret whose screen and transcript both could not be
      // read is exactly the one nothing is watching.
      if (sample.paneHash !== undefined || sample.transcriptHash !== undefined) this.missedLooks.delete(target.id);
      else blind.push(target.id);
      if (step.nudge) events.push({ sessionId: target.id, kind: 'nudge', assessment: step.assessment });
      if (step.frozen) events.push({ sessionId: target.id, kind: 'frozen', assessment: step.assessment });
    }
    // A tick blind to EVERY ferret of several failed as a whole: the monitor's (or the host's) fault, not
    // any one ferret's — `stalled` says it once if it lasts. A tick that started late or ran long saw a
    // starved host, so its blind looks are counted against no ferret either.
    const endMs = this.ports.nowMs();
    const blindToAll = targets.length >= 2 && blind.length === targets.length;
    if (!blindToAll) this.lastSightedTickMs = endMs;
    if (!blindToAll && !late && endMs - nowMs < LIVENESS_LAG_MS)
      for (const id of blind) this.missedLooks.set(id, (this.missedLooks.get(id) ?? 0) + 1);
    return events;
  }

  /**
   * Whether the monitor itself has stopped seeing: armed, and no tick that saw anything — however late —
   * has finished for {@link STALLED_TICKS} ticks (since it was armed, when none has). While it is stalled
   * no ferret is watched, and that is ONE fault of this daemon, not one per ferret.
   */
  stalled(): boolean {
    if (this.armedAtMs === undefined) return false;
    const since = this.lastSightedTickMs ?? this.armedAtMs;
    return this.ports.nowMs() - since >= STALLED_TICKS * this.tickSeconds * 1000;
  }

  /** The ledger the monitor has built for a ferret, or `undefined` when it has none. */
  ledger(sessionId: string): WardenLivenessLedger | undefined {
    return this.tracks.get(sessionId)?.ledger;
  }

  /**
   * When this daemon first looked at a working ferret, this run — or `undefined` before any tick has.
   * The sus classifiers measure silence from no earlier than this: silence a restarted daemon did not
   * observe (its documents' last transcript instant is from before the restart) is no evidence.
   */
  observedSince(sessionId: string): string | undefined {
    const at = this.firstLookAt.get(sessionId);
    return at === undefined ? undefined : new Date(at).toISOString();
  }

  /** Since when a browser the ferret launched has been running under its pane, this turn. */
  leftoverBrowserSince(sessionId: string): string | undefined {
    return this.tracks.get(sessionId)?.leftoverBrowserSince;
  }

  /** When the ferret was confirmed frozen, this episode. */
  frozenAt(sessionId: string): string | undefined {
    return this.tracks.get(sessionId)?.frozenAt;
  }

  /**
   * Whether the monitor is watching a ferret: armed, still inside its first three ticks (before which no
   * ferret can have been looked at), or not {@link stalled} and fewer than {@link MISSED_LOOKS_LIMIT}
   * on-time looks in a row saw nothing of it. A ferret no tick has reached yet — one started since the
   * last — has missed nothing, so it is watched.
   */
  watching(sessionId: string): boolean {
    if (this.armedAtMs === undefined) return false;
    if (this.ports.nowMs() - this.armedAtMs < MISSED_LOOKS_LIMIT * this.tickSeconds * 1000) return true;
    if (this.stalled()) return false;
    return (this.missedLooks.get(sessionId) ?? 0) < MISSED_LOOKS_LIMIT;
  }
}
