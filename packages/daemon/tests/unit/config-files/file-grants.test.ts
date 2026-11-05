import { describe, it } from 'bun:test';
import type { GrantRefusal } from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance, CapabilityDemand } from '../../../src/lib/api/capability.ts';
import { configFileDemand, configFileWriteRefusal } from '../../../src/lib/config-files/file-grants.ts';

/** A caller the operator's grants answer `refusal` for every capability named in `verdicts`, granted otherwise. */
function governance(
  verdicts: Partial<Record<'fleet' | 'warden', GrantRefusal>>,
  governed: boolean,
  asked: CapabilityDemand[] = [],
): CallerGovernance {
  return {
    governed,
    decide: demand => {
      asked.push(demand);
      const refusal = verdicts[demand.capability as 'fleet' | 'warden'] ?? 'granted';
      return { allowed: refusal === 'granted', refusal };
    },
  };
}

describe('configFileDemand: the one question a file write asks', () => {
  it('should ask the Warden grant for warden.yaml and the fleet grant for every other file', () => {
    should(configFileDemand('warden.yaml', 'configure')).eql({ capability: 'warden', axis: 'configure' });
    for (const path of ['learning.yaml', 'voice.yaml', 'machine.yaml', 'profiles/default.yaml']) {
      should(configFileDemand(path, 'configure')).eql({ capability: 'fleet', axis: 'configure' });
    }
  });

  it('should carry the axis and mark a narrowing act', () => {
    should(configFileDemand('warden.yaml', 'use')).eql({ capability: 'warden', axis: 'use' });
    should(configFileDemand('warden.yaml', 'configure', true)).eql({
      capability: 'warden',
      axis: 'configure',
      narrowing: true,
    });
  });
});

describe('configFileWriteRefusal: a copy writes a file only where a direct write could', () => {
  it('should allow a caller the grants allow, asking exactly the demands GET and PUT /v1/config/file ask', () => {
    const asked: CapabilityDemand[] = [];
    should(configFileWriteRefusal(governance({}, true, asked), 'warden.yaml', 'apply')).be.undefined();
    should(asked).eql([configFileDemand('warden.yaml', 'use'), configFileDemand('warden.yaml', 'configure')]);
  });

  it('should not show a device what it may not read: a review of warden.yaml is refused like a read of it', () => {
    const blind = {
      governed: true,
      decide: (demand: CapabilityDemand) => ({
        allowed: !(demand.capability === 'warden' && demand.axis === 'use'),
        refusal: demand.capability === 'warden' && demand.axis === 'use' ? 'not-granted' : 'granted',
      }),
    } as CallerGovernance;
    should(configFileWriteRefusal(blind, 'warden.yaml', 'describe')).equal('this device may not read warden.yaml');
    should(configFileWriteRefusal(blind, 'voice.yaml', 'describe')).be.undefined();
  });

  it('should refuse a governed device the file’s grant does not allow, and name the file', () => {
    const device = governance({ warden: 'device-not-granted' }, true);
    should(configFileWriteRefusal(device, 'warden.yaml', 'apply')).equal('this device may not change warden.yaml');
    should(configFileWriteRefusal(device, 'warden.yaml', 'describe')).equal('this device may not change warden.yaml');
    // The same device may still write the files its fleet grant covers.
    should(configFileWriteRefusal(device, 'voice.yaml', 'apply')).be.undefined();
  });

  it('should treat a relayed caller as a remote one: governed, so the grants decide, and no loosening of its own', () => {
    // A relayed browser arrives with `governed: true` whatever address the relay shows (docs/grants.md).
    const relayed = governance({ warden: 'not-granted' }, true);
    should(relayed.governed).equal(true);
    should(configFileWriteRefusal(relayed, 'warden.yaml', 'apply')).equal('this device may not change warden.yaml');
  });

  it('should ask a passkey only at the apply, so a copy can still be staged', () => {
    const needsPasskey = governance({ warden: 'step-up-required' }, true);
    should(configFileWriteRefusal(needsPasskey, 'warden.yaml', 'describe')).be.undefined();
    should(configFileWriteRefusal(needsPasskey, 'warden.yaml', 'apply')).equal(
      'changing warden.yaml from this device needs a passkey confirmation',
    );
  });

  it('should refuse when nothing can say what the caller may do', () => {
    should(configFileWriteRefusal(undefined, 'warden.yaml', 'describe')).containEql('daemon bug');
    should(configFileWriteRefusal(undefined, 'warden.yaml', 'apply')).containEql('nothing was changed');
  });
});
