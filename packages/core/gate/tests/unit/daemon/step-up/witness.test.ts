import { describe, expect, test } from 'bun:test';
import type { StepUpSubject, StepUpWitness, StoredStepUpProof } from '../../../../contract/index.ts';
import { FailClosedStepUps } from '../../../../daemon/lib/step-up/witness.ts';

const subject: StepUpSubject = { deviceId: 'phone', appSession: 'app-1' };
const proof: StoredStepUpProof = {
  deviceId: 'phone',
  credentialId: 'c',
  clientDataJSON: 'j',
  authenticatorData: 'a',
  signature: 's',
};
const challenge = new Uint8Array([1, 2, 3]);

/** A witness that answers as told and writes down what it was asked. */
function answering(calls: string[]): StepUpWitness {
  return {
    held: () => true,
    freshlyHeld: () => true,
    unlockRequired: () => false,
    claimFresh: ((_subject: StepUpSubject, act?: string, bound?: string) => {
      calls.push(`claimFresh:${act ?? '-'}:${bound ?? '-'}`);
      return true;
    }) as StepUpWitness['claimFresh'],
    claimStoredProof: ((_subject: StepUpSubject, act: string) => {
      calls.push(`claimStoredProof:${act}`);
      return proof;
    }) as StepUpWitness['claimStoredProof'],
    verifyStoredProof: async () => true,
    spendFresh: () => void calls.push('spendFresh'),
    spend: () => void calls.push('spend'),
    rotateBy: (deviceId: string) => {
      calls.push(`rotateBy:${deviceId}`);
      return 3;
    },
  };
}

const failing = (): FailClosedStepUps =>
  new FailClosedStepUps(() => {
    throw new Error('the step-up provider failed');
  });
const absent = (): FailClosedStepUps => new FailClosedStepUps(() => undefined);

describe('the step-up witness, read live and failing closed', () => {
  test('a provider that answers is asked, and its answers are passed through', async () => {
    const calls: string[] = [];
    const stepUps = new FailClosedStepUps(() => answering(calls));
    expect(stepUps.held(subject)).toBe(true);
    expect(stepUps.freshlyHeld(subject)).toBe(true);
    expect(stepUps.unlockRequired(subject)).toBe(false);
    expect(stepUps.claimFresh(subject)).toBe(true);
    expect(stepUps.claimStoredProof(subject, 'device-add' as never, 'stage' as never, challenge)).toBe(proof);
    expect(await stepUps.verifyStoredProof(proof, challenge)).toBe(true);
    stepUps.spendFresh(subject);
    stepUps.spend(subject);
    expect(stepUps.rotateBy('phone')).toBe(3);
    expect(calls).toEqual(['claimFresh:-:-', 'claimStoredProof:device-add', 'spendFresh', 'spend', 'rotateBy:phone']);
  });

  test('a claim bound to a stage is passed to the provider with its stage', () => {
    const calls: string[] = [];
    const stepUps = new FailClosedStepUps(() => answering(calls));
    expect(stepUps.claimFresh(subject, 'device-add' as never, 'stage-7')).toBe(true);
    expect(calls).toEqual(['claimFresh:device-add:stage-7']);
  });

  test('with no provider nobody holds a proof, every device must unlock, and nothing is claimed, verified or rotated', async () => {
    const stepUps = absent();
    expect(stepUps.held(subject)).toBe(false);
    expect(stepUps.freshlyHeld(subject)).toBe(false);
    expect(stepUps.unlockRequired(subject)).toBe(true);
    expect(stepUps.claimFresh(subject)).toBe(false);
    expect(stepUps.claimStoredProof(subject, 'device-add' as never, 'stage' as never, challenge)).toBeUndefined();
    expect(await stepUps.verifyStoredProof(proof, challenge)).toBe(false);
    expect(() => {
      stepUps.spendFresh(subject);
      stepUps.spend(subject);
    }).not.toThrow();
    expect(stepUps.rotateBy('phone')).toBeUndefined();
  });

  test('a provider that throws is the same as no provider, for every question', async () => {
    const stepUps = failing();
    expect(stepUps.held(subject)).toBe(false);
    expect(stepUps.freshlyHeld(subject)).toBe(false);
    expect(stepUps.unlockRequired(subject)).toBe(true);
    expect(stepUps.claimFresh(subject)).toBe(false);
    expect(stepUps.claimStoredProof(subject, 'device-add' as never, 'stage' as never, challenge)).toBeUndefined();
    expect(await stepUps.verifyStoredProof(proof, challenge)).toBe(false);
    expect(() => {
      stepUps.spendFresh(subject);
      stepUps.spend(subject);
    }).not.toThrow();
    expect(stepUps.rotateBy('phone')).toBeUndefined();
  });

  test('a verification that rejects fails closed, and one that answers a non-true value is not a pass', async () => {
    const rejecting = new FailClosedStepUps(() => ({
      ...answering([]),
      verifyStoredProof: async () => {
        throw new Error('the verifier failed');
      },
    }));
    expect(await rejecting.verifyStoredProof(proof, challenge)).toBe(false);
    const maybe = new FailClosedStepUps(() => ({
      ...answering([]),
      verifyStoredProof: (async () => 'yes') as never,
    }));
    expect(await maybe.verifyStoredProof(proof, challenge)).toBe(false);
  });
});
