import { PASSKEY_CHALLENGE_TTL_SECONDS, STEP_UP_TTL_SECONDS } from '@ferretry/protocol';
import { bytesEqual } from '@ferretry/relay';

/** One running copy of the app on one device: what a step-up and a challenge are bound to. */
export interface StepUpSubject {
  readonly deviceId: string;
  readonly appSession: string;
}

const key = (subject: StepUpSubject): string => `${subject.deviceId}\u0000${subject.appSession}`;

/**
 * How long a copy of the app may have no live session at all and still be the same copy: long enough
 * for a lease to end and its session to be reopened, far shorter than a step-up.
 */
export const APP_SESSION_GRACE_MS = 60_000;

/** One copy of the app's unbroken life on this daemon: how many sessions it holds, and since when none. */
interface AppSessionSpan {
  open: number;
  closedAtMs: number | undefined;
}

/**
 * WHICH RUNNING COPIES OF THE APP HAVE PROVED A PASSKEY RECENTLY, held in memory and nowhere else.
 *
 * A verified step-up is never a value the browser holds: there is nothing to steal or carry to another
 * tab. It is a fact this daemon remembers about one `(deviceId, appSession)` for fifteen minutes, and
 * it ends early on revocation (`forgetDevice`), on a restart (memory), and when the page closes.
 *
 * "WHEN THE PAGE CLOSES" IS DECIDED HERE, NOT BY THE PAGE. `appSession` is 16 bytes the page picks,
 * so code running in it — an injected script, a malicious deploy — could keep the value and present it
 * again from a later page of the same device. What it cannot keep is a live session. So a step-up
 * belongs to one SPAN: the unbroken stretch in which that copy holds at least one session, with
 * {@link APP_SESSION_GRACE_MS} of slack for a reconnect. When the span ends, its step-up ends with it,
 * and the same id presented afterwards begins a new span that holds nothing.
 */
export class StepUpRegistry {
  readonly #held = new Map<string, number>();
  readonly #spans = new Map<string, AppSessionSpan>();

  constructor(private readonly clock: { readonly nowMs: () => number }) {}

  /** A session of this copy of the app opened. Returns the call for when it ends. */
  open(subject: StepUpSubject): () => void {
    const id = key(subject);
    const span = this.#liveSpan(id, this.clock.nowMs()) ?? this.#begin(id);
    span.open += 1;
    span.closedAtMs = undefined;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      span.open -= 1;
      if (span.open > 0) return;
      const now = this.clock.nowMs();
      span.closedAtMs = now;
      this.#sweep(now);
    };
  }

  /** Records a verified step-up and returns when it lapses. */
  grant(subject: StepUpSubject, nowMs: number): number {
    const expiresAtMs = nowMs + STEP_UP_TTL_SECONDS * 1_000;
    this.#held.set(key(subject), expiresAtMs);
    return expiresAtMs;
  }

  /**
   * When this copy's step-up lapses, or nothing when it holds none. A lapsed one is forgotten here, and
   * so is one whose copy of the app has had no live session for longer than the grace.
   */
  expiresAt(subject: StepUpSubject, nowMs: number): number | undefined {
    const id = key(subject);
    const expiresAtMs = this.#held.get(id);
    if (expiresAtMs === undefined) return undefined;
    if (expiresAtMs > nowMs && this.#liveSpan(id, nowMs) !== undefined) return expiresAtMs;
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

  /** The span this copy is in, or nothing — and an ended one is dropped with its step-up. */
  #liveSpan(id: string, nowMs: number): AppSessionSpan | undefined {
    const span = this.#spans.get(id);
    if (span === undefined) return undefined;
    if (span.closedAtMs === undefined || nowMs - span.closedAtMs < APP_SESSION_GRACE_MS) return span;
    this.#spans.delete(id);
    this.#held.delete(id);
    return undefined;
  }

  /** A new span. Whatever an earlier life of the same id held does not carry into it. */
  #begin(id: string): AppSessionSpan {
    this.#held.delete(id);
    const span: AppSessionSpan = { open: 0, closedAtMs: undefined };
    this.#spans.set(id, span);
    return span;
  }

  /** Drops every ended span, so the map is bounded by the copies alive in the last minute. */
  #sweep(nowMs: number): void {
    for (const id of [...this.#spans.keys()]) this.#liveSpan(id, nowMs);
  }
}

/**
 * What a challenge was issued for. A registration challenge answers no assertion, and back; and a
 * `register-confirm` challenge — the existing passkey's answer that a later registration needs — is
 * bound to the one registration challenge it was issued with, so neither can be spent on its own.
 */
export type ChallengePurpose = 'register' | 'register-confirm' | 'step-up';

interface IssuedChallenge {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
  /** The registration challenge a `register-confirm` was issued with. */
  readonly boundTo?: Uint8Array;
}

/**
 * The challenges this daemon has issued and nobody has answered yet: one per copy of the app per
 * purpose, two minutes each, spent by the first answer whether it verifies or not.
 *
 * ONE AT A TIME, deliberately. Asking again replaces the outstanding challenge, so a page that opened
 * the prompt twice cannot hold two live ones. That alone bounds nothing — a device can open a session
 * per fresh `appSession`, ask once and leave — so every issue also SWEEPS the lapsed ones: what the
 * ledger holds is bounded by the challenges issued in the last two minutes.
 */
export class ChallengeLedger {
  readonly #issued = new Map<string, IssuedChallenge>();

  issue(
    subject: StepUpSubject,
    purpose: ChallengePurpose,
    bytes: Uint8Array,
    nowMs: number,
    boundTo?: Uint8Array,
  ): void {
    for (const [id, issued] of this.#issued) if (issued.expiresAtMs <= nowMs) this.#issued.delete(id);
    this.#issued.set(`${purpose}\u0000${key(subject)}`, {
      bytes,
      expiresAtMs: nowMs + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
      ...(boundTo === undefined ? {} : { boundTo }),
    });
  }

  /**
   * The outstanding challenge for this copy and purpose, removed in the same call — so an answer is
   * judged against it exactly once — or nothing when there is none or it lapsed.
   */
  take(subject: StepUpSubject, purpose: ChallengePurpose, nowMs: number): Uint8Array | undefined {
    return this.#take(subject, purpose, nowMs)?.bytes;
  }

  /**
   * The outstanding `register-confirm` challenge, removed in the same call, and only when it was issued
   * with THIS registration challenge: a confirmation left over from an earlier options call is spent
   * and refused, never paired with a newer registration.
   */
  takeConfirmation(subject: StepUpSubject, registration: Uint8Array, nowMs: number): Uint8Array | undefined {
    const issued = this.#take(subject, 'register-confirm', nowMs);
    if (issued?.boundTo === undefined || !bytesEqual(issued.boundTo, registration)) return undefined;
    return issued.bytes;
  }

  /** How many challenges are outstanding, lapsed ones included until the next issue sweeps them. */
  get size(): number {
    return this.#issued.size;
  }

  forgetDevice(deviceId: string): void {
    for (const id of [...this.#issued.keys()]) if (id.split('\u0000')[1] === deviceId) this.#issued.delete(id);
  }

  #take(subject: StepUpSubject, purpose: ChallengePurpose, nowMs: number): IssuedChallenge | undefined {
    const id = `${purpose}\u0000${key(subject)}`;
    const issued = this.#issued.get(id);
    this.#issued.delete(id);
    if (issued === undefined || issued.expiresAtMs <= nowMs) return undefined;
    return issued;
  }
}
