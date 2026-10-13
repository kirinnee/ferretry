import { PASSKEY_CHALLENGE_TTL_SECONDS, STEP_UP_TTL_SECONDS } from '@ferretry/protocol';

/** One running copy of the app on one device: what a step-up and a challenge are bound to. */
export interface StepUpSubject {
  readonly deviceId: string;
  readonly appSession: string;
}

const key = (subject: StepUpSubject): string => `${subject.deviceId}\u0000${subject.appSession}`;

/**
 * WHICH RUNNING COPIES OF THE APP HAVE PROVED A PASSKEY RECENTLY, held in memory and nowhere else.
 *
 * A verified step-up is never a value the browser holds: there is nothing to steal, replay or carry to
 * another tab. It is a fact this daemon remembers about one `(deviceId, appSession)` for fifteen
 * minutes, and it ends early on revocation (`forgetDevice`), on a restart (memory), and when the page
 * closes — a new page is a new `appSession`, which this map has never heard of.
 */
export class StepUpRegistry {
  readonly #held = new Map<string, number>();

  /** Records a verified step-up and returns when it lapses. */
  grant(subject: StepUpSubject, nowMs: number): number {
    const expiresAtMs = nowMs + STEP_UP_TTL_SECONDS * 1_000;
    this.#held.set(key(subject), expiresAtMs);
    return expiresAtMs;
  }

  /** When this copy's step-up lapses, or nothing when it holds none. A lapsed one is forgotten here. */
  expiresAt(subject: StepUpSubject, nowMs: number): number | undefined {
    const id = key(subject);
    const expiresAtMs = this.#held.get(id);
    if (expiresAtMs === undefined) return undefined;
    if (expiresAtMs > nowMs) return expiresAtMs;
    this.#held.delete(id);
    return undefined;
  }

  held(subject: StepUpSubject, nowMs: number): boolean {
    return this.expiresAt(subject, nowMs) !== undefined;
  }

  /** Revoking a device ends every step-up any copy of the app on it holds. */
  forgetDevice(deviceId: string): void {
    for (const id of [...this.#held.keys()]) if (id.startsWith(`${deviceId}\u0000`)) this.#held.delete(id);
  }
}

/** What a challenge was issued for. A registration challenge answers no assertion, and back. */
export type ChallengePurpose = 'register' | 'step-up';

interface IssuedChallenge {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
}

/**
 * The challenges this daemon has issued and nobody has answered yet: one per copy of the app per
 * purpose, two minutes each, spent by the first answer whether it verifies or not.
 *
 * ONE AT A TIME, deliberately. Asking again replaces the outstanding challenge, so a page that opened
 * the prompt twice cannot hold two live ones, and the ledger is bounded by the number of live sessions
 * rather than by how often somebody asks.
 */
export class ChallengeLedger {
  readonly #issued = new Map<string, IssuedChallenge>();

  issue(subject: StepUpSubject, purpose: ChallengePurpose, bytes: Uint8Array, nowMs: number): void {
    this.#issued.set(`${purpose}\u0000${key(subject)}`, {
      bytes,
      expiresAtMs: nowMs + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
    });
  }

  /**
   * The outstanding challenge for this copy and purpose, removed in the same call — so an answer is
   * judged against it exactly once — or nothing when there is none or it lapsed.
   */
  take(subject: StepUpSubject, purpose: ChallengePurpose, nowMs: number): Uint8Array | undefined {
    const id = `${purpose}\u0000${key(subject)}`;
    const issued = this.#issued.get(id);
    this.#issued.delete(id);
    if (issued === undefined || issued.expiresAtMs <= nowMs) return undefined;
    return issued.bytes;
  }

  forgetDevice(deviceId: string): void {
    for (const id of [...this.#issued.keys()]) if (id.split('\u0000')[1] === deviceId) this.#issued.delete(id);
  }
}
