import { expect, test } from 'bun:test';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { directory, FakeRootPinner, textFile, treeOf } from '../session/filesystem/support.ts';
import { as, host, record } from './route-fixture.ts';

test('S47 R-0332 an agent launch fails closed before token issuance while the state-home identity fence is unbound', async () => {
  const runner = new FakeRunner();
  const h = await host([record('lead')], { harness: new FakeHarness(), runner });
  for (const folder of ['/state/ferretry', '/work/project', '/link-to-state']) {
    const answer = await h.request('POST', '/v1/ferrets', {
      ...as('lead'),
      body: { folder },
      headers: { ...as('lead').headers, 'x-fy-request-id': folder },
    });
    expect(answer.status).toBe(503);
    expect(answer.json<{ code: string }>().code).toBe('state_home_unresolved');
  }
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});

test('S47 R-0151 an agent’s file-browser read fails closed while the state-home fence is unbound; a state home beneath the work folder is never listed or read for it', async () => {
  // The ferret works in ~, so its work folder CONTAINS the state home: the work root's own check only refuses a base
  // inside the home, never a descendant of an ancestor of it.
  const pinner = new FakeRootPinner({
    tree: treeOf(
      [
        '',
        directory([
          { name: '.ferretry', type: 'dir' },
          { name: 'sibling.txt', type: 'file' },
        ]),
      ],
      ['.ferretry', directory([{ name: 'secret.json', type: 'file' }])],
      ['.ferretry/secret.json', textFile('credential-bytes\n')],
      ['sibling.txt', textFile('sibling-bytes\n')],
    ),
  });
  const git = async () => ({ exitCode: 128, signal: null, stdout: '', stderr: 'fatal: not a git repository' });
  const h = await host([record('lead', undefined, '/home/me')], { pinner, spawn: git });
  for (const [route, query] of [
    ['/v1/ferrets/lead/fs', { path: '.ferretry' }],
    ['/v1/ferrets/lead/fs/file', { path: '.ferretry/secret.json' }],
    ['/v1/ferrets/lead/fs/file', { path: 'sibling.txt' }],
    ['/v1/ferrets/lead/fs/changes', {}],
    ['/v1/ferrets/lead/fs/diff', { path: 'sibling.txt' }],
  ] as const) {
    const answer = await h.request('GET', route, { ...as('lead'), query });
    expect(answer.status).toBe(503);
    expect(answer.json<{ code: string }>().code).toBe('state_home_unresolved');
    expect(answer.body).not.toContain('credential-bytes');
    expect(answer.body).not.toContain('sibling-bytes');
  }
  // Nothing was pinned for the agent: it was refused before the root was held.
  expect(pinner.pinnedCwds.length).toBe(0);
  // A person at the machine is not governed by the agent's fence.
  const person = await h.request('GET', '/v1/ferrets/lead/fs/file', { query: { path: 'sibling.txt' } });
  expect(person.status).toBe(200);
  expect(person.body).toContain('sibling-bytes');
});
