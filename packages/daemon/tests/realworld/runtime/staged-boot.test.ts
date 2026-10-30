/**
 * Asserts wall-clock speed; the outcome depends on the machine, not the code.
 *
 * A daemon whose boot takes time must still answer liveness within a second of starting. The
 * deterministic half (503 `starting` naming the step, then 200) is the integration tier's.
 */
import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import {
  bootStagedDaemon as boot,
  liveness,
  stopStagedDaemons,
  until,
} from '../../integration/support/staged-boot-daemon.ts';

afterEach(stopStagedDaemons);

describe('a daemon whose boot takes time', () => {
  it('should answer liveness within a second of starting, naming the step it is on', async () => {
    // Arrange
    const daemon = await boot('slow');

    // Act
    const first = await until(
      () => liveness(daemon.base),
      () => true,
      'the first liveness answer',
    );
    const onStep = await until(
      () => liveness(daemon.base),
      answer => answer.body.boot?.step === 'opening the usage feed',
      'the slow step to be reported',
    );

    // Assert
    const startedAtMs = daemon.startedAtMs();
    should(startedAtMs).not.be.undefined();
    should(first.atMs - (startedAtMs ?? 0)).be.below(1_000);
    should(onStep.atMs - (startedAtMs ?? 0)).be.below(1_000);
  }, 30_000);
});
