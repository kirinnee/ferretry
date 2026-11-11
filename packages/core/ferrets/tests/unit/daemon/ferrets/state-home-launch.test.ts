import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { as, fakePacks, host } from './route-fixture.ts';

/** The kernel's fence stands in as a fake that names the home for a folder in it, or through a link to it. */
const HOME = '/state/ferretry';
const holding = async (path: string): Promise<string | undefined> =>
  path === HOME || path.startsWith(`${HOME}/`) || path === '/link-to-state' ? HOME : undefined;

type Host = Awaited<ReturnType<typeof host>>;
const startAs = async (h: Host, folder: string, ferret?: string) =>
  await h.request('POST', '/v1/ferrets', {
    ...(ferret === undefined ? {} : as(ferret)),
    headers: { ...(ferret === undefined ? {} : as(ferret).headers), 'x-fy-request-id': randomUUID() },
    body: { folder },
  });

/** A host with a started lead (an agent that can start helpers; Packs says yes to its child). */
const world = async (extra: Parameters<typeof host>[1] = {}) => {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner, plugins: [fakePacks().plugin], ...extra });
  const lead = (await startAs(h, '/work/lead')).json<{ id: string }>().id;
  return { h, runner, lead };
};

test('S47 R-0332 an agent start is refused inside the state home or through a link to it, and passes in a project folder', async () => {
  const { h, runner, lead } = await world({ stateHomeHolding: holding });
  const before = runner.starts;
  for (const folder of [HOME, `${HOME}/credentials`, '/link-to-state']) {
    const answer = await startAs(h, folder, lead);
    expect(answer.status).toBe(403);
    expect(answer.json<{ code: string }>().code).toBe('state_home');
  }
  expect(runner.starts).toBe(before);
  const ok = await startAs(h, '/work/project', lead);
  expect(ok.status).toBe(201);
  expect(runner.starts).toBe(before + 1);
});

test('S47 R-0332 an agent start fails closed (503) when the kernel cannot build the fence', async () => {
  const { h, runner, lead } = await world({
    stateHomeHolding: async () => {
      throw new Error('home.json cannot be identified');
    },
  });
  const before = runner.starts;
  const answer = await startAs(h, '/work/project', lead);
  expect(answer.status).toBe(503);
  expect(answer.json<{ code: string }>().code).toBe('state_home_unresolved');
  expect(runner.starts).toBe(before);
});

test('S47 R-0332 a person is not fenced: the owner starts in the state home (the fence is an agent rule)', async () => {
  const { h, runner } = await world({ stateHomeHolding: holding });
  const before = runner.starts;
  const answer = await startAs(h, HOME);
  expect(answer.status).toBe(201);
  expect(runner.starts).toBe(before + 1);
});
