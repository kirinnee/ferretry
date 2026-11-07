/**
 * The hold a reviewed login change lives in until it is applied (today's proposal store, narrowed to logins).
 *
 * A change is staged, previewed and applied from what was STORED — never from a re-read request body — so what a
 * person approves is what lands. This decides nothing about a caller (the capability layer did); it is optimistic
 * concurrency and resource bounds: it expires, it is single-use, and a client cannot make a daemon hold memory
 * without limit.
 *
 * Pure apart from the injected clock and identity.
 */

/** How many changes one daemon holds for review at once, across every client. */
export const MAX_OPEN_CHANGES = 8;
/** How many applied changes are remembered, so a repeat apply is told it already happened. */
const MAX_CONSUMED = 16;
/** How long a reviewed change stays applicable: long enough to read, short enough to be current. */
export const CHANGE_TTL_MS = 15 * 60 * 1000;
const ID_MINT_ATTEMPTS = 4;

export type LoginChangeProblem = 'unknown' | 'expired' | 'consumed' | 'exhausted';

/** Why a staged change cannot be used. Every member is a fact about the change, never about the caller. */
export class LoginChangeHoldRefusal extends Error {
  constructor(
    readonly problem: LoginChangeProblem,
    message: string,
  ) {
    super(message);
    this.name = 'LoginChangeHoldRefusal';
  }
}

export interface HeldChange<Payload> {
  readonly id: string;
  readonly expiresAt: number;
  /** A fingerprint of the logins this change was derived from. */
  readonly revision: string;
  readonly payload: Payload;
  state: 'pending' | 'consumed';
}

export class LoginChangeStore<Payload> {
  readonly #held = new Map<string, HeldChange<Payload>>();
  constructor(private readonly options: { readonly now: () => number; readonly mintId: () => string }) {}

  open(input: { readonly revision: string; readonly payload: Payload }): HeldChange<Payload> {
    this.#retireExpired();
    const open = [...this.#held.values()].filter(held => held.state === 'pending').length;
    if (open >= MAX_OPEN_CHANGES) {
      throw new LoginChangeHoldRefusal(
        'exhausted',
        `this daemon already holds ${String(MAX_OPEN_CHANGES)} login changes awaiting review; apply one or let it expire before staging another`,
      );
    }
    const held: HeldChange<Payload> = {
      ...input,
      id: this.#freeId(),
      expiresAt: this.options.now() + CHANGE_TTL_MS,
      state: 'pending',
    };
    this.#held.set(held.id, held);
    return held;
  }

  /** The live change with this id, or a refusal naming exactly why it cannot be used. */
  require(id: string): HeldChange<Payload> {
    const held = this.#held.get(id);
    if (held !== undefined && held.expiresAt <= this.options.now()) {
      this.#held.delete(id);
      throw new LoginChangeHoldRefusal(
        'expired',
        `login change "${id}" expired before it was applied; review it again`,
      );
    }
    this.#retireExpired();
    if (held === undefined) {
      throw new LoginChangeHoldRefusal('unknown', `no login change with id "${id}" is held on this daemon`);
    }
    if (held.state === 'consumed') {
      throw new LoginChangeHoldRefusal('consumed', `login change "${id}" has already been applied`);
    }
    return held;
  }

  /** Spend one change, synchronously: two applies arriving together cannot both find it pending. */
  consume(id: string): HeldChange<Payload> {
    const held = this.require(id);
    held.state = 'consumed';
    const consumed = [...this.#held.values()].filter(other => other.state === 'consumed');
    for (const old of consumed.slice(0, Math.max(0, consumed.length - MAX_CONSUMED))) this.#held.delete(old.id);
    return held;
  }

  /** Put a consumed change back, when the apply it authorised never reached the host. */
  restore(held: HeldChange<Payload>): void {
    if (this.#held.has(held.id)) held.state = 'pending';
  }

  #freeId(): string {
    for (let attempt = 0; attempt < ID_MINT_ATTEMPTS; attempt += 1) {
      const id = this.options.mintId();
      if (!this.#held.has(id)) return id;
    }
    throw new LoginChangeHoldRefusal('exhausted', 'could not mint an unused login change handle');
  }

  #retireExpired(): void {
    const now = this.options.now();
    for (const [id, held] of this.#held) if (held.expiresAt <= now) this.#held.delete(id);
  }
}
