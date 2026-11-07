import { expect, test } from 'bun:test';
import { FakeHarness } from '../../../../contract/testing/index.ts';
import { additivesFixture } from './additives-fixture.ts';

test('a plain resume of a running ferret is the send shortcut: nothing is relaunched', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const before = await f.service.handle(f.id);
  const again = await f.service.resume(f.id, 'carry on');
  expect(again.ok).toBe(true);
  expect(f.runner.starts).toBe(1);
  expect(await f.service.handle(f.id)).toBe(before);
});

test('only replaceLiveTerminal gives the shortcut up: the live pane is stopped and the ferret relaunched', async () => {
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

test('an explicit person’s resume is not automatic; the automatic flag is recorded only when set', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id, 'wake up');
  expect(f.history.at(-1)).toEqual({ type: 'session.resumed', data: { message: 'wake up' } });
  await f.service.stop(f.id, 'now');
  await f.service.resume(f.id, undefined, { automatic: true });
  expect(f.history.at(-1)).toEqual({ type: 'session.resumed', data: { automatic: true } });
});

test('replacing a live pane with the same harness off is refused by the launch check, before the pane is stopped', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const before = (await f.service.handle(f.id))!;
  f.ports.harness = () => undefined;
  const refused = await f.service.resume(f.id, undefined, { replaceLiveTerminal: true });
  expect(refused).toMatchObject({ ok: false, error: { code: 'harness_unavailable' } });
  expect(f.runner.starts).toBe(1);
  expect(f.registry.get(f.id)).toMatchObject({ state: 'working', handle: before });
});

test('replacing a live pane fails closed (503) when the harness that must stop it is off but the target’s is on', async () => {
  const f = additivesFixture();
  const codex = new FakeHarness('codex', '/home/codex-homes');
  await f.service.resume(f.id);
  f.ports.harness = key => (key === 'codex' ? codex : undefined);
  f.ports.harnessKeys = () => ['claude-code', 'codex'];
  await expect(
    f.service.resume(f.id, undefined, { replaceLiveTerminal: true, target: { runtime: 'codex-two', harness: 'codex' } }),
  ).rejects.toMatchObject({ status: 503, code: 'plugin_unavailable' });
  expect(f.runner.starts).toBe(1);
  expect(f.registry.get(f.id)?.state).toBe('working');
});

test('the port’s resume options carry only automatic: replacing a live pane is the service’s own option', () => {
  const port: import('../../../../contract/index.ts').ResumeOptions = { automatic: true };
  // @ts-expect-error replaceLiveTerminal is not on the public port
  const refused: import('../../../../contract/index.ts').ResumeOptions = { replaceLiveTerminal: true };
  expect(port.automatic).toBe(true);
  expect(Object.keys(refused)).toEqual(['replaceLiveTerminal']);
});

test('a refused start gate leaves a working ferret working, on the same handle, with nothing stopped', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const before = (await f.service.handle(f.id))!;
  const stopping: string[] = [];
  f.ports.stopping = ferret => stopping.push(ferret);
  f.ports.decide = async () => ({ allow: false, reason: 'the account is over its limit' });
  const refused = await f.service.resume(f.id, undefined, { replaceLiveTerminal: true });
  expect(refused).toEqual({ ok: false, error: { code: 'refused', reason: 'the account is over its limit' } });
  expect(f.registry.get(f.id)?.state).toBe('working');
  expect(await f.service.handle(f.id)).toBe(before);
  expect(await f.runner.alive(before)).toBe(true);
  expect(f.runner.starts).toBe(1);
  expect(stopping).toEqual([]);
});

test('a launch precondition that fails (a harness that is off, no runner, an unusable home) leaves the live pane alone', async () => {
  for (const spoil of [
    (f: ReturnType<typeof additivesFixture>) => {
      f.ports.harness = () => undefined;
    },
    (f: ReturnType<typeof additivesFixture>) => {
      f.ports.runner = () => undefined;
    },
    (f: ReturnType<typeof additivesFixture>) => {
      f.harness.homeFor = async () => '/home/agent-homes/../shared' as never;
    },
  ]) {
    const f = additivesFixture();
    await f.service.resume(f.id);
    const before = (await f.service.handle(f.id))!;
    spoil(f);
    const outcome = await f.service
      .resume(f.id, undefined, { replaceLiveTerminal: true })
      .catch((error: unknown) => ({ thrown: error }));
    expect('thrown' in outcome || outcome.ok === false).toBe(true);
    expect(f.registry.get(f.id)).toMatchObject({ state: 'working', handle: before });
  }
});
