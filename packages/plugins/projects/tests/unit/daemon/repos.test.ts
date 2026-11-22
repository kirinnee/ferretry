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

/**
 * Folders as `path -> child folder names`; `git` is the set of folders that hold a `.git`; `links` says what a path REALLY is
 * (and so is a link); `signIn` is the folders that hold a sign-in file; `configs` is each repository's `.git/config`.
 * `probed` lists every folder something was looked for in or read from (a `.git`, a config), `opened` every folder held.
 */
function browserOf(
  tree: Record<string, readonly string[]>,
  git: readonly string[],
  links: Record<string, string> = {},
  more: {
    signIn?: readonly string[];
    /** Folders whose sign-in look reads only part of their names: no marker seen, none ruled out. */
    partial?: readonly string[];
    configs?: Record<string, string>;
    devices?: Record<string, string>;
  } = {},
): { browser: FolderBrowser; opened: string[]; probed: string[]; asked: string[] } {
  const opened: string[] = [];
  const probed: string[] = [];
  /** Every folder whose names were read for a sign-in file. */
  const asked: string[] = [];
  const browser: FolderBrowser = {
    home: async () => HOME,
    holdsSignIn: async path => {
      asked.push(path);
      if (more.signIn?.includes(path)) return true;
      return more.partial?.includes(path) ? 'partial' : false;
    },
    leaf: async path => (path in links ? 'link' : path in tree ? 'present' : 'missing'),
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
        lookup: async name => {
          probed.push(`${real}/${name}`);
          return git.includes(`${real}/${name}`) ? 'present' : 'missing';
        },
        readText: async rel => {
          probed.push(`${real}/${rel}`);
          const repo = rel === '.git/config' ? real : `${real}/${rel.slice(0, -'/.git/config'.length)}`;
          return more.configs?.[repo];
        },
        hasGit: async name => {
          probed.push(`${real}/${name}`);
          return git.includes(`${real}/${name}`);
        },
        // Every folder is on disk `d1` unless `devices` says another (a mount point).
        device: async rel => more.devices?.[rel === '' ? real : `${real}/${rel}`] ?? 'd1',
        makeLeaf: async () => ({ kind: 'failed' }),
        close: async () => undefined,
      };
      return { ok: true, folder };
    },
  };
  return { browser, opened, probed, asked };
}

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
  test('finds repositories at most five names down, never enters one, skips hidden folders and node_modules', async () => {
    const { browser } = browserOf(
      {
        [P]: ['a', 'group', 'node_modules', '.hid', 'plain', 'chain'],
        [`${P}/chain`]: ['l2'],
        [`${P}/chain/l2`]: ['l3'],
        [`${P}/chain/l2/l3`]: ['l4'],
        [`${P}/chain/l2/l3/l4`]: ['l5'],
        [`${P}/chain/l2/l3/l4/l5`]: ['l6'],
        [`${P}/chain/l2/l3/l4/l5/l6`]: [],
        [`${P}/a`]: ['inside'],
        [`${P}/a/inside`]: [],
        [`${P}/group`]: ['b', 'deep'],
        [`${P}/group/b`]: [],
        [`${P}/group/deep`]: ['x'],
        [`${P}/group/deep/x`]: ['four'],
        [`${P}/group/deep/x/four`]: ['five'],
        [`${P}/group/deep/x/four/five`]: ['six'],
        [`${P}/group/deep/x/four/five/six`]: [],
        [`${P}/node_modules`]: ['dep'],
        [`${P}/.hid`]: ['r'],
        [`${P}/plain`]: [],
      },
      [
        `${P}/a`,
        `${P}/a/inside`,
        `${P}/group/b`,
        `${P}/group/deep/x/four/five`,
        `${P}/group/deep/x/four/five/six`,
        // six names down: past the depth bound
        `${P}/chain/l2/l3/l4/l5/l6`,
        `${P}/node_modules/dep`,
        `${P}/.hid/r`,
      ],
      {},
      { configs: { [`${P}/a`]: '[remote "origin"]\n\turl = git@github.com:me/a.git\n' } },
    );
    const found = await scanRepos(P, { browser });
    expect(found.repos).toEqual([
      { path: 'a', remote: 'https://github.com/me/a', provider: 'github' },
      { path: 'group/b' },
      { path: 'group/deep/x/four/five' },
    ]);
    expect(found.truncated).toBe(false);
  });
  test('a project folder that is itself a repository answers just itself and is not entered further', async () => {
    const world = browserOf({ [P]: ['sub'], [`${P}/sub`]: [] }, [`${P}/.git`, `${P}/sub`]);
    const found = await scanRepos(P, { browser: world.browser });
    expect(found.repos).toEqual([{ path: '.' }]);
    expect(world.opened).toEqual([P]);
  });
  test('a link that leaves the project is not followed, and a private folder is not entered', async () => {
    const { browser, opened } = browserOf(
      { [P]: ['escape', 'dotssh'], '/elsewhere': ['r'], [`${HOME}/.ssh`]: ['r2'] },
      ['/elsewhere/r', `${HOME}/.ssh/r2`],
      { [`${P}/escape`]: '/elsewhere', [`${P}/dotssh`]: `${HOME}/.ssh` },
    );
    const found = await scanRepos(P, { browser });
    expect(found.repos).toEqual([]);
    expect(opened).toEqual([P]);
  });
  test('stops at the folder bound and at the repository bound, and says so', async () => {
    const wide: Record<string, readonly string[]> = { [P]: Array.from({ length: 70 }, (_, i) => `d${i}`) };
    for (let i = 0; i < 70; i++) wide[`${P}/d${i}`] = Array.from({ length: 60 }, (_, j) => `e${j}`);
    for (let i = 0; i < 70; i++) for (let j = 0; j < 60; j++) wide[`${P}/d${i}/e${j}`] = [];
    const folders = await scanRepos(P, { browser: browserOf(wide, []).browser });
    expect(folders.truncated).toBe(true);
    const bound = browserOf(wide, []);
    await scanRepos(P, { browser: bound.browser });
    expect(bound.opened.length).toBe(MAX_SCAN_FOLDERS);

    const many: Record<string, readonly string[]> = {
      [P]: Array.from({ length: MAX_PROJECT_REPOS + 10 }, (_, i) => `r${i}`),
    };
    const repos = many[P]?.map(name => `${P}/${name}`) ?? [];
    const capped = await scanRepos(P, { browser: browserOf(many, repos).browser });
    expect(capped.repos.length).toBe(MAX_PROJECT_REPOS);
    expect(capped.truncated).toBe(true);
  });
  test('a project folder that is not there answers nothing, and says the scan did not see everything', async () => {
    const found = await scanRepos('/nowhere', { browser: browserOf({}, []).browser });
    expect(found).toEqual({ repos: [], truncated: true });
  });
  test('a project folder outside the home folder is scanned like any other, and answers nothing but what it found', async () => {
    const world = browserOf({ '/srv/work': ['r', 'plain'], '/srv/work/r': [], '/srv/work/plain': [] }, ['/srv/work/r']);
    expect(await scanRepos('/srv/work', { browser: world.browser })).toEqual({
      repos: [{ path: 'r' }],
      truncated: false,
    });
    expect(world.opened).toEqual(['/srv/work', '/srv/work/plain']);
  });
  describe('the outside-home decision is made on the RESOLVED, held location, before anything is walked (F6061 U4 R2 item 3)', () => {
    /**
     * A project the owner spells under the home (`~/via/work`, a folder whose ANCESTOR is a link) that really is `/srv/real`:
     * the spelling's own leaf is a plain folder, so the scan accepts it as a project folder and only its resolved place is outside.
     */
    const linked = (names: readonly string[] = ['r']) => {
      const world = browserOf(
        { [`${HOME}/via/work`]: [], '/srv/real': names, '/srv/real/r': [], '/srv/real/plain': [] },
        ['/srv/real/r'],
        { [`${HOME}/via/work`]: '/srv/real' },
      );
      return { ...world, browser: { ...world.browser, leaf: async () => 'present' as const } };
    };
    test('a stored spelling under the home that resolves OUTSIDE it asks the gate once, before the folder is held; a refusal walks nothing', async () => {
      const world = linked();
      let asked = 0;
      const refusal = new Error('needs filesystem.configure');
      const outsideHome = async () => {
        asked++;
        expect(world.opened).toEqual([]);
        throw refusal;
      };
      await expect(scanRepos(`${HOME}/via/work`, { browser: world.browser, outsideHome })).rejects.toBe(refusal);
      expect(asked).toBe(1);
      expect(world.opened).toEqual([]);
      expect(world.probed).toEqual([]);
    });
    test('an accepted gate walks the resolved folder, and is asked once for the whole walk', async () => {
      const world = linked(['r', 'plain']);
      let asked = 0;
      const found = await scanRepos(`${HOME}/via/work`, {
        browser: world.browser,
        outsideHome: async () => {
          asked++;
        },
      });
      expect(found).toEqual({ repos: [{ path: 'r' }], truncated: false });
      expect(asked).toBe(1);
    });
    test('a folder that really is inside the home never asks the gate', async () => {
      const world = browserOf({ [P]: ['r'], [`${P}/r`]: [] }, [`${P}/r`]);
      const found = await scanRepos(P, {
        browser: world.browser,
        outsideHome: async () => {
          throw new Error('must not be asked');
        },
      });
      expect(found).toEqual({ repos: [{ path: 'r' }], truncated: false });
    });
  });
  test("a project folder in a skipped tree, another user's home, or a key store answers truncated, opens and probes nothing", async () => {
    for (const root of [
      '/proc/1',
      '/sys/x',
      '/dev/shm',
      '/run/user/1',
      '/nix/store/abc',
      '/home/other/work',
      '/Users/bob/w',
      '/root/w',
      `${HOME}/Library/Mail`,
      // a denied name on a real path component outside the home (F6061 U4 review item 1)
      '/srv/.ssh/proj',
      '/.gnupg',
      '/srv/.password-store/x',
    ]) {
      const world = browserOf({ [root]: ['r'], [`${root}/r`]: [] }, [`${root}/r`]);
      expect(await scanRepos(root, { browser: world.browser })).toEqual({ repos: [], truncated: true });
      expect(world.opened).toEqual([]);
      expect(world.probed).toEqual([]);
    }
  });
  test('a child on another disk is not entered or probed, and the scan says it did not see everything', async () => {
    const world = browserOf(
      { [P]: ['mnt', 'ok'], [`${P}/mnt`]: ['r'], [`${P}/mnt/r`]: [], [`${P}/ok`]: [] },
      [`${P}/mnt`, `${P}/mnt/r`, `${P}/ok`],
      {},
      { devices: { [`${P}/mnt`]: 'd2' } },
    );
    const found = await scanRepos(P, { browser: world.browser });
    expect(found).toEqual({ repos: [{ path: 'ok' }], truncated: true });
    expect(world.opened).toEqual([P]);
    expect(world.probed.filter(path => path.includes('/mnt'))).toEqual([]);
  });
  test('a mount is told by its disk BEFORE any of its names are read: no sign-in look at a folder on another disk', async () => {
    const world = browserOf(
      { [P]: ['mnt', 'ok'], [`${P}/mnt`]: ['r'], [`${P}/mnt/r`]: [], [`${P}/ok`]: [] },
      [`${P}/ok`],
      {},
      { devices: { [`${P}/mnt`]: 'd2' } },
    );
    await scanRepos(P, { browser: world.browser });
    expect(world.asked).not.toContain(`${P}/mnt`);
    expect(world.asked).toContain(`${P}/ok`);
  });
  test('a skipped mount only marks the answer partial: the rest of the same disk is still walked', async () => {
    const world = browserOf(
      {
        [P]: ['mnt', 'a'],
        [`${P}/mnt`]: [],
        [`${P}/a`]: ['b'],
        [`${P}/a/b`]: ['r'],
        [`${P}/a/b/r`]: [],
      },
      [`${P}/a/b/r`],
      {},
      { devices: { [`${P}/mnt`]: 'd2' } },
    );
    expect(await scanRepos(P, { browser: world.browser })).toEqual({ repos: [{ path: 'a/b/r' }], truncated: true });
  });
  test('a project folder on its own disk is the one disk: a mount deeper down is left out, the folder itself is not', async () => {
    const world = browserOf(
      { '/mnt/data': ['r'], '/mnt/data/r': [] },
      ['/mnt/data/r'],
      {},
      { devices: { '/mnt/data': 'd9', '/mnt/data/r': 'd9' } },
    );
    expect(await scanRepos('/mnt/data', { browser: world.browser })).toEqual({
      repos: [{ path: 'r' }],
      truncated: false,
    });
  });
  test('a folder whose disk cannot be told is not entered, and says so', async () => {
    const world = browserOf({ [P]: ['a'], [`${P}/a`]: [] }, [`${P}/a`]);
    const blind: FolderBrowser = {
      ...world.browser,
      open: async (path, verdict) => {
        const held = await world.browser.open(path, verdict);
        return held.ok
          ? { ok: true, folder: { ...held.folder, device: async rel => (rel === 'a' ? undefined : 'd1') } }
          : held;
      },
    };
    expect(await scanRepos(P, { browser: blind })).toEqual({ repos: [], truncated: true });
  });
  test('a project folder that is itself a link is refused and nothing in or behind it is touched', async () => {
    const world = browserOf(
      { [P]: ['r'], '/elsewhere': ['r'], [`${HOME}/.ssh`]: ['r'] },
      ['/elsewhere/r', `${HOME}/.ssh/r`],
      { [P]: '/elsewhere' },
    );
    expect(await scanRepos(P, { browser: world.browser })).toEqual({ repos: [], truncated: true });
    expect(world.opened).toEqual([]);
    expect(world.probed).toEqual([]);
    const toSsh = browserOf({ [P]: [], [`${HOME}/.ssh`]: ['r'] }, [`${HOME}/.ssh/r`], { [P]: `${HOME}/.ssh` });
    expect((await scanRepos(P, { browser: toSsh.browser })).repos).toEqual([]);
    expect(toSsh.probed).toEqual([]);
  });
  test('a private child (a stow-style link to ~/.ssh) is never probed, not even for a .git', async () => {
    // `stowed` is a folder of the project that is where ~/.ssh REALLY is (the private folder, reached by a link)
    const world = browserOf(
      { [P]: ['stowed', 'ok'], [`${P}/ok`]: [], [`${P}/stowed`]: [] },
      [`${P}/ok`, `${P}/stowed`],
      {},
      { configs: { [`${P}/stowed`]: '[remote "origin"]\n\turl = https://github.com/me/stolen\n' } },
    );
    const browser: FolderBrowser = {
      ...world.browser,
      realPaths: async paths => paths.map(path => (path === `${HOME}/.ssh` ? `${P}/stowed` : path)),
    };
    const found = await scanRepos(P, { browser });
    expect(found.repos.map(repo => repo.path)).toEqual(['ok']);
    expect(world.probed.filter(path => path.startsWith(`${P}/stowed`))).toEqual([]);
    expect(world.opened).not.toContain(`${P}/stowed`);
  });
  test('a child folder that holds a sign-in file is skipped unprobed, and so is a project folder that holds one', async () => {
    const world = browserOf(
      { [P]: ['keys', 'ok'], [`${P}/keys`]: [], [`${P}/ok`]: [] },
      [`${P}/keys`, `${P}/ok`],
      {},
      { signIn: [`${P}/keys`] },
    );
    expect((await scanRepos(P, { browser: world.browser })).repos.map(repo => repo.path)).toEqual(['ok']);
    expect(world.probed).not.toContain(`${P}/keys`);
    const marked = browserOf({ [P]: ['ok'], [`${P}/ok`]: [] }, [`${P}/ok`], {}, { signIn: [P] });
    // the project folder itself refused is a scan that saw nothing, never an empty project (it must not drop stored repos)
    expect(await scanRepos(P, { browser: marked.browser })).toEqual({ repos: [], truncated: true });
    expect(marked.probed).toEqual([]);
  });
  test('a child whose sign-in look could not see the whole folder is not indexed or entered, and the scan says it did not see everything (R3)', async () => {
    const world = browserOf(
      { [P]: ['wide', 'ok'], [`${P}/wide`]: ['inner'], [`${P}/wide/inner`]: [], [`${P}/ok`]: [] },
      [`${P}/wide`, `${P}/ok`, `${P}/wide/inner`],
      {},
      { partial: [`${P}/wide`] },
    );
    const found = await scanRepos(P, { browser: world.browser });
    expect(found.repos.map(repo => repo.path)).toEqual(['ok']);
    expect(found.truncated).toBe(true);
    expect(world.opened).not.toContain(`${P}/wide`);
    expect(world.probed.filter(path => path.startsWith(`${P}/wide`))).toEqual([]);
  });
  test('a folder that could not be read says the scan did not see everything', async () => {
    const world = browserOf({ [P]: ['a'], [`${P}/a`]: [] }, []);
    const flaky: FolderBrowser = {
      ...world.browser,
      open: async (path, verdict) =>
        path === `${P}/a` ? { ok: false, reason: 'refused' } : world.browser.open(path, verdict),
    };
    expect((await scanRepos(P, { browser: flaky })).truncated).toBe(true);
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
  test('a scan that did not see everything keeps a stored repository and its account link; a complete one drops it', async () => {
    const { registry, id, store } = await over();
    await registry.recordRepos(id, [{ path: 'a' }, { path: 'b' }], true);
    await store.update(file => ({
      ...file,
      projects: file.projects.map(project => ({
        ...project,
        repos: project.repos?.map(repo => (repo.path === 'b' ? { ...repo, account: 'work' } : repo)),
      })),
    }));
    const partial = await registry.recordRepos(
      id,
      [{ path: 'a', remote: 'https://github.com/o/a', provider: 'github' }],
      false,
    );
    expect(partial.ok && partial.value.repos).toEqual([
      { path: 'a', remote: 'https://github.com/o/a', provider: 'github' },
      { path: 'b', account: 'work' },
    ]);
    const nothing = await registry.recordRepos(id, [], false);
    expect(nothing.ok && nothing.value.repos?.map(repo => repo.path)).toEqual(['a', 'b']);
    const full = await registry.recordRepos(id, [{ path: 'a' }], true);
    expect(full.ok && full.value.repos).toEqual([{ path: 'a' }]);
  });
  test('a partial scan that fills the cap admits every saved path first: no saved repository or its account link is evicted by new ones (R3)', async () => {
    const { registry, id, store } = await over();
    const name = (n: number) => `s${String(n).padStart(3, '0')}`;
    const saved = Array.from({ length: MAX_PROJECT_REPOS }, (_, n) => ({ path: name(n) }));
    await registry.recordRepos(id, saved, true);
    await store.update(file => ({
      ...file,
      projects: file.projects.map(project => ({
        ...project,
        repos: project.repos?.map(repo =>
          repo.path === name(MAX_PROJECT_REPOS - 1) ? { ...repo, account: 'work' } : repo,
        ),
      })),
    }));
    // the partial scan found 10 NEW paths that sort first, and none of the saved ones
    const fresh = Array.from({ length: 10 }, (_, n) => ({ path: `a${n}` }));
    const partial = await registry.recordRepos(id, fresh, false);
    const paths = partial.ok ? (partial.value.repos ?? []).map(repo => repo.path) : [];
    expect(paths).toHaveLength(MAX_PROJECT_REPOS);
    expect(paths).toEqual(saved.map(repo => repo.path));
    expect(partial.ok && partial.value.repos?.at(-1)).toEqual({ path: name(MAX_PROJECT_REPOS - 1), account: 'work' });
    // room left: new ones are admitted after the saved ones
    await registry.recordRepos(id, saved.slice(0, 40), true);
    const room = await registry.recordRepos(id, fresh, false);
    expect(room.ok && room.value.repos).toHaveLength(MAX_PROJECT_REPOS);
    expect(room.ok && room.value.repos?.map(repo => repo.path)).toContain('a9');
  });
  test('a repository found again keeps its account; one that is gone is dropped; nothing found removes the field', async () => {
    const { registry, id, store } = await over();
    await registry.recordRepos(id, [{ path: 'a' }, { path: 'b' }], true);
    // the owner gave `a` an account of its own (the field a later unit sets)
    await store.update(file => ({
      ...file,
      projects: file.projects.map(project => ({
        ...project,
        repos: project.repos?.map(repo => (repo.path === 'a' ? { ...repo, account: 'work' } : repo)),
      })),
    }));
    const again = await registry.recordRepos(
      id,
      [{ path: 'a', remote: 'https://github.com/o/a', provider: 'github' }],
      true,
    );
    expect(again.ok && again.value.repos).toEqual([
      { path: 'a', remote: 'https://github.com/o/a', provider: 'github', account: 'work' },
    ]);
    const none = await registry.recordRepos(id, [], true);
    expect(none.ok && 'repos' in none.value).toBe(false);
  });
  test('an unchanged scan writes nothing', async () => {
    const { registry, id, store } = await over();
    await registry.recordRepos(id, [{ path: 'a' }], true);
    const written = store.file;
    await registry.recordRepos(id, [{ path: 'a' }], true);
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
