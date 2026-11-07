import { PASSKEY_CHALLENGE_TTL_SECONDS } from '../boundary.ts';
import type {
  MachineSkippableStepUpAct,
  EveryCallerStepUpAct,
  StoredProofStepUpAct,
} from '@ferretry/core-gate/contract';
import { bytesEqual } from '../../adapters/relay.ts';
export interface StepUpSubject {
  readonly deviceId: string;
  readonly appSession: string;
}

const key = (subject: StepUpSubject): string => `${subject.deviceId}\u0000${subject.appSession}`;

export type SpentProofStepUpAct = Exclude<EveryCallerStepUpAct, StoredProofStepUpAct>;

export type ChallengeStamp =
  | { readonly kind: 'act'; readonly act: MachineSkippableStepUpAct }
  | { readonly kind: 'bound'; readonly act: SpentProofStepUpAct; readonly bound: string }
  | { readonly kind: 'kept'; readonly act: StoredProofStepUpAct; readonly stage: string };

export type ChallengePurpose = 'register' | 'register-confirm' | 'step-up' | 'unlock';

interface IssuedChallenge {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
  /** The registration challenge a `register-confirm` was issued with. */
  readonly boundTo?: Uint8Array;
  /** What a `step-up` challenge was asked for, which the proof it buys is stamped with. */
  readonly stamp?: ChallengeStamp;
}

export class ChallengeLedger {
  readonly #issued = new Map<string, IssuedChallenge>();

  issue(
    subject: StepUpSubject,
    purpose: ChallengePurpose,
    bytes: Uint8Array,
    nowMs: number,
    boundTo?: Uint8Array,
    stamp?: ChallengeStamp,
  ): void {
    for (const [id, issued] of this.#issued) if (issued.expiresAtMs <= nowMs) this.#issued.delete(id);
    this.#issued.set(`${purpose}\u0000${key(subject)}`, {
      bytes,
      expiresAtMs: nowMs + PASSKEY_CHALLENGE_TTL_SECONDS * 1_000,
      ...(boundTo === undefined ? {} : { boundTo }),
      ...(stamp === undefined ? {} : { stamp }),
    });
  }

  /**
   * The outstanding challenge for this copy and purpose, removed in the same call — so an answer is
   * judged against it exactly once — or nothing when there is none or it lapsed.
   */
  take(subject: StepUpSubject, purpose: ChallengePurpose, nowMs: number): Uint8Array | undefined {
    return this.#take(subject, purpose, nowMs)?.bytes;
  }

  /** {@link take}, with what the challenge was asked for. */
  takeWithAct(
    subject: StepUpSubject,
    purpose: ChallengePurpose,
    nowMs: number,
  ): { readonly bytes: Uint8Array; readonly stamp?: ChallengeStamp } | undefined {
    return this.#take(subject, purpose, nowMs);
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
