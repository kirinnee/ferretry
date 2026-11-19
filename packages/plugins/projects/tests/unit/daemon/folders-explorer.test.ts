import { describe, expect, test } from 'bun:test';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { FolderExplorer } from '../../../daemon/features/folders/browse.ts';
import { holdsSignIn, isPrivateFolder, parsePath } from '../../../daemon/features/folders/fence.ts';
import type { FolderBrowser, FolderReach, RawFolderEntry } from '../../../daemon/features/folders/port.ts';
import { listFoldersRoute, makeFolderRoute } from '../../../daemon/features/folders/routes.ts';
import { MakeFolderRequestSchema } from '../../../contract/index.ts';

const AT = '2026-11-19T00:00:00.000Z' as Instant;
const HOME = '/home/me';

type Tree = Record<string, readonly (string | [string, RawFolderEntry['kind']])[]>;

/** A machine of folders in a map. `links` maps a path to what it really is. */
function machine(tree: Tree, links: Record<string, string> = {}, git: readonly string[] = []) {
  const calls: string[] = [];
  const browser: FolderBrowser = {
    home: async () => HOME,
    reach: async (path): Promise<FolderReach> => {
      const real = links[path] ?? path;
      if (real.startsWith('/dev')) return { ok: false, reason: 'refused' };
      if (!(real in tree)) return { ok: false, reason: 'missing' };
      return { ok: true, path: real };
    },
    entries: async folder =>
      (tree[folder] ?? []).map(item => {
        const [name, kind] =
          typeof item === 'string' ? [item, item.slice(1).includes('.') ? 'file' : 'directory'] : item;
        return { name, kind: kind as RawFolderEntry['kind'], modified: AT };
      }),
    exists: async (folder, name) =>
      (tree[folder] ?? []).some(item => (typeof item === 'string' ? item : item[0]) === name),
    hasGit: async (folder, name) => git.includes(`${folder}/${name}`),
  };
  const made: string[] = [];
  const explorer = new FolderExplorer({
    browser,
    folders: {
      mayName: async path => {
        calls.push(`mayName ${path}`);
        return !path.startsWith('/home/me/fenced');
      },
      makeDirectory: async path => {
        made.push(path);
      },
    },
  });
  return { explorer, made, calls };
}

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error as { status: number; code: string };
  }
  throw new Error('it answered');
};

const BASE: Tree = {
  [HOME]: ['code', 'Docs', 'notes.txt', '.ssh', '.config', '.bashrc', '.git-credentials', 'Alpha', '.claude'],
  [`${HOME}/code`]: ['app', 'zeta.md', 'lib'],
  [`${HOME}/.config`]: ['gh', 'nvim'],
  [`${HOME}/.config/gh`]: ['hosts.yml'],
  [`${HOME}/.ssh`]: ['id_work_ed25519'],
  [`${HOME}/keys`]: ['id_rsa', 'x'],
  [`${HOME}/Docs`]: [],
  [`${HOME}/Alpha`]: [],
  '/etc': ['passwd'],
};

describe('parsePath', () => {
  test('takes ~, ~/x and absolute paths; refuses relative, dot segments, ~user and NUL', () => {
    expect(parsePath('~', HOME)).toEqual({ ok: true, absolute: HOME });
    expect(parsePath('~/code/', HOME)).toEqual({ ok: true, absolute: `${HOME}/code` });
    expect(parsePath('/a//b', HOME)).toEqual({ ok: true, absolute: '/a/b' });
    for (const bad of ['', 'code', '~me/x', '~/../x', '/a/./b', '/a/..', 'a\0b', `/${'x'.repeat(5000)}`])
      expect(parsePath(bad, HOME).ok).toBe(false);
  });
});

describe('fence rules', () => {
  test('a private folder is itself and everything below it', () => {
    expect(isPrivateFolder(['.ssh'])).toBe(true);
    expect(isPrivateFolder(['.config', 'gh', 'x'])).toBe(true);
    expect(isPrivateFolder(['.config'])).toBe(false);
    expect(isPrivateFolder(['code', '.ssh'])).toBe(false);
    expect(holdsSignIn(['a', 'auth.json'])).toBe(true);
    expect(holdsSignIn(['a', 'b'])).toBe(false);
  });
});

