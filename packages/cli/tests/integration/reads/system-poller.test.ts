import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { FileMarkerProbe, SystemPollClock } from '../../../src/adapters/reads/system-poller.ts';

describe('the real operator-read clock', () => {
  it('should report wall time and sleep normally', async () => {
    // Arrange
    const clock = new SystemPollClock();
    const before = Date.now();

    // Act
    await clock.sleep(5);
    const observed = clock.nowMs();

    // Assert
    should(observed).be.aboveOrEqual(before);
  });

  it('should release a long sleep as soon as the caller leaves', async () => {
    // Arrange
    const clock = new SystemPollClock();
    const controller = new AbortController();

    // Act
    const sleeping = clock.sleep(30_000, controller.signal);
    controller.abort();
    await sleeping;

    // Assert
    should(controller.signal.aborted).be.true();
  });

  it('should resolve immediately for an already-cancelled caller', async () => {
    // Arrange
    const clock = new SystemPollClock();
    const controller = new AbortController();
    controller.abort();

    // Act / Assert
    await should(clock.sleep(30_000, controller.signal)).be.fulfilled();
  });

  it('should expose and release one deadline timer', async () => {
    // Arrange
    const clock = new SystemPollClock();
    const elapsed = clock.startDeadline(5);
    const cancelled = clock.startDeadline(30_000);

    // Act
    await clock.sleep(30_000, elapsed.signal);
    cancelled.cancel();

    // Assert
    should(elapsed.signal.aborted).be.true();
    should(cancelled.signal.aborted).be.false();
  });
});

describe('the real marker probe', () => {
  it('should resolve relative markers against the invocation directory and report evidence exactly', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'fy-reads-'));
    const marker = join(directory, 'done.md');
    const probe = new FileMarkerProbe(directory);
    try {
      // Act / Assert
      should(probe.resolve('done.md')).equal(marker);
      should(probe.resolve(marker)).equal(marker);
      should(await probe.exists(marker)).be.false();
      await Bun.write(marker, 'done');
      should(await probe.exists('done.md')).be.true();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
