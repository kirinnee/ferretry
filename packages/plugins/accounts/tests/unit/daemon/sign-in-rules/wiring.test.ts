import { describe, it } from 'bun:test';
import { DevicesChanged } from '@ferretry/plugin-access/contract';
import should from 'should';
import type { SignInRuleStageId } from '../../../../contract/routes/index.ts';
import type { PasskeysChangedListener } from '../../../../daemon/lib/local-ports.ts';
import {
  connectSignInRules,
  onDevicesChanged,
  type RuleListing,
  SignInRuleDevicePurge,
} from '../../../../daemon/lib/sign-in-rules/index.ts';
import { approved, CREDENTIAL, DEVICE, GITHUB, HOST_OWNER, listing, OTHER_DEVICE, world } from './support.ts';

/**
 * THE THREE HOOKS THAT KEEP THE RULES TOLD (secrev-1274b L4): every committed account change, every passkey change and
 * every device revocation reaches the rule service through {@link connectSignInRules}. In 5.0 a revoked or idle-expired
 * device arrives as Access's `DevicesChanged` (lead decision), handled by {@link onDevicesChanged}.
 */

const status = async (w: Awaited<ReturnType<typeof world>>): Promise<string | undefined> => {
  const [rule] = (await w.service.list(HOST_OWNER)).rules;
  return rule?.suspended?.because ?? rule?.status;
};

function hooks() {
  let follow: ((after: RuleListing) => Promise<void>) | undefined;
  const listeners: PasskeysChangedListener[] = [];
  return {
    accounts: {
      followRulesWith: (next: (after: RuleListing) => Promise<void>) => {
        follow = next;
      },
    },
    passkeys: {
      subscribe: (listener: PasskeysChangedListener) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    devices: new SignInRuleDevicePurge(),
    commit: async (after: RuleListing) => await follow?.(after),
    emit: async (change: Parameters<PasskeysChangedListener>[0]) => {
      for (const listener of listeners) await listener(change);
    },
  };
}

const moved = (): RuleListing => {
  const base = listing();
  return {
    ...base,
    signIns: base.signIns.map(each =>
      each.id === GITHUB ? { ...each, place: { kind: 'site', domains: ['gh.io'], match: [] } } : each,
    ),
  } as never;
};

describe('connectSignInRules', () => {
  it('should follow every committed account change', async () => {
    const w = await world();
    const h = hooks();
    connectSignInRules(w.service, h);
    await approved(w);
    await h.commit(moved());
    should(await status(w)).equal('place-changed');
  });

  it('S119 should hear the passkeys-changed signal and check every proof again', async () => {
    const w = await world();
    const h = hooks();
    connectSignInRules(w.service, h);
    await approved(w);
    w.proofs.held.delete(`${DEVICE}:${CREDENTIAL}`);
    await h.emit({ cause: 'device-forgotten', deviceId: DEVICE });
    should(await status(w)).equal('passkey-removed');
  });

  it('should take the device purge, which does nothing before it is connected', async () => {
    const w = await world();
    const h = hooks();
    await h.devices.forgetDevice(DEVICE);
    connectSignInRules(w.service, h);
    await approved(w);
    await h.devices.forgetDevice(DEVICE);
    should(await status(w)).equal('passkey-removed');
  });

  it('should leave the rules untold when it is not called', async () => {
    const w = await world();
    const h = hooks();
    await approved(w);
    await h.commit(moved());
    await h.emit({ cause: 'device-forgotten', deviceId: DEVICE });
    await h.devices.forgetDevice(DEVICE);
    should(await status(w)).equal('active');
  });
});

describe('Access DevicesChanged suspends the rules a gone device approved', () => {
  const payload = (change: 'paired' | 'revoked' | 'expired' | 'grants', device = DEVICE) =>
    DevicesChanged.schema.parse({ device, change });

  for (const change of ['revoked', 'expired'] as const)
    it(`P124 should suspend every rule a ${change} device approved, as passkey-removed`, async () => {
      const w = await world();
      await approved(w);
      await onDevicesChanged(w.service)(payload(change));
      should(await status(w)).equal('passkey-removed');
    });

  for (const change of ['paired', 'grants'] as const)
    it(`P124 should leave the rules alone when a device is ${change}`, async () => {
      const w = await world();
      await approved(w);
      await onDevicesChanged(w.service)(payload(change));
      should(await status(w)).equal('active');
    });

  it('P124 should leave another device’s rules standing', async () => {
    const w = await world();
    await approved(w);
    await onDevicesChanged(w.service)(payload('revoked', OTHER_DEVICE));
    should(await status(w)).equal('active');
  });

  it('S119 P124 should attempt every purge even when an earlier one fails, and never throw into the revocation', async () => {
    const calls: string[] = [];
    const failed: unknown[] = [];
    const rules = {
      forgetDevice: async () => {
        calls.push('forget');
        throw new Error('the rules file cannot be written');
      },
      passkeysChanged: async () => {
        calls.push('recheck');
      },
    };
    await onDevicesChanged(rules, error => void failed.push(error))(payload('revoked'));
    should(calls).eql(['forget', 'recheck']);
    should(failed).have.length(1);
  });

  it('S119 should suspend a revoked device’s rule even when the passkey recheck that follows fails', async () => {
    const w = await world();
    await approved(w);
    w.proofs.broken = true;
    await onDevicesChanged(w.service)(payload('revoked'));
    should(await status(w)).equal('passkey-removed');
  });

  it('P124 should find no challenge for a stage the revoked device had waiting', async () => {
    const w = await world();
    const staged = await w.service.stage(
      { kind: 'owner', actor: { kind: 'device', deviceId: DEVICE } },
      {
        signIn: GITHUB,
        fields: ['password'],
      },
    );
    should(w.service.challengeOf(staged.stage as SignInRuleStageId, DEVICE)).not.be.undefined();
    await onDevicesChanged(w.service)(payload('revoked'));
    should(w.service.challengeOf(staged.stage as SignInRuleStageId, DEVICE)).be.undefined();
  });
});
