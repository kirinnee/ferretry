import type {
  StepUpSubject,
  StepUpWitness,
  StoredProofStepUpAct,
  StoredStepUpProof as GateStoredStepUpProof,
  StepUpSubjectOf,
} from '@ferretry/core-gate/contract';
import type { HolderId } from '@ferretry/kernel/contract';
import type { StepUpService } from './lib/step-up/index.ts';
import type { StoredStepUpProof } from './lib/wire.ts';

/** Gate's kept proof names its `holder`; Access keeps it as the `deviceId` that proved it. Mapped here, nowhere else. */
const toGate = (proof: StoredStepUpProof): GateStoredStepUpProof => ({
  holder: proof.deviceId as HolderId,
  credentialId: proof.credentialId,
  clientDataJSON: proof.clientDataJSON,
  authenticatorData: proof.authenticatorData,
  signature: proof.signature,
});

const fromGate = (proof: GateStoredStepUpProof): StoredStepUpProof => ({
  deviceId: proof.holder,
  credentialId: proof.credentialId,
  clientDataJSON: proof.clientDataJSON,
  authenticatorData: proof.authenticatorData,
  signature: proof.signature,
});

/**
 * `step-up:device`, Gate's `StepUpWitness` answered by Access's own step-up service (DECISIONS-1 #3: Access owns the
 * ceremonies and proofs, Gate asks). No opened service means no authority, including while state is damaged or
 * unavailable: nobody holds a step-up, every claim is refused, every device must unlock. Never logs or returns a proof,
 * signature, challenge or token beyond the one kept proof a claim hands to its caller.
 */
export function stepUpProvider(current: () => StepUpService | undefined): StepUpWitness {
  return {
    held: subject => current()?.held(subject) ?? false,
    freshlyHeld: subject => current()?.freshlyHeld(subject) ?? false,
    unlockRequired: subject => current()?.unlockRequired(subject) ?? true,
    claimFresh: ((subject: StepUpSubject, act?: never, bound?: string): boolean => {
      const service = current();
      if (service === undefined) return false;
      return bound === undefined
        ? service.claimFresh(subject, act)
        : (service.claimFresh as (s: StepUpSubject, a: unknown, b: string) => boolean).call(
            service,
            subject,
            act,
            bound,
          );
    }) as StepUpWitness['claimFresh'],
    claimStoredProof: <Act extends StoredProofStepUpAct>(
      subject: StepUpSubject,
      act: Act,
      stage: StepUpSubjectOf<Act>,
      expectedChallenge: Uint8Array,
    ) => {
      const kept = current()?.claimStoredProof(subject, act, stage, expectedChallenge);
      return kept === undefined ? undefined : toGate(kept);
    },
    verifyStoredProof: async (proof, expectedChallenge) =>
      (await current()?.verifyStoredProof(fromGate(proof), expectedChallenge)) ?? false,
    spendFresh: (subject: StepUpSubject) => current()?.spendFresh(subject),
    spend: (subject: StepUpSubject) => current()?.spend(subject),
    rotateBy: deviceId => current()?.rotateBy(deviceId),
  };
}
