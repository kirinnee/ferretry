import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { claimOwnerOnly, type OwnerOnlyCall, ownerOnly, STEP_UP_REQUIRED_CODE } from '../../contract/index.ts';
import { deviceStanding, ferretStanding, ownerStanding, wardenStanding } from '../../contract/testing/index.ts';

const ACT = 'update this machine';

/** A remote device as Gate admits it: governed, with or without a fresh passkey proof. */
function governedDevice(freshStepUp: boolean): OwnerOnlyCall {
  const base = deviceStanding('phone');
  return {
    ...base,
    governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
    presentation: { local: false, adminToken: false, actor: 'device:phone', stepUp: false, freshStepUp },
  };
}

const refusedWith = (run: () => unknown): { status: number; code?: string; message: string } => {
  try {
    run();
  } catch (error) {
    return error as { status: number; code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('ownerOnly: putting new code on the machine is the owner’s act', () => {
  test('G22 G25 a ferret is refused 403 forbidden, whatever its standing', () => {
    const error = refusedWith(() => ownerOnly(ferretStanding('F1' as FerretId), ACT));
    expect(error).toMatchObject({ status: 403, code: 'forbidden', message: `a ferret cannot ${ACT}; the owner does` });
  });

  test('G22 G25 the warden and an admin token with a ferret behind it are agents too', () => {
    expect(refusedWith(() => ownerOnly(wardenStanding('W1' as FerretId), ACT))).toMatchObject({ status: 403 });
    const admin = { ...ownerStanding(), actor: 'ferret:F1' };
    expect(refusedWith(() => ownerOnly(admin, ACT))).toMatchObject({ status: 403, code: 'forbidden' });
  });

  test('G22 G25 a governed device without a fresh passkey proof is asked for one with the demand fleet.configure', () => {
    const answer = ownerOnly(governedDevice(false), ACT);
    expect(answer?.status).toBe(403);
    expect(JSON.parse(answer?.body ?? '{}')).toEqual({
      error: `to ${ACT} from this device, confirm with a passkey`,
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'fleet', axis: 'configure' },
    });
  });

  test('G22 G25 a governed device holding a fresh passkey proof may go on', () => {
    expect(ownerOnly(governedDevice(true), ACT)).toBeUndefined();
  });

  test('G22 G25 the owner at the machine (ungoverned) goes on with no passkey', () => {
    expect(ownerOnly(ownerStanding('cli'), ACT)).toBeUndefined();
    expect(ownerOnly(ownerStanding('ui'), ACT)).toBeUndefined();
  });
});

describe('claimOwnerOnly: one fresh proof admits one act', () => {
  /** One proof, claimed atomically as Access claims it; each call's standing is a snapshot that says it is fresh. */
  function oneProof() {
    const state = { fresh: true, claims: 0 };
    const call = (): OwnerOnlyCall => ({
      ...governedDevice(true),
      claimFreshStepUp: () => {
        state.claims += 1;
        if (!state.fresh) return false;
        state.fresh = false;
        return true;
      },
    });
    return { state, call };
  }

  test('G22 G25 a governed device with a fresh proof goes on by CLAIMING it, so the next act is asked again', () => {
    const proof = oneProof();
    const [first, second] = [proof.call(), proof.call()];
    expect(claimOwnerOnly(first, ACT)).toBeUndefined();
    const answer = claimOwnerOnly(second, ACT);
    expect([answer?.status, JSON.parse(answer?.body ?? '{}').code, proof.state]).toEqual([
      403,
      STEP_UP_REQUIRED_CODE,
      { fresh: false, claims: 2 },
    ]);
  });

  test('G22 G25 a governed device whose claim is answered false (no proved device) is refused: fail closed', () => {
    expect(claimOwnerOnly(governedDevice(true), ACT)?.status).toBe(403);
  });

  test('G22 G25 the owner at the machine claims nothing, and a ferret is refused before any claim', () => {
    let claims = 0;
    const claim = () => {
      claims += 1;
      return true;
    };
    expect(claimOwnerOnly({ ...ownerStanding('cli'), claimFreshStepUp: claim }, ACT)).toBeUndefined();
    expect(
      refusedWith(() => claimOwnerOnly({ ...ferretStanding('F1' as FerretId), claimFreshStepUp: claim }, ACT)),
    ).toMatchObject({ status: 403, code: 'forbidden' });
    expect(claimOwnerOnly({ ...governedDevice(false), claimFreshStepUp: claim }, ACT)?.status).toBe(403);
    expect(claims).toBe(0);
  });
});
