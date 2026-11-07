import { expect, test } from 'bun:test';
import { additivesFixture } from './additives-fixture.ts';

test('R-0363 a plain resume of a running ferret is the send shortcut: nothing is relaunched', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const before = await f.service.handle(f.id);
  const again = await f.service.resume(f.id, 'carry on');
  expect(again.ok).toBe(true);
  expect(f.runner.starts).toBe(1);
  expect(await f.service.handle(f.id)).toBe(before);
});

test('R-0363 only replaceLiveTerminal gives the shortcut up: the live pane is stopped and the ferret relaunched', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const before = (await f.service.handle(f.id))!;
  const replaced = await f.service.resume(f.id, undefined, { replaceLiveTerminal: true });
  expect(replaced.ok).toBe(true);
  expect(await f.runner.alive(before)).toBe(false);
  expect(f.runner.starts).toBe(2);
  expect(await f.runner.alive((await f.service.handle(f.id))!)).toBe(true);
  expect(f.history.at(-1)).toEqual({ type: 'session.resumed', data: { replacedLiveTerminal: true } });
});

test('R-0363 an explicit person’s resume is not automatic; the automatic flag is recorded only when set', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id, 'wake up');
  expect(f.history.at(-1)).toEqual({ type: 'session.resumed', data: { message: 'wake up' } });
  await f.service.stop(f.id, 'now');
  await f.service.resume(f.id, undefined, { automatic: true });
  expect(f.history.at(-1)).toEqual({ type: 'session.resumed', data: { automatic: true } });
});

test('R-0363 replacing a live pane fails closed (503) when the harness that must stop it is off', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  f.ports.harness = () => undefined;
  await expect(f.service.resume(f.id, undefined, { replaceLiveTerminal: true })).rejects.toMatchObject({
    status: 503,
    code: 'plugin_unavailable',
  });
  expect(f.runner.starts).toBe(1);
  expect(f.registry.get(f.id)?.state).toBe('working');
});
