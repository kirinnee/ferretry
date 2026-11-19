import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import {
  accountLinks,
  MAX_PROJECT_REPOS,
  type ProjectId,
  ProjectInfoSchema,
  ProjectsFileSchema,
  SetProjectAccountsRequestSchema,
} from '../../../contract/index.ts';
import type { FolderBrowser, HeldFolder } from '../../../daemon/features/folders/port.ts';
import { describeRemote, parseGitRemote, remoteUrlOfConfig } from '../../../daemon/features/repos/remote.ts';
import { MAX_SCAN_FOLDERS, scanRepos } from '../../../daemon/features/repos/scan.ts';
import { fakeMachine, registryOver } from './support.ts';

const AT = '2026-11-19T00:00:00.000Z' as Instant;
const HOME = '/home/me';

/** Folders as `path -> child folder names`; `git` is the set of folders that hold a `.git`; `links` says what a path REALLY is. */
function browserOf(
  tree: Record<string, readonly string[]>,
  git: readonly string[],
  links: Record<string, string> = {},
): { browser: FolderBrowser; opened: string[] } {
  const opened: string[] = [];
  const browser: FolderBrowser = {
    home: async () => HOME,
    holdsSignIn: async () => false,
    realPaths: async paths => paths.map(path => links[path] ?? path).filter(path => path in tree),
    open: async (path, verdict) => {
      const real = links[path] ?? path;
      if (!(real in tree)) return { ok: false, reason: 'refused' };
      const judged = await verdict(real);
      if (judged !== undefined) return { ok: false, reason: judged };
      opened.push(real);
      const folder: HeldFolder = {
        real,
        entries: async limit => {
          const names = tree[real] ?? [];
          return {
            entries: names.slice(0, limit).map(name => ({ name, kind: 'directory' as const, modified: AT })),
            more: names.length > limit,
          };
        },
        lookup: async name => (git.includes(`${real}/${name}`) ? 'present' : 'missing'),
        hasGit: async name => git.includes(`${real}/${name}`),
        makeLeaf: async () => ({ kind: 'failed' }),
        close: async () => undefined,
      };
      return { ok: true, folder };
    },
  };
  return { browser, opened };
}

const configs: Record<string, string> = {};
const readConfig = async (repo: string) => configs[repo];

describe('remote parsing', () => {
  test('reads https, ssh and scp spellings; another host keeps no provider; a local path names nothing', () => {
    expect(parseGitRemote('git@github.com:o/r.git')).toEqual({ host: 'github.com', repo: 'o/r' });
    expect(describeRemote('git@github.com:o/r.git')).toEqual({ remote: 'https://github.com/o/r', provider: 'github' });
    expect(describeRemote('ssh://git@ssh.github.com:443/o/r')).toEqual({
      remote: 'https://github.com/o/r',
      provider: 'github',
    });
    expect(describeRemote('https://git.example.com/team/app.git')).toEqual({
      remote: 'https://git.example.com/team/app',
    });
    expect(describeRemote('/srv/git/app.git')).toBeUndefined();
    expect(describeRemote('ext::sh -c id')).toBeUndefined();
  });
  test('a password or token in the remote is never kept', () => {
    const described = describeRemote('https://me:ghp_SECRETTOKEN@github.com/o/r.git');
    expect(JSON.stringify(described)).not.toContain('SECRET');
    expect(JSON.stringify(described)).not.toContain('me:');
  });
  test('origin wins over another remote; the first remote is the fallback; comments are skipped', () => {
    const text =
      '[core]\n\turl = nope\n[remote "up"]\n\turl = https://github.com/a/up\n[remote "origin"]\n\t# c\n\turl = git@github.com:a/mine.git\n';
    expect(remoteUrlOfConfig(text)).toBe('git@github.com:a/mine.git');
    expect(remoteUrlOfConfig('[remote "up"]\n\turl = https://github.com/a/up\n')).toBe('https://github.com/a/up');
    expect(remoteUrlOfConfig('[core]\n\tbare = false\n')).toBeUndefined();
  });
});

