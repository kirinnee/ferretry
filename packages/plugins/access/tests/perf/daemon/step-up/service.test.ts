import { describe, it } from 'bun:test';
import should from 'should';
import { PasskeysChangedSignal } from '../../../../daemon/lib/step-up/index.ts';
import { after, fixture, phone } from '../../../support/daemon/step-up-fixture.ts';

// The speed half of the passkeys-changed signal in `tests/unit/daemon/step-up/service.test.ts`: a listener that never
// settles holds the removal for its own bound (20 ms) and not past 2 s. The unit file proves the removal still answers,
// every listener hears it and the hung one is reported.
describe('the passkeys-changed signal', () => {
  it('should answer the removal within 2 s on a listener that hangs', async () => {
    const signal = new PasskeysChangedSignal(after, () => undefined, 20);
    const { service } = fixture({ passkeysChanged: signal });
    signal.subscribe(() => new Promise<void>(() => undefined));
    signal.subscribe(() => undefined);

    const startedAt = Date.now();
    await service.forgetDevice(phone.deviceId);

    should(Date.now() - startedAt).be.below(2_000);
  });
});
