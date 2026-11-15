import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { expect, test } from 'bun:test';
import { FerretsPort, FerretTokensFile } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import { host as plainHost } from './route-fixture.ts';

/**
 * The loop c58-16 closes: Conversation records a ferret's own compact-at through `FerretsApi.setCompactAt`, and the very
 * next launch of that ferret — a start's relaunch or a resume — carries it as `LaunchSpec.compactAt`, with nothing else
 * in between. A clear puts the launch back on what it followed before.
 */
const host = async (...args: Parameters<typeof plainHost>) => {
  const h = await plainHost(...args);
  h.state('ferrets').plant(FerretTokensFile, JSON.stringify({ format: 1, tokens: [] }));
  return await h.restart();
};

test('a value set through the port is the compactAt of the ferret’s next launch, and a clear takes it away again', async () => {
  const harness = new FakeHarness();
  const h = await host([], { harness, runner: new FakeRunner() });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'one' },
    body: { folder: '/work/one' },
  });
  expect(started.status).toBeLessThan(300);
  const ferret = harness.launched[0]!.ferret;
  const ferrets = h.provided(FerretsPort);
  expect(harness.launched[0]?.compactAt).toBeUndefined();

  await ferrets.setCompactAt?.(ferret, 300_000);
  await ferrets.stop(ferret, 'now');
  expect((await ferrets.resume(ferret, 'again', { origin: PERSON_ORIGIN })).ok).toBe(true);
  expect(harness.launched.at(-1)?.compactAt).toBe(300_000);
  expect(await ferrets.compactAt?.(ferret)).toBe(300_000);

  await ferrets.setCompactAt?.(ferret, undefined);
  await ferrets.stop(ferret, 'now');
  expect((await ferrets.resume(ferret, 'once more', { origin: PERSON_ORIGIN })).ok).toBe(true);
  expect(harness.launched.at(-1)?.compactAt).toBeUndefined();
  expect(await ferrets.compactAt?.(ferret)).toBeUndefined();

  await expect(ferrets.setCompactAt?.(ferretId('nobody'), 300_000)).rejects.toMatchObject({ status: 404 });
});

test('a clear after an explicit start value puts the ferret back on its login: neither the read nor the next launch brings the start value back', async () => {
  const harness = new FakeHarness();
  const h = await host([], { harness, runner: new FakeRunner() });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'two' },
    body: { folder: '/work/two', compactAt: 200_000 },
  });
  expect(started.status).toBeLessThan(300);
  const ferret = harness.launched[0]!.ferret;
  const ferrets = h.provided(FerretsPort);
  expect(harness.launched[0]?.compactAt).toBe(200_000);

  await ferrets.setCompactAt?.(ferret, 300_000);
  expect(await ferrets.compactAt?.(ferret)).toBe(300_000);

  await ferrets.setCompactAt?.(ferret, undefined);
  expect(await ferrets.compactAt?.(ferret)).toBeUndefined();
  await ferrets.stop(ferret, 'now');
  expect((await ferrets.resume(ferret, 'again', { origin: PERSON_ORIGIN })).ok).toBe(true);
  expect(harness.launched.at(-1)?.compactAt).toBeUndefined();
  expect(await ferrets.compactAt?.(ferret)).toBeUndefined();

  // A clear on a ferret that never had a start value leaves its other start options alone and is repeatable.
  await ferrets.setCompactAt?.(ferret, undefined);
  expect(await ferrets.compactAt?.(ferret)).toBeUndefined();
});