describe('FolderExplorer.list', () => {
  test('starts at ~: folders first, hidden dot-names and private folders left out, a link never listed', async () => {
    const { explorer } = machine({
      ...BASE,
      [HOME]: [...(BASE[HOME] as string[]), ['link', 'symlink'], ['pipe', 'other']],
    });
    const listing = await explorer.list('~', false);
    expect(listing.path).toBe(HOME);
    expect(listing.crumbs).toEqual([{ name: '~', path: HOME }]);
    expect(listing.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual([
      'folder:Alpha',
      'folder:Docs',
      'folder:code',
      'file:notes.txt',
    ]);
    expect(listing.truncated).toBe(false);
  });

  test('hidden=1 shows dot-names but still never a private folder or its name', async () => {
    const { explorer } = machine(BASE);
    const names = (await explorer.list('~', true)).entries.map(entry => entry.name);
    expect(names).toContain('.config');
    expect(names).toContain('.bashrc');
    expect(names).not.toContain('.ssh');
    expect(names).not.toContain('.claude');
    const hidden = (await explorer.list('~', true)).entries.find(entry => entry.name === '.config');
    expect(hidden?.hidden).toBe(true);
    // `.config/gh` is private, so listing `.config` names only the rest.
    expect((await explorer.list('~/.config', true)).entries.map(entry => entry.name)).toEqual(['nvim']);
  });

  test('a subfolder lists with breadcrumbs and a repo is marked', async () => {
    const { explorer } = machine(BASE, {}, [`${HOME}/code/app`]);
    const listing = await explorer.list(`${HOME}/code`, false);
    expect(listing.crumbs.map(crumb => crumb.name)).toEqual(['~', 'code']);
    expect(listing.crumbs[1]?.path).toBe(`${HOME}/code`);
    expect(listing.entries.map(entry => [entry.name, entry.isRepo])).toEqual([
      ['app', true],
      ['lib', false],
      ['zeta.md', false],
    ]);
  });

  test('refuses a private folder, a folder holding a key, outside the home, and a link out of the home', async () => {
    const { explorer } = machine(BASE, { [`${HOME}/escape`]: '/etc', [`${HOME}/dev`]: '/dev/null' });
    expect((await failure(() => explorer.list('~/.ssh', true))).code).toBe('private_folder');
    expect((await failure(() => explorer.list('~/.config/gh', true))).code).toBe('private_folder');
    expect((await failure(() => explorer.list('~/keys', false))).code).toBe('private_folder');
    expect((await failure(() => explorer.list('/etc', false))).code).toBe('outside_home');
    const link = await failure(() => explorer.list('~/escape', false));
    expect([link.status, link.code]).toEqual([403, 'outside_home']);
    expect((await failure(() => explorer.list('~/dev', false))).code).toBe('folder_refused');
    expect((await failure(() => explorer.list('~/nope', false))).status).toBe(404);
    expect((await failure(() => explorer.list('code', false))).status).toBe(400);
    expect((await failure(() => explorer.list('~/../etc', false))).status).toBe(400);
  });

  test('a link INSIDE the home to a private folder is refused by where it lands', async () => {
    const { explorer } = machine(BASE, { [`${HOME}/innocent`]: `${HOME}/.ssh` });
    expect((await failure(() => explorer.list('~/innocent', false))).code).toBe('private_folder');
  });

  test('a listing is bounded at 500 and says so', async () => {
    const many = Array.from({ length: 700 }, (_, index) => `d${String(index).padStart(4, '0')}`);
    const { explorer } = machine({ ...BASE, [`${HOME}/many`]: many });
    const listing = await explorer.list('~/many', false);
    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(true);
    expect(listing.entries[0]?.name).toBe('d0000');
  });
});

describe('FolderExplorer.make', () => {
  test('makes one level under a reached parent and answers the real path', async () => {
    const { explorer, made } = machine(BASE);
    expect(await explorer.make({ parent: '~/code', name: 'fresh' })).toEqual({ path: `${HOME}/code/fresh` });
    expect(made).toEqual([`${HOME}/code/fresh`]);
  });

  test('refuses an existing name, a private or outside parent, a fenced place and a missing parent; makes nothing', async () => {
    const { explorer, made } = machine(BASE, { [`${HOME}/escape`]: '/etc' });
    expect((await failure(() => explorer.make({ parent: '~/code', name: 'app' }))).code).toBe('folder_exists');
    expect((await failure(() => explorer.make({ parent: '~/.ssh', name: 'x' }))).code).toBe('private_folder');
    expect((await failure(() => explorer.make({ parent: '~/escape', name: 'x' }))).code).toBe('outside_home');
    expect((await failure(() => explorer.make({ parent: '~/nope', name: 'x' }))).status).toBe(404);
    await explorer.make({ parent: '~/Docs', name: 'a' });
    expect(made).toEqual([`${HOME}/Docs/a`]);
  });

  test('the imports fence refusing the target makes nothing', async () => {
    const { explorer, made } = machine({ ...BASE, [`${HOME}/fenced`]: [] });
    expect((await failure(() => explorer.make({ parent: '~/fenced', name: 'x' }))).code).toBe('folder_refused');
    expect(made).toEqual([]);
  });
});

describe('folder name rules', () => {
  test('one level, no slash, no .., not dot-leading, no control, trimmed', () => {
    const ok = (name: string) => MakeFolderRequestSchema.safeParse({ parent: '~', name }).success;
    expect(ok('My Project')).toBe(true);
    for (const bad of [
      '',
      '.',
      '..',
      '.hidden',
      'a/b',
      '../x',
      'a\\b',
      'a\0b',
      'a\nb',
      ' pad',
      'pad ',
      'x'.repeat(256),
    ])
      expect(ok(bad)).toBe(false);
    expect(MakeFolderRequestSchema.safeParse({ parent: '~', name: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('routes', () => {
  const call = (query: Record<string, string>, body?: unknown): CallContext =>
    ({
      request: {
        query: new Map(Object.entries(query).map(([key, value]) => [key, [value]])),
        text: async () => JSON.stringify(body),
      } as unknown as ApiRequest,
    }) as unknown as CallContext;

  test('GET lists with path and hidden, refuses an unknown or bad parameter', async () => {
    const { explorer } = machine(BASE);
    const list = listFoldersRoute(explorer);
    const body = JSON.parse(String((await list(call({}))).body)) as { path: string };
    expect(body.path).toBe(HOME);
    expect((await failure(() => list(call({ x: '1' })))).status).toBe(400);
    expect((await failure(() => list(call({ hidden: 'yes' })))).status).toBe(400);
  });

  test('POST makes a folder and refuses a bad body', async () => {
    const { explorer, made } = machine(BASE);
    const make = makeFolderRoute(explorer);
    const answer = await make(call({}, { parent: '~/code', name: 'n' }));
    expect(JSON.parse(String(answer.body))).toEqual({ path: `${HOME}/code/n` });
    expect(made).toHaveLength(1);
    expect((await failure(() => make(call({}, { parent: '~', name: 'a/b' })))).status).toBe(400);
  });
});
