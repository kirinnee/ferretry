import type { HolderId, SessionId } from '@ferretry/kernel/contract';
import {
  type EveryCallerStepUpAct,
  type MachineSkippableStepUpAct,
  STEP_UP_DEFAULT_WINDOW_MINUTES,
  type StepUpAct,
  stepUpKeepsProof,
  stepUpSkippableAtMachine,
  type StoredProofStepUpAct,
  type StoredStepUpProof,
} from '../../../contract/index.ts';

/**
 * Gate's step-up plumbing (today's `lib/step-up/registry.ts`, the part Gate keeps; the ceremonies, passkeys and the
 * unlock ledger are Access's). Copied, with two changes the kernel made: a copy of the app is the kernel-stamped
 * principal (`holder`, `session`) rather than `(deviceId, appSession)`, and a session's life is the kernel's, so the
 * app-session span bookkeeping is gone — a new session is a new copy, which can only hold less.
 */

/** How long a challenge — and so a fresh proof — lives (today's `PASSKEY_CHALLENGE_TTL_SECONDS`). */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 120 as const;

/** One running copy of the app on one device: what a step-up is bound to. */
export interface StepUpSubject {
  readonly holder: HolderId;
  readonly session: SessionId;
}

const key = (subject: StepUpSubject): string => `${subject.holder}\u0000${subject.session}`;

interface HeldStepUp {
  readonly grantedAtMs: number;
}

interface FreshProof {
  readonly provedAtMs: number;
  readonly act: MachineSkippableStepUpAct | undefined;
}

/** What is KEPT of a ceremony for a stored-proof act: the assertion as verified and the challenge it answered. */
export interface KeptProof {
  readonly evidence: StoredStepUpProof;
  readonly challenge: Uint8Array;
}

interface BoundProof {
  readonly provedAtMs: number;
  readonly act: EveryCallerStepUpAct;
  readonly bound: string;
  readonly kept?: KeptProof;
}

/** An every-caller act whose proof is spent, never kept. */
export type SpentProofStepUpAct = Exclude<EveryCallerStepUpAct, StoredProofStepUpAct>;

/** The step-up window in force, in minutes. `0` means a step-up admits exactly one governed act (G97). */
export type StepUpWindow = () => number;

const DEFAULT_WINDOW: StepUpWindow = () => STEP_UP_DEFAULT_WINDOW_MINUTES;

/** Constant-time equality of two byte strings. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

/**
 * WHICH RUNNING COPIES OF THE APP HAVE PROVED A PASSKEY RECENTLY, held in memory and nowhere else (G78, G100).
 *
 * A verified step-up is never a value the browser holds: it is a fact this daemon remembers about one copy for the
 * machine's step-up window (`stepUpWindowMinutes`). The window is read at every question, so a shortened window
 * applies at once; a window of `0` asks every time, and the boundary spends the one act it admits ({@link spend}).
 */
export class StepUpRegistry {
  readonly #held = new Map<string, HeldStepUp>();
  readonly #fresh = new Map<string, FreshProof>();
  readonly #bound = new Map<string, BoundProof>();

  constructor(
    private readonly clock: { readonly nowMs: () => number },
    private readonly window: StepUpWindow = DEFAULT_WINDOW,
  ) {}

  /** Records a verified step-up. `fresh` is whether the passkey was proved FOR AN ACT; the unlock never is. */
  grant(subject: StepUpSubject, fresh = true, act?: MachineSkippableStepUpAct): number {
    const nowMs = this.clock.nowMs();
    const held: HeldStepUp = { grantedAtMs: nowMs };
    this.#held.set(key(subject), held);
    if (fresh) this.#fresh.set(key(subject), { provedAtMs: nowMs, act });
    else this.#fresh.delete(key(subject));
    return this.#endOf(held);
  }

  /** Records a passkey proved for an every-caller act, bound to one subject. Opens no window. */
  grantBound(subject: StepUpSubject, act: EveryCallerStepUpAct, bound: string, kept?: KeptProof): number {
    if (stepUpKeepsProof(act) !== (kept !== undefined))
      throw new TypeError('a stored-proof act keeps its proof, and no other act does');
    const nowMs = this.clock.nowMs();
    this.#bound.set(key(subject), { provedAtMs: nowMs, act, bound, ...(kept === undefined ? {} : { kept }) });
    return nowMs + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;
  }

