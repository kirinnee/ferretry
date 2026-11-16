/**
 * What this machine's ferrets on a login cost in a period (docs/budgets.md) — the number a budget is judged against.
 *
 * WHY NOT THE INSIGHTS INDEX. The index holds a ferret only once it has STOPPED, and books its whole cost at the instant
 * it was created. A budget has to stop ferrets that are still running, and a lead that runs for three days has to count
 * against the day each turn was made, not the day it started. So the meter asks each ferret's harness for its turns
 * since the start of the period and books each turn at its OWN instant. Nothing is persisted: the harness owns the fact,
 * and a restart reads the period again.
 *
 * WHAT IT COUNTS. Every turn a ferret made, booked to the login the ferret runs on. A turn is booked once: the reader may
 * report an unfinished turn again with a larger figure, and the later report REPLACES the earlier one (keyed by ferret and
 * turn), never adds to it. A ferret whose reader cannot be asked this time keeps what it booked, and its login's amount
 * reads PARTIAL (the view says it may be low, never passes it off as complete).
 *
 * WHAT IT DOES NOT. Requests on the same login from another machine, or from outside Ferretry. A turn whose model has no
 * price is counted as UNPRICED, never as $0.
 *
 * Amounts are kept in 15-minute slots: every zone's offset is a whole number of quarter hours, so any day or week in any
 * zone is an exact run of slots, and a week is at most 672 numbers per login.
 */
import type { TurnUsage } from '@ferretry/core-ferrets/contract';
import { epochMs } from '@ferretry/std';
import type { AnalyticsTokenUsage } from '../analytics/pricing.ts';
import { turnTokenUsage } from '../analytics/turn-fold.ts';

const SLOT_MS = 15 * 60_000;

/** One ferret the meter may read: the login it runs on, or `null` when it names none. */
export interface MeteredFerret {
  readonly id: string;
  readonly login: string | null;
}

export interface SpendMeterPorts {
  /** Every ferret that may have run since `sinceMs`: running, or changed since then. */
  ferrets(sinceMs: number): Promise<readonly MeteredFerret[]>;
  /**
   * A ferret's turns from `sinceIso` on, or `undefined` when its harness cannot be asked (none provides a reader, or the
   * read failed). An unreadable ferret is never an empty one.
   */
  turns(ferret: string, sinceIso: string): Promise<readonly TurnUsage[] | undefined>;
  /** Prices for this refresh: one turn's equivalent cost in micro-dollars, or `undefined` when unpriced. */
  pricing(): Promise<(usage: AnalyticsTokenUsage) => number | undefined>;
}

/** What the ferrets on some logins cost in a span. */
export interface MeteredSpend {
  readonly usdMicros: number;
  /** Turns in the span whose model has no price. */
  readonly unpriced: number;
  /** A ferret on these logins could not be read this time, so the amount may be low. */
  readonly partial: boolean;
}

/** One ferret being tracked: what it booked so far, by login and slot, and whether its last read failed. */
interface FerretTrack {
  login: string | null;
  /** The instant to read from next: the start of the last turn seen (it may still grow). */
  watermarkMs: number;
  unreadable: boolean;
  /** turn → what it was booked as, so a later report of the same turn replaces it. */
  readonly booked: Map<number, { readonly login: string; readonly slot: number; readonly micros: number | undefined }>;
}

export class SpendMeter {
  readonly #tracks = new Map<string, FerretTrack>();
  #sinceMs: number | undefined;
  #measured = false;

  constructor(private readonly ports: SpendMeterPorts) {}

  /** Whether one refresh has finished since the meter was made: before it, every amount reads low. */
  get measured(): boolean {
    return this.#measured;
  }

  /**
   * Read what the ferrets on `logins` did since the last refresh, from `sinceMs` on. A `sinceMs` later than the last one
   * drops what came before it; an earlier one starts the read over.
   */
  async refresh(sinceMs: number, logins: ReadonlySet<string>): Promise<void> {
    if (this.#sinceMs === undefined || sinceMs < this.#sinceMs) this.#tracks.clear();
    else if (sinceMs > this.#sinceMs) this.#prune(sinceMs);
    this.#sinceMs = sinceMs;

    const wanted = (await this.ports.ferrets(sinceMs)).filter(
      ferret => ferret.login !== null && logins.has(ferret.login),
    );
    const price = await this.ports.pricing();
    for (const ferret of wanted) {
      const login = ferret.login as string;
      let track = this.#tracks.get(ferret.id);
      if (track === undefined) {
        track = { login, watermarkMs: sinceMs, unreadable: false, booked: new Map() };
        this.#tracks.set(ferret.id, track);
      }
      track.login = login;
      const turns = await this.ports.turns(ferret.id, new Date(track.watermarkMs).toISOString()).catch(() => undefined);
      if (turns === undefined) {
        track.unreadable = true;
        continue;
      }
      track.unreadable = false;
      for (const turn of turns) {
        const atMs = epochMs(turn.at);
        if (!Number.isFinite(atMs) || atMs < sinceMs) continue;
        track.booked.set(turn.turn, { login, slot: Math.floor(atMs / SLOT_MS), micros: price(turnTokenUsage(turn)) });
      }
      // The next read starts at the latest turn seen: it may still be growing, and is re-reported and replaced.
      const latest = Math.max(sinceMs, ...turns.map(turn => epochMs(turn.at)).filter(Number.isFinite));
      track.watermarkMs = latest;
    }
    this.#measured = true;
  }

  /** What the ferrets on `logins` cost in `[startMs, endMs)`. */
  spent(logins: ReadonlySet<string>, startMs: number, endMs: number): MeteredSpend {
    const first = Math.floor(startMs / SLOT_MS);
    const last = Math.ceil(endMs / SLOT_MS);
    let usdMicros = 0;
    let unpriced = 0;
    let partial = false;
    for (const track of this.#tracks.values()) {
      if (track.unreadable && track.login !== null && logins.has(track.login)) partial = true;
      for (const entry of track.booked.values()) {
        if (!logins.has(entry.login) || entry.slot < first || entry.slot >= last) continue;
        if (entry.micros === undefined) unpriced += 1;
        else usdMicros += entry.micros;
      }
    }
    return { usdMicros, unpriced, partial };
  }

  /** Drop every slot before `sinceMs`: the period moved on. */
  #prune(sinceMs: number): void {
    const first = Math.floor(sinceMs / SLOT_MS);
    for (const track of this.#tracks.values())
      for (const [turn, entry] of track.booked) if (entry.slot < first) track.booked.delete(turn);
  }
}
