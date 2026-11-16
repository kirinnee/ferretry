import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { as, fakePacks, host } from '../../../unit/daemon/ferrets/route-fixture.ts';

/**
 * S47 R-0332 (G12), through the real composition: the REAL Ferrets half over the kernel test host whose
 * `paths.stateHomeHolding` runs the production fence (name, link hops, real path, identity) over a REAL temp disk.
 * A ferret's token starts a helper; the fence decides. Fixture values only.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const disk = async () => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-start-fence-`));
  parents.push(parent);
  const home = `${parent}/ferretry`;
  const work = `${parent}/project`;
  await mkdir(`${home}/state/ferrets`, { recursive: true });
  await mkdir(work);
  await symlink(`${home}/state`, `${parent}/looks-harmless`);
  return { parent, home, work };
};

test('S47 R-0332 a ferret starts no helper inside the state home (403), nor through a link into it, and starts one in a sibling project (201)', async () => {
  const { parent, home, work } = await disk();
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner, plugins: [fakePacks().plugin], stateHome: home });
  const start = async (folder: string, ferret?: string) =>
    await h.request('POST', '/v1/ferrets', {
      ...(ferret === undefined ? {} : as(ferret)),
      headers: { ...(ferret === undefined ? {} : as(ferret).headers), 'x-fy-request-id': randomUUID() },
      body: { folder },
    });
  const lead = (await start(work)).json<{ id: string }>().id; // a person starts the lead anywhere
  const started = runner.starts;

  const inside = await start(`${home}/state/ferrets`, lead);
  expect(inside.status).toBe(403);
  expect(inside.json<{ code: string }>().code).toBe('state_home');
  const linked = await start(`${parent}/looks-harmless`, lead);
  expect(linked.status).toBe(403);
  expect(linked.json<{ code: string }>().code).toBe('state_home');
  expect(runner.starts).toBe(started);

  const sibling = await start(work, lead);
  expect(sibling.status).toBe(201);
  expect(runner.starts).toBe(started + 1);
});
