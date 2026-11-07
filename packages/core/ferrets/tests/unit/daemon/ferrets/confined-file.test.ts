import { expect, test } from 'bun:test';
import { as, host, record } from './route-fixture.ts';

test('S47 R-0151 fs/file serves no bytes until single-link, ignore and identity-confined readFile is bound', async () => {
  const h = await host([record('lead'), record('helper', 'lead'), record('stranger')]);
  // The old RootHandle reader served this as an ordinary file: its stat cannot prove a single link or home identity.
  h.putRoot('work', 'hard-link.txt', 'state content');
  for (const headers of [{}, as('lead').headers]) {
    const answer = await h.request('GET', '/v1/ferrets/helper/fs/file', { headers, query: { path: 'hard-link.txt' } });
    expect(answer.status).toBe(503);
    expect(answer.body).not.toContain('state content');
  }
  expect(
    (
      await h.request('GET', '/v1/ferrets/stranger/fs/file', {
        ...as('lead'),
        query: { path: 'hard-link.txt' },
      })
    ).status,
  ).toBe(403);
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
  const supported: readonly Readonly<Record<string, string>>[] = [
    { path: 'a.txt', scope: 'media' },
    { path: 'a.txt', rev: 'head', format: 'base64' },
  ];
  for (const query of supported) {
    const answer = await h.request('GET', '/v1/ferrets/lead/fs/file', { query });
    expect(answer.status).toBe(503);
    expect(answer.body).not.toContain('hello');
  }
});
