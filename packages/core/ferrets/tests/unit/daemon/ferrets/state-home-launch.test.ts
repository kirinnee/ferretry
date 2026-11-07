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
