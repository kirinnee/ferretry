import type {
  ClaimFreshWitness,
  StepUpSubject,
  StepUpWitness,
  StoredProofStepUpAct,
  StoredStepUpProof,
  StepUpSubjectOf,
} from '../../../contract/index.ts';

/**
 * The `step-up:device` value admission asks, read live, FAIL CLOSED (§7.1): with no provider (Access off, failed at
 * build, damaged) or one that throws, nobody holds a step-up or a fresh proof, every claim is answered `false` or
 * nothing, nothing is spent, and every device must unlock before it is served. Today's boundary asked the step-up
 * service these same questions (`StepUpWitness`); the answers are Access's, the decision what to ask is Gate's.
 */
export class FailClosedStepUps implements StepUpWitness {
  constructor(private readonly provider: () => StepUpWitness | undefined) {}

  #ask<T>(question: (witness: StepUpWitness) => T, closed: T): T {
    let witness: StepUpWitness | undefined;
    try {
      witness = this.provider();
      return witness === undefined ? closed : question(witness);
    } catch {
      return closed;
    }
  }

  held(subject: StepUpSubject): boolean {
    return this.#ask(witness => witness.held(subject) === true, false);
  }

  freshlyHeld(subject: StepUpSubject): boolean {
    return this.#ask(witness => witness.freshlyHeld(subject) === true, false);
  }

  unlockRequired(subject: StepUpSubject): boolean {
    return this.#ask(witness => witness.unlockRequired(subject) !== false, true);
  }

  readonly claimFresh = ((subject: StepUpSubject, act?: never, bound?: string, notAfterMs?: number): boolean =>
    this.#ask(
      witness =>
        (bound === undefined
          ? witness.claimFresh(subject, act, undefined, notAfterMs)
          : (witness.claimFresh as (s: StepUpSubject, a: unknown, b: string) => boolean)(subject, act, bound)) === true,
      false,
    )) as ClaimFreshWitness;

  claimStoredProof<Act extends StoredProofStepUpAct>(
    subject: StepUpSubject,
    act: Act,
    stage: StepUpSubjectOf<Act>,
    expectedChallenge: Uint8Array,
  ): StoredStepUpProof | undefined {
    return this.#ask(witness => witness.claimStoredProof(subject, act, stage, expectedChallenge), undefined);
  }

  async verifyStoredProof(proof: StoredStepUpProof, expectedChallenge: Uint8Array): Promise<boolean> {
    try {
      const witness = this.provider();
      return witness === undefined ? false : (await witness.verifyStoredProof(proof, expectedChallenge)) === true;
    } catch {
      return false;
    }
  }

  spendFresh(subject: StepUpSubject): void {
    this.#ask(witness => witness.spendFresh(subject), undefined);
  }

  spend(subject: StepUpSubject): void {
    this.#ask(witness => witness.spend(subject), undefined);
  }

  rotateBy(deviceId: string): number | undefined {
    return this.#ask(witness => witness.rotateBy(deviceId), undefined);
  }
}