describe('scanning a project folder for repositories', () => {
  const P = `${HOME}/work`;
  test('finds repositories at most three names down, never enters one, skips hidden folders and node_modules', async () => {
    const { browser } = browserOf(
      {
        [P]: ['a', 'group', 'node_modules', '.hid', 'plain'],
        [`${P}/a`]: ['inside'],
        [`${P}/a/inside`]: [],
        [`${P}/group`]: ['b', 'deep'],
        [`${P}/group/b`]: [],
        [`${P}/group/deep`]: ['x'],
        [`${P}/group/deep/x`]: ['too-deep'],
        [`${P}/group/deep/x/too-deep`]: [],
        [`${P}/node_modules`]: ['dep'],
        [`${P}/.hid`]: ['r'],
        [`${P}/plain`]: [],
      },
      [
        `${P}/a`,
        `${P}/a/inside`,
        `${P}/group/b`,
        `${P}/group/deep/x`,
        `${P}/group/deep/x/too-deep`,
        `${P}/node_modules/dep`,
        `${P}/.hid/r`,
      ],
    );
    configs[`${P}/a`] = '[remote "origin"]\n\turl = git@github.com:me/a.git\n';
    const found = await scanRepos(P, { browser, readConfig });
    expect(found.repos).toEqual([
      { path: 'a', remote: 'https://github.com/me/a', provider: 'github' },
      { path: 'group/b' },
      { path: 'group/deep/x' },
    ]);
    expect(found.truncated).toBe(false);
  });
  test('a project folder that is itself a repository answers just itself and is not entered further', async () => {
    const world = browserOf({ [P]: ['sub'], [`${P}/sub`]: [] }, [`${P}/.git`, `${P}/sub`]);
    const found = await scanRepos(P, { browser: world.browser, readConfig });
    expect(found.repos).toEqual([{ path: '.' }]);
    expect(world.opened).toEqual([P]);
  });
  test('a link that leaves the project is not followed, and a private folder is not entered', async () => {
    const { browser, opened } = browserOf(
      { [P]: ['escape', 'dotssh'], '/elsewhere': ['r'], [`${HOME}/.ssh`]: ['r2'] },
      ['/elsewhere/r', `${HOME}/.ssh/r2`],
      { [`${P}/escape`]: '/elsewhere', [`${P}/dotssh`]: `${HOME}/.ssh` },
    );
    const found = await scanRepos(P, { browser, readConfig });
    expect(found.repos).toEqual([]);
    expect(opened).toEqual([P]);
  });
  test('stops at the folder bound and at the repository bound, and says so', async () => {
    const wide: Record<string, readonly string[]> = { [P]: Array.from({ length: 30 }, (_, i) => `d${i}`) };
    for (let i = 0; i < 30; i++) wide[`${P}/d${i}`] = Array.from({ length: 20 }, (_, j) => `e${j}`);
    for (let i = 0; i < 30; i++) for (let j = 0; j < 20; j++) wide[`${P}/d${i}/e${j}`] = [];
    const folders = await scanRepos(P, { browser: browserOf(wide, []).browser, readConfig });
    expect(folders.truncated).toBe(true);
    const bound = browserOf(wide, []);
    await scanRepos(P, { browser: bound.browser, readConfig });
    expect(bound.opened.length).toBe(MAX_SCAN_FOLDERS);

    const many: Record<string, readonly string[]> = {
      [P]: Array.from({ length: MAX_PROJECT_REPOS + 10 }, (_, i) => `r${i}`),
    };
    const repos = many[P]?.map(name => `${P}/${name}`) ?? [];
    const capped = await scanRepos(P, { browser: browserOf(many, repos).browser, readConfig });
    expect(capped.repos.length).toBe(MAX_PROJECT_REPOS);
    expect(capped.truncated).toBe(true);
  });
  test('a project folder that is not there answers nothing', async () => {
    const found = await scanRepos('/nowhere', { browser: browserOf({}, []).browser, readConfig });
    expect(found).toEqual({ repos: [], truncated: false });
  });
});

