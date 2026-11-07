import { expect, test } from 'bun:test';
import { FsError } from '../../../../daemon/lib/session/filesystem/index.ts';
import { directory, FakeRootPinner, textFile, treeOf } from '../session/filesystem/support.ts';
import { as, host, record } from './route-fixture.ts';

/**
 * The file route reads bytes through the ferret's own `work` root and nothing else: `RootHandle.pin` holds its folder
 * open, the walk beneath it refuses links, and a root that cannot be held answers a refusal, never an ordinary read.
 */

test('S47 R-0151 fs/file serves no bytes where the root cannot be held open: a plain root read is never the fallback', async () => {
  // The default test pinner refuses, as a platform with no descriptor walk does.
  const h = await host([record('lead'), record('helper', 'lead'), record('stranger')]);
  // The file is present in the root, where the old RootHandle reader would have served it: stat cannot prove a single
  // link or the home's identity.
  h.putRoot('work', 'hard-link.txt', 'state content');
  const person = await h.request('GET', '/v1/ferrets/helper/fs/file', { query: { path: 'hard-link.txt' } });
  expect(person.status).toBe(501);
  expect(person.json<{ code: string }>().code).toBe('unsupported');
  expect(person.body).not.toContain('state content');
  // An agent never gets as far: its fence cannot be computed (S47).
  const agent = await h.request('GET', '/v1/ferrets/helper/fs/file', {
    ...as('lead'),
    query: { path: 'hard-link.txt' },
  });
  expect(agent.status).toBe(503);
  expect(agent.json<{ code: string }>().code).toBe('state_home_unresolved');
  expect(agent.body).not.toContain('state content');
  expect(
    (
      await h.request('GET', '/v1/ferrets/stranger/fs/file', {
        ...as('lead'),
        query: { path: 'hard-link.txt' },
      })
    ).status,
  ).toBe(403);
});

test('S47 R-0151 fs/file is served from the pinned walk of the ferret’s own work root', async () => {
  const pinner = new FakeRootPinner({
    tree: treeOf(['', directory([{ name: 'a.txt', type: 'file' }])], ['a.txt', textFile('hello\n')]),
  });
  // Git answers "not a repository", so the ignore gate has nothing to refuse on.
  const git = async () => ({ exitCode: 128, signal: null, stdout: '', stderr: 'fatal: not a git repository' });
  const h = await host([record('lead'), record('helper', 'lead')], { pinner, spawn: git });
  const answer = await h.request('GET', '/v1/ferrets/lead/fs/file', { query: { path: 'a.txt' } });
  expect(answer.status).toBe(200);
  expect(answer.body).toContain('hello');
  expect(pinner.pinnedCwds.length).toBe(1);
  // The pin was closed with the request, and the root walked is the one the kernel minted for the ferret.
  expect(pinner.lastRoot.closed).toBe(true);
});

test('S47 R-0151 when Git cannot confirm a file is not ignored the file is refused, not served', async () => {
  const pinner = new FakeRootPinner({
    tree: treeOf(['', directory([{ name: 'a.txt', type: 'file' }])], ['a.txt', textFile('hello\n')]),
  });
  const h = await host([record('lead')], { pinner });
  const answer = await h.request('GET', '/v1/ferrets/lead/fs/file', { query: { path: 'a.txt' } });
  expect(answer.json<{ ignored?: boolean }>().ignored).toBe(true);
  expect(answer.body).not.toContain('hello');
});

test('S47 a refusal of the pin is the viewer’s own status and never an open root', async () => {
  const h = await host([record('lead')], {
    pinner: new FakeRootPinner({ pinError: new FsError('denied', 'session cwd is not served') }),
  });
  const answer = await h.request('GET', '/v1/ferrets/lead/fs/file', { query: { path: 'a.txt' } });
  expect(answer.status).toBe(403);
  expect(answer.json<{ code: string }>().code).toBe('denied');
});

test('R-0151 file query scope, rev, format and required path are validated instead of silently serving other bytes', async () => {
  const h = await host([record('lead')]);
  h.putRoot('work', 'a.txt', 'hello');
  for (const [query, code] of [
    [{ path: 'a.txt', scope: 'home' }, 'invalid_scope'],
    [{ path: 'a.txt', scope: 'media', rev: 'head' }, 'invalid_rev'],
    [{ path: 'a.txt', rev: 'other' }, 'invalid_rev'],
    [{ path: 'a.txt', format: 'utf16' }, 'invalid_format'],
    [{}, 'invalid_path'],
  ] as const) {
    const answer = await h.request('GET', '/v1/ferrets/lead/fs/file', { query });
    expect(answer.status).toBe(400);
    expect(answer.json<{ code: string }>().code).toBe(code);
  }
  // The media folder is kept in the daemon's own state, which this walk never serves: today's answer when none is kept.
  const media = await h.request('GET', '/v1/ferrets/lead/fs/file', { query: { path: 'a.txt', scope: 'media' } });
  expect(media.status).toBe(404);
  expect(media.body).not.toContain('hello');
});
