import type { StepUpService, StepUpSubject } from './lib/step-up/index.ts';

/** TODO(Gate contract): DECISIONS-1 #3. Access owns ceremonies and proofs; Gate asks these questions. */
export type AccessStepUpProvider = Pick<
  StepUpService,
  | 'held'
  | 'freshlyHeld'
  | 'unlockRequired'
  | 'claimFresh'
  | 'verifyStoredProof'
  | 'spendFresh'
  | 'spend'
  | 'rotateBy'
  | 'claimStoredProof'
>;

/** No opened service means no authority, including while state is damaged or unavailable. */
export function stepUpProvider(current: () => StepUpService | undefined): AccessStepUpProvider {
  return {
    held: subject => current()?.held(subject) ?? false,
    freshlyHeld: subject => current()?.freshlyHeld(subject) ?? false,
    unlockRequired: subject => current()?.unlockRequired(subject) ?? true,
    claimFresh: ((...args: Parameters<StepUpService['claimFresh']>) =>
      current()?.claimFresh(...args) ?? false) as StepUpService['claimFresh'],
    claimStoredProof: (subject, act, stage, challenge) => current()?.claimStoredProof(subject, act, stage, challenge),
    verifyStoredProof: async (proof, challenge) => (await current()?.verifyStoredProof(proof, challenge)) ?? false,
    spendFresh: (subject: StepUpSubject) => current()?.spendFresh(subject),
    spend: (subject: StepUpSubject) => current()?.spend(subject),
    rotateBy: deviceId => current()?.rotateBy(deviceId),
  };
}
