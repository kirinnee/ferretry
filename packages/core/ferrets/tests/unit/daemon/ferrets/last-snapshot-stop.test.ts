import { describe, expect, test } from 'bun:test';
import type { RunnerLook } from '../../../../contract/index.ts';
import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { fixture, SECRET } from '../../../support/daemon/last-snapshot-stop-fixture.ts';

describe('F-0326 every stop keeps the last screen, masked, before the pane goes', () => {
  for (const [how, cause] of [
    ['now', undefined],
    ['polite', undefined],
    ['now', { kind: 'completed' }],
  ] as const)
    test(`F-0326 a ${how} stop${cause === undefined ? '' : ' (signal done)'} looks first, then stops the pane`, async () => {
      const f = fixture();
      await f.live(`last words ${SECRET}`);
      await f.service.stop(f.id, how, undefined, cause);
      expect(f.events).toEqual(['look', 'kept', `stop:${how}`]);
      expect(f.stored).toEqual([`last words ${'*'.repeat(SECRET.length)}`]);
      expect(f.registry.get(f.id)?.state).toBe('stopped');
    });

  test('F-0326 a pane a move replaces is kept before it is stopped', async () => {
    const f = fixture();
    await f.live('before the move');
    expect((await f.service.resume(f.id, undefined, { origin: PERSON_ORIGIN, replaceLiveTerminal: true })).ok).toBe(
      true,
    );
    expect(f.events.slice(0, 3)).toEqual(['look', 'kept', 'stop:now']);
    expect(f.stored).toEqual(['before the move']);
  });

  test('F-0326 a look that hangs never holds the stop: it completes after the bound with no file', async () => {
    const f = fixture();
    const handle = await f.live('never read');
    f.runner.look = async () => await new Promise<RunnerLook | undefined>(() => {});
    await f.service.stop(f.id, 'now');
    expect(f.events).toEqual(['look', 'stop:now']);
    expect(f.stored).toEqual([]);
    expect(await f.runner.alive(handle)).toBe(false);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
  });

  test('F-0326 a capture port that rejects never fails the stop', async () => {
    const f = fixture();
    await f.live('x');
    f.ports.lastSnapshot = async () => {
      throw new Error('the capture broke');
    };
    await f.service.stop(f.id, 'now');
    expect(f.events).toEqual(['stop:now']);
    expect(f.registry.get(f.id)?.state).toBe('stopped');
  });

  test('F-0326 a pane already gone keeps no file and the stop goes on; a stopped ferret is not looked at', async () => {
    const f = fixture();
    const handle = await f.live('gone');
    await f.runner.stop(handle);
    await f.service.stop(f.id, 'now');
    expect(f.events).toEqual(['look', 'stop:now']);
    expect(f.stored).toEqual([]);
    f.events.length = 0;
    await f.service.stop(f.id, 'now');
    expect(f.events).toEqual([]);
  });
});
