import { describe, expect, test } from 'bun:test';
import type { CallContext } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { accountsRoute, reposRoute } from '../../../daemon/features/repos/routes.ts';
import type { FolderBrowser } from '../../../daemon/features/folders/port.ts';
import { fakeMachine, registryOver } from './support.ts';

const callWith = (body: unknown, params: Record<string, string> = {}): CallContext =>
  ({
    request: { text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) },
    params: new Map(Object.entries(params)),
  }) as unknown as CallContext;
const answer = (response: { readonly status: number; readonly body: unknown }) => ({
  status: response.status,
  json: JSON.parse(String(response.body)) as Record<string, unknown>,
});
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error as { status: number; code: string };
  }
  throw new Error('the route answered');
};

const at = '2026-11-19T00:00:00.000Z' as Instant;
/** A machine whose only folder is `/work/alpha`, holding one repository `app`. */
const browser: FolderBrowser = {
  home: async () => '/home/me',
  holdsSignIn: async () => false,
  realPaths: async paths => [...paths],
  open: async (path, verdict) => {
    if ((await verdict(path)) !== undefined) return { ok: false, reason: 'refused' };
    return {
      ok: true,
      folder: {
        real: path,
        entries: async () => ({
          entries: path === '/work/alpha' ? [{ name: 'app', kind: 'directory' as const, modified: at }] : [],
          more: false,
        }),
        lookup: async () => 'missing',
        hasGit: async name => name === 'app',
        makeLeaf: async () => ({ kind: 'failed' }),
        close: async () => undefined,
      },
    };
  },
};

const setup = async () => {
  const world = registryOver(fakeMachine(['/work/alpha']));
  const made = await world.registry.register({ kind: 'existing-folder', path: '/work/alpha' });
  if (!made.ok) throw new Error('not registered');
  const scan = { browser, readConfig: async () => '[remote "origin"]\n\turl = https://tok:en@github.com/o/app.git\n' };
  return { ...world, id: made.value.id, scan };
};

describe('GET /v1/projects/:id/repos', () => {
  test('answers what a scan finds, keeps it on the record, and never shows a credential in a remote', async () => {
    const { registry, id, scan, store } = await setup();
    const got = answer(await reposRoute(registry, scan)(callWith(undefined, { id })));
    expect(got.status).toBe(200);
    expect(got.json).toEqual({
      repos: [{ path: 'app', remote: 'https://github.com/o/app', provider: 'github' }],
      truncated: false,
    });
    expect(JSON.stringify(store.file)).not.toContain('tok');
    expect(store.file.projects[0]?.repos?.[0]?.path).toBe('app');
  });
  test('an unknown project is 404 and a bad id is 400', async () => {
    const { registry, scan } = await setup();
    expect(
      (
        await failure(() =>
          reposRoute(registry, scan)(callWith(undefined, { id: '00000000-0000-4000-8000-0000000000ff' })),
        )
      ).status,
    ).toBe(404);
    expect((await failure(() => reposRoute(registry, scan)(callWith(undefined, { id: 'nope' })))).code).toBe(
      'invalid_project_id',
    );
  });
});

describe('PUT /v1/projects/:id/accounts', () => {
  test('replaces the list and answers the project', async () => {
    const { registry, id } = await setup();
    const put = answer(await accountsRoute(registry)(callWith({ accounts: ['work', 'me'] }, { id })));
    expect(put.status).toBe(200);
    expect(put.json.accounts).toEqual(['work', 'me']);
  });
  test('an unknown project is 404; a malformed body is 400', async () => {
    const { registry, id } = await setup();
    expect(
      (
        await failure(() =>
          accountsRoute(registry)(callWith({ accounts: ['a'] }, { id: '00000000-0000-4000-8000-0000000000ff' })),
        )
      ).status,
    ).toBe(404);
    expect((await failure(() => accountsRoute(registry)(callWith({ accounts: 'a' }, { id })))).status).toBe(400);
  });
});
