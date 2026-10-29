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

export class WardenLivenessMonitor {
  private readonly tracks = new Map<string, LivenessTrack>();
  /** When each ferret was last looked at. */
  private readonly sampledAt = new Map<string, number>();
  private armedAtMs: number | undefined;
  private lastTickMs: number | undefined;

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
    for (const id of [...this.tracks.keys()]) {
      if (present.has(id)) continue;
      this.tracks.delete(id);
      this.sampledAt.delete(id);
    }
    const events: ReflexEvent[] = [];
    for (const target of targets) {
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
      if (sample.paneHash !== undefined || sample.transcriptHash !== undefined) this.sampledAt.set(target.id, nowMs);
      if (step.nudge) events.push({ sessionId: target.id, kind: 'nudge', assessment: step.assessment });
      if (step.frozen) events.push({ sessionId: target.id, kind: 'frozen', assessment: step.assessment });
    }
    return events;
  }

  /** The ledger the monitor has built for a ferret, or `undefined` when it has none. */
  ledger(sessionId: string): WardenLivenessLedger | undefined {
    return this.tracks.get(sessionId)?.ledger;
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
   * Whether the monitor is watching a ferret: armed, and it has looked at it within three ticks — or it
   * is still inside its first three ticks, before which no ferret can have been looked at.
   */
  watching(sessionId: string): boolean {
    if (this.armedAtMs === undefined) return false;
    const nowMs = this.ports.nowMs();
    const window = 3 * this.tickSeconds * 1000;
    if (nowMs - this.armedAtMs < window) return true;
    const at = this.sampledAt.get(sessionId);
    return at !== undefined && nowMs - at < window;
  }
}
