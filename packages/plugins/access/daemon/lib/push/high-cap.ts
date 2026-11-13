/**
 * The most HIGH-priority pushes in any rolling hour: per ferret, and across the whole daemon (v4
 * `notifications/service.ts`, docs/notifications.md). Past either cap a push still goes, once per card as always, at
 * normal priority. The per-ferret bucket is the tighter one, so a ferret raising card after card spends its own three
 * and never the slots another ferret's real code needs.
 */
export const HIGH_PUSHES_PER_FERRET_PER_HOUR = 3;
export const HIGH_PUSHES_PER_HOUR = 12;
const HOUR_MS = 3_600_000;

/** The one slot a high buzz asked for: whether it keeps high priority, and the way to give the slot back. */
export interface HighSlot {
  /** True when the push may go out at high priority; false when a cap is spent and it goes at normal priority. */
  readonly high: boolean;
  /** Gives the slot back when the push reached no device: a slot is spent only on a push that went out. */
  readonly refund: () => void;
}

/** The clock the cap reads: the kernel's, never `Date.now`. */
export interface HighCapClock {
  nowMs(): number;
}

/**
 * THE HOURLY CAP ON HIGH-PRIORITY PUSHES, held in RAM by whoever builds it (never module-level), so every `buzz` that
 * asks for `urgency: 'high'` passes through ONE counter whichever plugin sent it.
 *
 * {@link take} counts and decides in one synchronous step, with no `await` between the count and the decision, so two
 * buzzes cannot both take the last slot. A high buzz with no ferret counts against the daemon cap only.
 */
export class HighPushCap {
  /** When each recent high push was sent, oldest first, daemon-wide and per ferret: the rolling windows. */
  readonly #sent: number[] = [];
  readonly #sentByFerret = new Map<string, number[]>();

  constructor(private readonly clock: HighCapClock) {}

  take(ferret?: string): HighSlot {
    const now = this.clock.nowMs();
    const recent = (sent: readonly number[]): number[] => sent.filter(at => at > now - HOUR_MS);
    const daemon = recent(this.#sent);
    this.#sent.splice(0, this.#sent.length, ...daemon);
    const own = ferret === undefined ? [] : recent(this.#sentByFerret.get(ferret) ?? []);
    if (ferret !== undefined) {
      if (own.length === 0) this.#sentByFerret.delete(ferret);
      else this.#sentByFerret.set(ferret, own);
    }
    if (own.length >= HIGH_PUSHES_PER_FERRET_PER_HOUR || daemon.length >= HIGH_PUSHES_PER_HOUR) {
      return { high: false, refund: () => undefined };
    }
    this.#sent.push(now);
    if (ferret !== undefined) this.#sentByFerret.set(ferret, [...own, now]);
    let refunded = false;
    return {
      high: true,
      refund: () => {
        if (refunded) return;
        refunded = true;
        this.#drop(this.#sent, now);
        const held = ferret === undefined ? undefined : this.#sentByFerret.get(ferret);
        if (ferret === undefined || held === undefined) return;
        this.#drop(held, now);
        if (held.length === 0) this.#sentByFerret.delete(ferret);
      },
    };
  }

  #drop(sent: number[], at: number): void {
    const index = sent.indexOf(at);
    if (index >= 0) sent.splice(index, 1);
  }
}
