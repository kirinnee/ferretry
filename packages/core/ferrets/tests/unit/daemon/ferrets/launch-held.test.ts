import { describe, expect, test } from 'bun:test';
import { ferretId, T0 } from '../../../../contract/testing/index.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import type { SessionCutOffMark } from '../../../../daemon/lib/tokens/cut-off-mark.ts';
import { KeyedSerialExecutor } from '../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * The held variants a lifecycle calls while it ALREADY holds the ferret's key on the shared queue: they do the launch and
 * the stop the service makes, never wait for the key they would deadlock on, and give a cut-off ferret no way back.
 * Fakes only.
 */

/** A fixture whose service runs on a shared queue that a "lifecycle" holds the ferret's key on. */
function holding(options: Parameters<typeof additivesFixture>[0] = {}, cutOffMark?: SessionCutOffMark) {
  const shared = new KeyedSerialExecutor();
  const base = additivesFixture(options);
  const decided: string[] = [];
  const decide = base.ports.decide;
  base.ports.decide = async input => {
    decided.push(input.ferret);
    return await decide(input);
  };
  const service = new FerretsService(base.registry, base.tokens, {
    ...base.ports,
    serial: shared,
    ...(cutOffMark === undefined ? {} : { cutOffMark }),
  });
  return { ...base, service, shared, decided };
}

describe('launchHeld', () => {
  test('should launch a stopped ferret while the caller holds its key, instead of waiting for the key', async () => {
    // Arrange
    const f = holding();

    // Act — the lifecycle's own hold is on the queue for the whole call; a launch that took the key would never return
    const answer = await f.shared.run(f.id, async () => await f.service.launchHeld(f.id));

    // Assert
    expect(answer).toEqual({ ok: true, value: f.id });
    expect(f.runner.starts).toBe(1);
    expect(f.registry.get(f.id)?.state).toBe('working');
  });

  test('should answer ok and start nothing for a ferret that is already running', async () => {
    // Arrange
    const f = holding({ state: 'working' });

    // Act
    const answer = await f.service.launchHeld(f.id);

    // Assert
    expect(answer).toEqual({ ok: true, value: f.id });
    expect(f.runner.starts).toBe(0);
  });

  test('should refuse a ferret the registry does not hold, and make none', async () => {
    // Arrange
    const f = holding({ empty: true });

    // Act
    const answer = await f.service.launchHeld(ferretId('ghost'));

    // Assert
    expect(answer).toEqual({ ok: false, error: { code: 'refused', reason: 'no ferret ghost' } });
    expect(f.runner.starts).toBe(0);
    expect(f.registry.get(ferretId('ghost'))).toBeUndefined();
  });

  test('should refuse a ferret the token directory says the owner cut off, with no way to restore it', async () => {
    // Arrange
    const f = holding();
    f.tokens.cutOff(f.id, T0);

    // Act
    const answer = await f.service.launchHeld(f.id);

    // Assert — nothing launched, the start gate never asked, the record untouched, and the cut-off still stands
    expect(f.decided).toEqual([]);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
    expect(answer).toEqual({
      ok: false,
      error: { code: 'refused', reason: 'the owner cut off this ferret; a confirmed owner resume is required' },
    });
    expect(f.runner.starts).toBe(0);
    expect(f.tokens.isCutOff(f.id)).toBe(true);
  });

  test('should refuse a ferret only the session document says was cut off, and leave the mark in place', async () => {
    // Arrange
    const cut = new Set<string>([ferretId('fern')]);
    const f = holding(
      {},
      {
        isCutOff: async id => cut.has(id),
        cutOff: async id => void cut.add(id),
        restore: async id => void cut.delete(id),
      },
    );

    // Act
    const answer = await f.service.launchHeld(f.id);

    // Assert
    expect(answer.ok).toBe(false);
    expect(f.runner.starts).toBe(0);
    expect(cut.has(f.id)).toBe(true);
  });
});

describe('stopHeld', () => {
  test('should stop a running ferret while the caller holds its key, instead of waiting for the key', async () => {
    // Arrange
    const f = holding();
    await f.service.launchHeld(f.id);
    const handle = f.registry.get(f.id)?.handle;

    // Act
    await f.shared.run(f.id, async () => await f.service.stopHeld(f.id, 'now', 'for a test', { kind: 'stopped' }));

    // Assert
    expect(f.registry.get(f.id)?.state).toBe('stopped');
    expect(await f.runner.alive(handle as never)).toBe(false);
  });
});
