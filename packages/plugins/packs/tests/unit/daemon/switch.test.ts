import { describe, it } from 'bun:test';
import should from 'should';
import { packSwitchOutcome } from '../../../daemon/lib/switch.ts';

describe('packSwitchOutcome', () => {
  it('should say nothing changed when the switch already stood there, absent reading as on', () => {
    should(packSwitchOutcome({ enabled: undefined, running: true }, true)).deepEqual({
      restartRequired: false,
      note: 'Pack mode was already on.',
    });
    should(packSwitchOutcome({ enabled: false, running: false }, false).note).equal('Pack mode was already off.');
  });

  it('should ask for a restart only when a running ferret’s switch changed, and say what that means', () => {
    should(packSwitchOutcome({ enabled: false, running: true }, true)).deepEqual({
      restartRequired: true,
      note: 'Pack mode is on. This ferret is running, so it is told when it restarts.',
    });
    should(packSwitchOutcome({ enabled: true, running: true }, false)).deepEqual({
      restartRequired: true,
      note: 'Pack mode is off. This ferret is running, so it is told when it restarts; it can start no sub-ferret from now.',
    });
  });

  it('should take effect at the next launch for a ferret that is not running', () => {
    should(packSwitchOutcome({ enabled: true, running: false }, false)).deepEqual({
      restartRequired: false,
      note: 'Pack mode is off; this ferret is not running, so it takes effect at its next launch.',
    });
    should(packSwitchOutcome({ enabled: false, running: false }, true).note).equal(
      'Pack mode is on; this ferret is not running, so it takes effect at its next launch.',
    );
  });
});
