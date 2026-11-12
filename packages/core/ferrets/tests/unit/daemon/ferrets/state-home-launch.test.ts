import { expect, test } from 'bun:test';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { directory, FakeRootPinner, textFile, treeOf } from '../session/filesystem/support.ts';
import { as, fakePacks, host, record } from './route-fixture.ts';

/**
 * The state-home fence for an agent's start, now bound: the kernel's `bindDirectory` answers whether the folder lies
 * inside the state home (by name, by identity or through a link), the route refuses an agent there with 403 `state_home`,
 * and an ordinary project folder is served. The folder is bound where it is first checked and re-verified as the last step
 * before the harness starts.
 */
const STATE = '/state';
const PROJECT = '/work/project';

test('S47 R-0332 an agent starts in an ordinary project folder (the fence is bound, not failing closed)', async () => {
  const runner = new FakeRunner();
  const h = await host([], {
    harness: new FakeHarness(),
    runner,
    fenceHome: STATE,
    plugins: [fakePacks().plugin],
  });
  const lead = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'lead' },
    body: { folder: PROJECT },
  });
  expect(lead.status).toBe(201);

  const child = await h.request('POST', '/v1/ferrets', {
    headers: { ...as(lead.json<{ id: string }>().id).headers, 'x-fy-request-id': 'child' },
    body: { folder: PROJECT },
  });

  expect(child.status).toBe(201);
  expect(runner.starts).toBe(2);
});

test('S47 R-0332 an agent is refused a folder inside the state home, one that is the state home, and a link into it, before anything starts', async () => {
  const runner = new FakeRunner();
  const h = await host([record('lead')], {
    harness: new FakeHarness(),
    runner,
    fenceHome: STATE,
    plugins: [fakePacks().plugin],
    directories: { '/link-to-state': `${STATE}/credentials` },
  });
  for (const folder of [STATE, `${STATE}/credentials`, '/link-to-state']) {
    const answer = await h.request('POST', '/v1/ferrets', {
      ...as('lead'),
      body: { folder },
      headers: { ...as('lead').headers, 'x-fy-request-id': folder },
    });
    expect([folder, answer.status, answer.json<{ code: string }>().code]).toEqual([folder, 403, 'state_home']);
  }
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});

test('S47 R-0332 the owner may start in the state home: only an agent is fenced out', async () => {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner, fenceHome: STATE });

  const answer = await h.request('POST', '/v1/ferrets', {
    body: { folder: `${STATE}/credentials` },
    headers: { 'x-fy-request-id': 'owner' },
  });

  expect(answer.status).toBe(201);
  expect(runner.starts).toBe(1);
});

test('audit A B1: a folder swapped for a link into the state home AFTER it was checked starts nothing', async () => {
  // The late swap: Packs' `start.decide` runs after the route and the service checked the folder. The project is then
  // replaced by a link into the state home. The identity bound at the first check is re-verified as the last step before
  // the harness, which holds the folder, so no runner is asked and no ferret is left running.
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  let swapped = false;
  let h: Awaited<ReturnType<typeof host>> | undefined;
  const packs = fakePacks(async input => {
    if (input.by !== 'ferret') return { allow: true };
    h?.setDirectory(PROJECT, `${STATE}/credentials`);
    swapped = true;
    return { allow: true };
  });
  h = await host([], { harness, runner, fenceHome: STATE, plugins: [packs.plugin] });
  const lead = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'lead' },
    body: { folder: PROJECT },
  });
  expect(lead.status).toBe(201);
  const before = runner.starts;

  const child = await h.request('POST', '/v1/ferrets', {
    headers: { ...as(lead.json<{ id: string }>().id).headers, 'x-fy-request-id': 'child' },
    body: { folder: PROJECT },
  });

  expect(swapped).toBe(true);
  expect(child.status).toBe(409);
  expect(child.json<{ error: string }>().error).toContain('no longer what was checked');
  expect(runner.starts).toBe(before);
  expect(harness.launched).toHaveLength(1);
});

test('the late swap is held for a resume too: the folder bound at the resume is verified before the relaunch', async () => {
  const runner = new FakeRunner();
  const harness = new FakeHarness();
  let h: Awaited<ReturnType<typeof host>> | undefined;
  const packs = fakePacks(async input => {
    if (input.by === 'resume') h?.replaceDirectory(PROJECT);
    return { allow: true };
  });
  h = await host([], { harness, runner, fenceHome: STATE, plugins: [packs.plugin] });
  const lead = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'lead' },
    body: { folder: PROJECT },
  });
  const id = lead.json<{ id: string }>().id;
  await h.settle();
  await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how: 'now' }, body: {} });
  await h.settle();
  const before = runner.starts;

  const resumed = await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} });

  expect(resumed.status).toBeGreaterThanOrEqual(400);
  expect(runner.starts).toBe(before);
});

/** A refusal as the kernel's fenced pin raises it: named, and carrying the refusal word. */
const fenced = (): Error => Object.assign(new Error('root refused: fenced'), { name: 'RootError', refusal: 'fenced' });

test('S47 R-0151 an agent’s file-browser read is refused inside the state home beneath its work folder, and served beside it; a person is served beside it too', async () => {
  // The ferret works in ~, so its work folder CONTAINS the state home. The kernel's pin judges every walk beneath the
  // root against the fence (kernel `S40 S47` tests); this stands in for its refusal on the home's names.
  const pinner = new FakeRootPinner({
    tree: treeOf(
      [
        '',
        directory([
          { name: '.ferretry', type: 'dir' },
          { name: 'sibling.txt', type: 'file' },
        ]),
      ],
      ['.ferretry', { ...directory([{ name: 'secret.json', type: 'file' }]), error: fenced() }],
      ['.ferretry/secret.json', { ...textFile('credential-bytes\n'), error: fenced() }],
      ['sibling.txt', textFile('sibling-bytes\n')],
    ),
  });
  const git = async () => ({ exitCode: 128, signal: null, stdout: '', stderr: 'fatal: not a git repository' });
  const h = await host([record('lead', undefined, '/home/me')], { pinner, spawn: git });
  for (const [route, query] of [
    ['/v1/ferrets/lead/fs', { path: '.ferretry' }],
    ['/v1/ferrets/lead/fs/file', { path: '.ferretry/secret.json' }],
  ] as const) {
    const answer = await h.request('GET', route, { ...as('lead'), query });
    // Today's refusal for a path inside the state home: the viewer's `denied`, 403.
    expect(answer.status).toBe(403);
    expect(answer.json<{ code: string }>().code).toBe('denied');
    expect(answer.body).not.toContain('credential-bytes');
  }
  const sibling = await h.request('GET', '/v1/ferrets/lead/fs/file', { ...as('lead'), query: { path: 'sibling.txt' } });
  expect(sibling.status).toBe(200);
  expect(sibling.body).toContain('sibling-bytes');
  // Every request closed what it pinned.
  expect(pinner.roots.every(root => root.closed)).toBe(true);
  // A person at the machine is served beside the home as before.
  const person = await h.request('GET', '/v1/ferrets/lead/fs/file', { query: { path: 'sibling.txt' } });
  expect(person.status).toBe(200);
  expect(person.body).toContain('sibling-bytes');
});
