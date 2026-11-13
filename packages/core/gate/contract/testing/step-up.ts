import { describe, expect, test } from 'bun:test';
import type { StepUpSubject, StepUpWitness } from '../credentials.ts';
import { asksStepUpPerAction, type SecuritySettings } from '../gate-config.ts';
import {
  type EveryCallerStepUpAct,
  type MachineSkippableStepUpAct,
  STEP_UP_ACTS,
  type StepUpAct,
  stepUpKeepsProof,
  stepUpSkippableAtMachine,
  type StoredProofStepUpAct,
} from '../policy.ts';
import type { StoredStepUpProof } from '../standing.ts';

/** How long a challenge — and so a fresh proof — lives (today's `PASSKEY_CHALLENGE_TTL_SECONDS`). */
export const FAKE_PROOF_TTL_MS = 120_000;

const key = (subject: StepUpSubject): string => `${subject.deviceId}\u0000${subject.appSession}`;

/** Constant-time equality of two byte strings. */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

interface BoundProof {
  readonly provedAtMs: number;
  readonly act: EveryCallerStepUpAct;
  readonly bound: string;
  readonly kept?: { readonly evidence: StoredStepUpProof; readonly challenge: Uint8Array };
}

export interface FakeStepUpWitnessOptions {
  readonly nowMs: () => number;
  /** The security settings in force; `undefined` reads as damaged (every act asks, every device must unlock). */
  readonly settings?: () => SecuritySettings | undefined;
  /** Until when (epoch ms) a device's unlock holds, or `undefined` when it holds none. */
  readonly unlockedUntil?: (deviceId: string) => number | undefined;
}

/**
 * An in-memory `step-up:device` value with today's `StepUpService` answers (today's `lib/step-up/registry.ts` ledger
 * plus the service's `held`/`unlockRequired`/`spend` rules), for Gate's admission tests and for the conformance suite
 * below. Never a passkey: a test grants a step-up or a proof directly.
 */
export class FakeStepUpWitness implements StepUpWitness {
  readonly #held = new Map<string, number>();
  readonly #fresh = new Map<string, { readonly provedAtMs: number; readonly act?: MachineSkippableStepUpAct }>();
  readonly #bound = new Map<string, BoundProof>();
  readonly #verified = new Set<string>();

  constructor(private readonly options: FakeStepUpWitnessOptions) {}

  /** Records a verified step-up. `fresh` is whether the passkey was proved FOR AN ACT; the unlock never is. */
  grant(subject: StepUpSubject, fresh = true, act?: MachineSkippableStepUpAct): void {
    const nowMs = this.options.nowMs();
    this.#held.set(key(subject), nowMs);
    if (fresh) this.#fresh.set(key(subject), { provedAtMs: nowMs, ...(act === undefined ? {} : { act }) });
    else this.#fresh.delete(key(subject));
  }

