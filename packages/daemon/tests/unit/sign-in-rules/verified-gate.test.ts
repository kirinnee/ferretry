import { describe, it } from 'bun:test';
import type { SignInId, SignInRuleId, StoredStepUpProof } from '@ferretry/protocol';
import should from 'should';
import {
  approved,
  DEVICE,
  deviceOwner,
  GITHUB as GITHUB_SIGN_IN,
  listing,
  OTHER_DEVICE,
  signIn,
  tappedFact,
  type World,
  world,
} from './support.ts';

/**
 * `verified()` IS FALSE WHILE ANY RE-CHECK IS PENDING (secrev-1282b F3): the fill's last check reads it with nothing
 * awaited, so a passkey change or a settle that is still checking must not leave an older "yes" readable meanwhile.
 */

const GITLAB = 'si_00000000000000a5' as SignInId;

/** GitHub and GitLab, both of one account and both with the owner's tapped history: two rules can be made. */
function twoSites() {
  const base = listing();
  return {
    ...base,
    signIns: [
      ...base.signIns,
      signIn({
        id: GITLAB,
        place: { kind: 'site', domains: ['gitlab.com'], match: [] },
        observed: [tappedFact('gitlab.com')],
      } as never),
    ],
  };
}

/** A gate a test opens by hand: `wait` pauses until `open` runs. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { wait: async () => await opened, open: () => open() };
}

/** Lets queued work reach its first await. */
const tick = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 5));

/** Wraps the fake registry's offline check so a test can hold it open or make it fail for one device. */
function steer(w: World) {
  const original = w.proofs.verify.bind(w.proofs);
  const state: { hold?: ReturnType<typeof gate>; failFor?: string } = {};
  w.proofs.verify = async (proof: StoredStepUpProof, challenge: Uint8Array) => {
    if (state.failFor === proof.deviceId) throw new Error('the registry cannot be read for this device');
    await state.hold?.wait();
    return await original(proof, challenge);
  };
  return state;
}

describe('verified(): false while a re-check is pending (secrev-1282b F3)', () => {
  it('should read false from the moment a passkey change is signalled until its checks finish', async () => {
    const w = await world();
    const { view } = await approved(w);
    const rule = view.id as SignInRuleId;
    should(w.service.verified(rule, 1)).be.true();
    const steering = steer(w);
    steering.hold = gate();

    const change = w.service.passkeysChanged({ cause: 'passkey-removed', deviceId: 'someone-else' } as never);
    // Synchronously, before the queued check even starts: the old answer is no longer readable.
    should(w.service.verified(rule, 1)).be.false();
    await tick();
    should(w.service.verified(rule, 1)).be.false();
    steering.hold.open();
    await change;

    should(w.service.verified(rule, 1)).be.true();
  });

  it('should read false while a settle re-checks, though an earlier check left this rule verified', async () => {
    const w = await world({ listing: twoSites() as never });
    const { view } = await approved(w);
    await approved(w, { signIn: GITLAB, fields: ['username', 'password'] }, deviceOwner(OTHER_DEVICE), OTHER_DEVICE);
    const github = view.id as SignInRuleId;
    should(w.service.verified(github, 1)).be.true();
    // One device's proof can't be checked: GitHub's rule stays verified, the service is left with a check owed.
    const steering = steer(w);
    steering.failFor = OTHER_DEVICE;
    await w.service.passkeysChanged({ cause: 'passkey-removed', deviceId: 'someone-else' } as never);
    should(w.service.verified(github, 1)).be.false();

    // The next sweep settles it; while its checks are in flight, nothing reads verified.
    steering.failFor = undefined;
    steering.hold = gate();
    const sweep = w.service.sweepRules();
    await tick();
    should(w.service.verified(github, 1)).be.false();
    steering.hold.open();
    await sweep;

    should(w.service.verified(github, 1)).be.true();
  });

  it('should read false while a revoked device’s rules are being suspended', async () => {
    const w = await world();
    const { view } = await approved(w);
    const rule = view.id as SignInRuleId;
    let release: () => void = () => undefined;
    w.store.beforeWrite = async () => await new Promise<void>(resolve => (release = resolve));
    const forgotten = w.service.forgetDevice(DEVICE);
    should(w.service.verified(rule, 1)).be.false();
    await tick();
    release();
    w.store.beforeWrite = undefined;
    await forgotten;
    should(w.service.verified(rule, 1)).be.false();
  });
});

describe('verified(): false while an account change, a suspension, a revoke or a narrowing waits its turn (delta F5)', () => {
  it('should read false from the moment each is asked for, and true again once one that changes nothing has run', async () => {
    const w = await world();
    const { view } = await approved(w, { signIn: GITHUB_SIGN_IN, fields: ['username', 'password'], uses: 5 });
    const rule = view.id as SignInRuleId;
    should(w.service.verified(rule, 1)).be.true();

    const changed = w.service.accountsChanged(w.state.listing);
    should(w.service.verified(rule, 1)).be.false();
    await changed;
    should(w.service.verified(rule, 1)).be.true();

    const narrowed = w.service.narrow(deviceOwner(), rule, { uses: 4 });
    should(w.service.verified(rule, 1)).be.false();
    await narrowed;
    should(w.service.verified(rule, 1)).be.true();

    const suspended = w.service.suspend(rule, 'did-not-move-on', { revision: 1 });
    should(w.service.verified(rule, 1)).be.false();
    await suspended;
    should(w.service.verified(rule, 1)).be.false();
  });

  it('should read false while a revoke waits its turn', async () => {
    const w = await world();
    const { view } = await approved(w);
    const rule = view.id as SignInRuleId;
    const revoked = w.service.revoke(deviceOwner(), rule);
    should(w.service.verified(rule, 1)).be.false();
    await revoked;
  });
});
