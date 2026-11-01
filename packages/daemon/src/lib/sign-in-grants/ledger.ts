import type { GrantMissReason, LoginFieldRole, SignInId } from '@ferretry/protocol';
import { SECOND_FACTOR_WINDOW_MS } from '../input-requests/login-observer.ts';

/**
 * USES, ATTEMPTS AND THE RATE LIMIT of grant fills (docs/input-requests.md, "Task plan fills"). In memory: a restart
 * forgets it along with every plan.
 *
 * - **Synchronous.** {@link SignInGrantLedger.reserve} runs inside the session lock right before the write, and counts
 *   what is reserved and not yet settled, so two raises can never both spend a line's last use (the paste rules'
 *   pattern). {@link SignInGrantLedger.spent} and {@link SignInGrantLedger.release} settle a reservation once.
 * - **One use is one sign-in attempt, and each ROLE is typed once per use.** An attempt opens at the first fill under a
 *   grant and records the roles it typed (username, password, code). A later fill joins it, for no new use, only within
 *   {@link SECOND_FACTOR_WINDOW_MS} and only when it types no role the attempt already typed. So username page →
 *   password page → code page within three minutes is ONE use, and a second password (a "confirm your password" form)
 *   always needs a use of its own.
 * - **Rate.** At most {@link FILLS_PER_HOUR_PER_SIGN_IN} fills an hour of one sign-in, across every grant, and
 *   {@link FILLS_PER_HOUR_PER_SESSION} grant fills an hour in one session. Over either: `rate`.
 * - **Pins.** The form identity each field set was first filled with, per grant: every later fill must equal it.
 */

/** The most grant fills of one sign-in in an hour, across every grant and session. */
export const FILLS_PER_HOUR_PER_SIGN_IN = 10;
/** The most grant fills in one session in an hour. */
export const FILLS_PER_HOUR_PER_SESSION = 30;
const HOUR_MS = 3_600_000;

/** What a reservation is for: one grant, its sign-in, the session asking, and the uses it has left now. */
export interface LedgerGrant {
  readonly id: string;
  readonly signIn: SignInId;
  readonly remaining: number;
}

/** A fill held against the ledger until it is spent or released. */
export interface GrantReservation {
  readonly grant: string;
  readonly signIn: SignInId;
  readonly sessionId: string;
  /** The roles this fill types. */
  readonly roles: readonly LoginFieldRole[];
  /** The field set its form identity is pinned for. */
  readonly fieldSet: string;
  /** This fill opens a new attempt, so it spends a use. */
  readonly opens: boolean;
  readonly at: number;
}

interface Attempt {
  readonly opened: number;
  readonly roles: Set<LoginFieldRole>;
}

const recent = (times: readonly number[] | undefined, now: number): number[] =>
  (times ?? []).filter(at => at > now - HOUR_MS);

export class SignInGrantLedger {
  readonly #attempts = new Map<string, Attempt>();
  readonly #pins = new Map<string, Map<string, string>>();
  readonly #bySignIn = new Map<SignInId, number[]>();
  readonly #bySession = new Map<string, number[]>();
  readonly #open = new Set<GrantReservation>();

  /** Whether a grant has an attempt open now: a later step of that sign-in may still join it. */
  joinable(grant: string, now: number): boolean {
    const attempt = this.#attempts.get(grant);
    return attempt !== undefined && now - attempt.opened < SECOND_FACTOR_WINDOW_MS;
  }

  /**
   * Holds one fill typing `roles` under `grant`, or says why it can't: `used-up` when it would open an attempt and no use
   * is left (counting those already reserved), `rate` when the sign-in or the session is over its hourly limit. A fill
   * joins the open attempt only when none of its roles was typed in it, or is being typed by a fill still in flight.
   */
  reserve(
    grant: LedgerGrant,
    sessionId: string,
    roles: readonly LoginFieldRole[],
    fieldSet: string,
    now: number,
  ): GrantReservation | GrantMissReason {
    const pending = [...this.#open];
    const attempt = this.#attempts.get(grant.id);
    const typed = new Set([
      ...(attempt?.roles ?? []),
      ...pending.filter(each => each.grant === grant.id && !each.opens).flatMap(each => each.roles),
    ]);
    const joins = this.joinable(grant.id, now) && roles.every(role => !typed.has(role));
    if (!joins) {
      const opening = pending.filter(each => each.grant === grant.id && each.opens).length;
      if (grant.remaining - opening <= 0) return 'used-up';
    }
    const signInFills =
      recent(this.#bySignIn.get(grant.signIn), now).length +
      pending.filter(each => each.signIn === grant.signIn).length;
    const sessionFills =
      recent(this.#bySession.get(sessionId), now).length + pending.filter(each => each.sessionId === sessionId).length;
    if (signInFills >= FILLS_PER_HOUR_PER_SIGN_IN || sessionFills >= FILLS_PER_HOUR_PER_SESSION) return 'rate';
    const reservation: GrantReservation = {
      grant: grant.id,
      signIn: grant.signIn,
      sessionId,
      roles: [...roles],
      fieldSet,
      opens: !joins,
      at: now,
    };
    this.#open.add(reservation);
    return reservation;
  }

  /**
   * The fill was typed, or may have been: it counts against the rate, opens or joins its attempt with its roles, and pins
   * the form's identity for its field set when none was pinned. Whether it spent a use (`opens`) is the caller's to
   * record on the grant. A reservation already settled is ignored.
   */
  spent(reservation: GrantReservation, identity: string | undefined): boolean {
    if (!this.#open.delete(reservation)) return false;
    const { grant, at, fieldSet } = reservation;
    this.#bySignIn.set(reservation.signIn, [...recent(this.#bySignIn.get(reservation.signIn), at), at]);
    this.#bySession.set(reservation.sessionId, [...recent(this.#bySession.get(reservation.sessionId), at), at]);
    const attempt = this.#attempts.get(grant);
    if (reservation.opens || attempt === undefined)
      this.#attempts.set(grant, { opened: at, roles: new Set(reservation.roles) });
    else for (const role of reservation.roles) attempt.roles.add(role);
    if (identity !== undefined) {
      const pins = this.#pins.get(grant) ?? new Map<string, string>();
      if (!pins.has(fieldSet)) pins.set(fieldSet, identity);
      this.#pins.set(grant, pins);
    }
    return reservation.opens;
  }

  /** Nothing was typed: the reservation is given back, and nothing is counted. */
  release(reservation: GrantReservation): void {
    this.#open.delete(reservation);
  }

  /** The identity each field set was first filled with under `grant`. */
  pinned(grant: string): ReadonlyMap<string, string> {
    return this.#pins.get(grant) ?? new Map();
  }

  /** Forgets the attempts and pins of every grant `keep` lets go: they die with their grant. The rate counts stay. */
  retain(keep: (grant: string) => boolean): void {
    for (const grant of [...this.#attempts.keys()]) if (!keep(grant)) this.#attempts.delete(grant);
    for (const grant of [...this.#pins.keys()]) if (!keep(grant)) this.#pins.delete(grant);
  }
}