  /** Records a passkey proved for an every-caller act, bound to one subject. Opens no window. */
  grantBound(
    subject: StepUpSubject,
    act: EveryCallerStepUpAct,
    bound: string,
    kept?: { readonly evidence: StoredStepUpProof; readonly challenge: Uint8Array },
  ): void {
    if (stepUpKeepsProof(act) !== (kept !== undefined))
      throw new TypeError('a stored-proof act keeps its proof, and no other act does');
    if (kept !== undefined) this.#verified.add(kept.evidence.signature);
    this.#bound.set(key(subject), {
      provedAtMs: this.options.nowMs(),
      act,
      bound,
      ...(kept === undefined ? {} : { kept }),
    });
  }

  #window(): number {
    const settings = this.options.settings?.();
    return settings === undefined ? 0 : settings.stepUpWindowMinutes;
  }

  #windowHeld(subject: StepUpSubject): boolean {
    const grantedAtMs = this.#held.get(key(subject));
    if (grantedAtMs === undefined) return false;
    const minutes = this.#window();
    const end = grantedAtMs + (minutes === 0 ? FAKE_PROOF_TTL_MS : minutes * 60_000);
    if (end > this.options.nowMs()) return true;
    this.#held.delete(key(subject));
    return false;
  }

  #unlocked(deviceId: string): boolean {
    const until = this.options.unlockedUntil?.(deviceId);
    return until !== undefined && until > this.options.nowMs();
  }

  held(subject: StepUpSubject): boolean {
    const settings = this.options.settings?.();
    if (settings !== undefined && !asksStepUpPerAction(settings) && this.#unlocked(subject.deviceId)) return true;
    return this.#windowHeld(subject);
  }

  freshlyHeld(subject: StepUpSubject): boolean {
    const proof = this.#fresh.get(key(subject));
    return (
      proof !== undefined && this.options.nowMs() - proof.provedAtMs < FAKE_PROOF_TTL_MS && this.#windowHeld(subject)
    );
  }

  unlockRequired(subject: StepUpSubject): boolean {
    const settings = this.options.settings?.();
    if (settings !== undefined && !settings.unlockOnOpen) return false;
    return !this.#unlocked(subject.deviceId);
  }

  claimFresh = ((subject: StepUpSubject, act?: StepUpAct, bound?: string, notAfterMs?: number): boolean => {
    if (act !== undefined && !stepUpSkippableAtMachine(act)) {
      if (stepUpKeepsProof(act)) return false;
      const proof = this.#liveBound(subject, act, bound);
      if (proof === undefined || proof.kept !== undefined) return false;
      this.#bound.delete(key(subject));
      return true;
    }
    if (!this.freshlyHeld(subject)) return false;
    const proof = this.#fresh.get(key(subject));
    if (notAfterMs !== undefined && (proof === undefined || proof.provedAtMs > notAfterMs)) return false;
    if (act !== undefined && proof?.act !== act) return false;
    this.#fresh.delete(key(subject));
    return true;
  }) as StepUpWitness['claimFresh'];

  claimStoredProof<Act extends StoredProofStepUpAct>(
    subject: StepUpSubject,
    act: Act,
    stage: string,
    expectedChallenge: Uint8Array,
  ): StoredStepUpProof | undefined {
    if (!stepUpKeepsProof(act)) return undefined;
    const kept = this.#liveBound(subject, act, stage)?.kept;
    if (kept === undefined || !bytesEqual(kept.challenge, expectedChallenge)) return undefined;
    this.#bound.delete(key(subject));
    return kept.evidence;
  }

  #liveBound(subject: StepUpSubject, act: EveryCallerStepUpAct, bound: string | undefined): BoundProof | undefined {
    const proof = this.#bound.get(key(subject));
    if (bound === undefined || bound === '' || proof === undefined) return undefined;
    if (this.options.nowMs() - proof.provedAtMs >= FAKE_PROOF_TTL_MS) {
      this.#bound.delete(key(subject));
      return undefined;
    }
    return proof.act === act && proof.bound === bound ? proof : undefined;
  }

  async verifyStoredProof(proof: StoredStepUpProof, _expectedChallenge: Uint8Array): Promise<boolean> {
    return this.#verified.has(proof.signature);
  }

  spendFresh(subject: StepUpSubject): void {
    this.#fresh.delete(key(subject));
  }

  spend(subject: StepUpSubject): void {
    const settings = this.options.settings?.();
    if (settings !== undefined && !asksStepUpPerAction(settings)) return;
    if (this.#window() === 0) this.#held.delete(key(subject));
  }

  rotateBy(_deviceId: string): number | undefined {
    return undefined;
  }
}

/** What a `step-up` value under test must let the suite do: hand it a subject that proved a passkey for an act. */
export interface StepUpWitnessSubject {
  readonly witness: StepUpWitness;
  /** A copy of the app that just proved a passkey for `act` (or for no act), so it holds a fresh proof. */
  proved(act?: MachineSkippableStepUpAct): StepUpSubject | Promise<StepUpSubject>;
}

/**
 * The `step-up` conformance suite (§7.1): a copy of the app nobody proved holds nothing, a fresh proof is taken once
 * (atomically, G82), a proof for one act is never another's, and an every-caller act never rides a fresh proof.
 */
export function stepUpWitnessConformance(
  name: string,
  make: () => StepUpWitnessSubject | Promise<StepUpWitnessSubject>,
): void {
  const stranger: StepUpSubject = { deviceId: 'never-proved', appSession: 'app-none' };
  describe(`step-up conformance: ${name}`, () => {
    test('a copy of the app that never proved a passkey holds nothing and claims nothing', async () => {
      const { witness } = await make();
      expect(witness.freshlyHeld(stranger)).toBe(false);
      expect(witness.claimFresh(stranger)).toBe(false);
      expect(
        witness.claimStoredProof(
          stranger,
          STEP_UP_ACTS.approveSignInRule,
          'srs_0123456789abcdef01234567' as never,
          new Uint8Array(4),
        ),
      ).toBeUndefined();
    });
    test('a fresh proof is taken exactly once', async () => {
      const subject = await make();
      const copy = await subject.proved();
      expect(subject.witness.freshlyHeld(copy)).toBe(true);
      expect(subject.witness.claimFresh(copy)).toBe(true);
      expect(subject.witness.claimFresh(copy)).toBe(false);
    });
    test('a proof for one act is not taken for another', async () => {
      const subject = await make();
      const copy = await subject.proved(STEP_UP_ACTS.shareLink);
      expect(subject.witness.claimFresh(copy, STEP_UP_ACTS.addDevice)).toBe(false);
      expect(subject.witness.claimFresh(copy, STEP_UP_ACTS.shareLink)).toBe(true);
    });
    test('an act every caller must prove never rides a fresh proof', async () => {
      const subject = await make();
      const copy = await subject.proved();
      expect(
        subject.witness.claimFresh(copy, STEP_UP_ACTS.addTwoFactorKey, 'st_0123456789abcdef01234567' as never),
      ).toBe(false);
    });
    test('spending the fresh proof leaves nothing to claim', async () => {
      const subject = await make();
      const copy = await subject.proved();
      subject.witness.spendFresh(copy);
      expect(subject.witness.claimFresh(copy)).toBe(false);
    });
  });
}