describe("a project's accounts and repositories", () => {
  const over = async () => {
    const world = registryOver(fakeMachine(['/work/alpha']));
    const project = await world.registry.register({ kind: 'existing-folder', path: '/work/alpha' });
    if (!project.ok) throw new Error('not registered');
    return { ...world, id: project.value.id };
  };
  test('a record written before r9 still reads, and the file is still format 1', () => {
    const old = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'alpha',
      path: '/work/alpha',
      source: 'existing-folder',
      createdAt: AT,
      git: { commonDirectory: '/work/alpha/.git' },
    };
    const parsed = ProjectInfoSchema.parse(old);
    expect(parsed.accounts).toBeUndefined();
    expect(parsed.repos).toBeUndefined();
    expect(ProjectsFileSchema.safeParse({ format: 1, projects: [old] }).success).toBe(true);
  });
  test('accounts are kept in order without repeats; an empty list removes the field; an unknown project is refused', async () => {
    const { registry, id, store } = await over();
    const set = await registry.setAccounts(id, ['work', 'me', 'work']);
    expect(set.ok && set.value.accounts).toEqual(['work', 'me']);
    expect(store.file.projects[0]?.accounts).toEqual(['work', 'me']);
    const cleared = await registry.setAccounts(id, []);
    expect(cleared.ok && 'accounts' in cleared.value).toBe(false);
    const missing = await registry.setAccounts('00000000-0000-4000-8000-0000000000ff' as ProjectId, ['x']);
    expect(missing.ok).toBe(false);
  });
  test('a repository found again keeps its account; one that is gone is dropped; nothing found removes the field', async () => {
    const { registry, id, store } = await over();
    await registry.recordRepos(id, [{ path: 'a' }, { path: 'b' }]);
    // the owner gave `a` an account of its own (the field a later unit sets)
    await store.update(file => ({
      ...file,
      projects: file.projects.map(project => ({
        ...project,
        repos: project.repos?.map(repo => (repo.path === 'a' ? { ...repo, account: 'work' } : repo)),
      })),
    }));
    const again = await registry.recordRepos(id, [{ path: 'a', remote: 'https://github.com/o/a', provider: 'github' }]);
    expect(again.ok && again.value.repos).toEqual([
      { path: 'a', remote: 'https://github.com/o/a', provider: 'github', account: 'work' },
    ]);
    const none = await registry.recordRepos(id, []);
    expect(none.ok && 'repos' in none.value).toBe(false);
  });
  test('an unchanged scan writes nothing', async () => {
    const { registry, id, store } = await over();
    await registry.recordRepos(id, [{ path: 'a' }]);
    const written = store.file;
    await registry.recordRepos(id, [{ path: 'a' }]);
    expect(store.file).toBe(written);
  });
  test('links survive an account being removed and read as removed', () => {
    expect(accountLinks(['work', 'me'], ['me'])).toEqual([
      { id: 'work', removed: true },
      { id: 'me', removed: false },
    ]);
    expect(accountLinks(undefined, [])).toEqual([]);
  });
  test('the accounts request refuses padding, control characters, an empty id and too many', () => {
    expect(SetProjectAccountsRequestSchema.safeParse({ accounts: ['a'] }).success).toBe(true);
    for (const bad of [[''], [' a'], ['a\n'], Array.from({ length: 33 }, (_, i) => `a${i}`)])
      expect(SetProjectAccountsRequestSchema.safeParse({ accounts: bad }).success).toBe(false);
    expect(SetProjectAccountsRequestSchema.safeParse({ accounts: [], extra: 1 }).success).toBe(false);
  });
});