  /** One governed act was admitted on this copy's step-up. Under a window of `0` that spends it. */
  spend(subject: StepUpSubject): void {
    if (this.window() === 0) this.#held.delete(key(subject));
  }

  expiresAt(subject: StepUpSubject): number | undefined {
    const id = key(subject);
    const held = this.#held.get(id);
    if (held === undefined) return undefined;
    const expiresAtMs = this.#endOf(held);
    if (expiresAtMs > this.clock.nowMs()) return expiresAtMs;
    this.#held.delete(id);
    return undefined;
  }

  held(subject: StepUpSubject): boolean {
    return this.expiresAt(subject) !== undefined;
  }

  /** Whether this copy proved a passkey within a challenge's life and has not spent it. Never without a live step-up. */
  freshlyHeld(subject: StepUpSubject): boolean {
    const proof = this.#fresh.get(key(subject));
    return (
      proof !== undefined &&
      this.clock.nowMs() - proof.provedAtMs < PASSKEY_CHALLENGE_TTL_SECONDS * 1_000 &&
      this.held(subject)
    );
  }

  /** Takes this copy's fresh proof in ONE step (G82): of two acts racing on one proof exactly one gets `true`. */
  claimFresh(subject: StepUpSubject, act?: StepUpAct, bound?: string): boolean {
    if (act !== undefined && !stepUpSkippableAtMachine(act)) return this.#claimBound(subject, act, bound);
    if (!this.freshlyHeld(subject)) return false;
    if (act !== undefined && this.#fresh.get(key(subject))?.act !== act) return false;
    this.#fresh.delete(key(subject));
    return true;
  }

  #claimBound(subject: StepUpSubject, act: EveryCallerStepUpAct, bound: string | undefined): boolean {
    if (stepUpKeepsProof(act)) return false;
    const proof = this.#liveBound(subject, act, bound);
    if (proof === undefined || proof.kept !== undefined) return false;
    this.#bound.delete(key(subject));
    return true;
  }

  /** Takes the KEPT assertion of a stored-proof act (G85), once, only for the challenge it was verified against. */
  claimStoredProof(
    subject: StepUpSubject,
    act: StoredProofStepUpAct,
    bound: string,
    expectedChallenge: Uint8Array,
  ): StoredStepUpProof | undefined {
    if (!stepUpKeepsProof(act)) return undefined;
    const kept = this.#liveBound(subject, act, bound)?.kept;
    if (kept === undefined || !bytesEqual(kept.challenge, expectedChallenge)) return undefined;
    this.#bound.delete(key(subject));
    return kept.evidence;
  }

  #liveBound(subject: StepUpSubject, act: EveryCallerStepUpAct, bound: string | undefined): BoundProof | undefined {
    const id = key(subject);
    const proof = this.#bound.get(id);
    if (bound === undefined || bound === '' || proof === undefined) return undefined;
    if (this.clock.nowMs() - proof.provedAtMs >= PASSKEY_CHALLENGE_TTL_SECONDS * 1_000) {
      this.#bound.delete(id);
      return undefined;
    }
    if (proof.act !== act || proof.bound !== bound) return undefined;
    return proof;
  }

  spendFresh(subject: StepUpSubject): void {
    this.#fresh.delete(key(subject));
  }

  /** Revoking a device ends every step-up any copy of the app on it holds. */
  forgetHolder(holder: HolderId): void {
    const prefix = `${holder}\u0000`;
    for (const map of [this.#held, this.#fresh, this.#bound])
      for (const id of [...map.keys()]) if (id.startsWith(prefix)) map.delete(id);
  }

  #endOf(held: HeldStepUp): number {
    const minutes = this.window();
    return held.grantedAtMs + (minutes === 0 ? PASSKEY_CHALLENGE_TTL_SECONDS * 1_000 : minutes * 60_000);
  }
}
