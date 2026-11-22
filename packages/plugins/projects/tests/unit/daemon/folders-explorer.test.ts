import { describe, expect, test } from 'bun:test';
import { ApiError, type ApiRequest, type CallContext } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { MakeFolderRequestSchema } from '../../../contract/index.ts';
import { FolderExplorer } from '../../../daemon/features/folders/browse.ts';
import {
  foldName as sharedFoldName,
  holdsSignIn as sharedHoldsSignIn,
  isPrivateFolder as sharedIsPrivateFolder,
} from '@ferretry/std';
import { foldName, holdsSignIn, isPrivateFolder, parsePath } from '../../../daemon/features/folders/fence.ts';
import type {
  FolderBrowser,
  FolderOpenFailure,
  HeldFolder,
  LeafMade,
  RawFolderEntry,
} from '../../../daemon/features/folders/port.ts';
import { listFoldersRoute, makeFolderRoute } from '../../../daemon/features/folders/routes.ts';

const AT = '2026-11-19T00:00:00.000Z' as Instant;
const HOME = '/home/me';

type Tree = Record<string, readonly (string | [string, 'file' | 'directory' | 'symlink'])[]>;

interface Machine {
  /** What a path REALLY is (a link): the default is itself. */
  readonly links?: Record<string, string>;
  /** Folders (by path as named) whose held object turns out to be another: the swap between the check and the hold. */
  readonly swapped?: Record<string, string>;
  readonly git?: readonly string[];
  /** What the new folder turns out to be after it is made: a path it really reaches. */
  readonly madeReaches?: Record<string, string>;
}

/** A machine of folders in a map. */
function machine(tree: Tree, options: Machine = {}) {
  const { links = {}, swapped = {}, git = [], madeReaches = {} } = options;
  const calls: string[] = [];
  const made: string[] = [];
  const removed: string[] = [];
  const names = (folder: string): readonly string[] =>
    (tree[folder] ?? []).map(item => (typeof item === 'string' ? item : item[0]));
  const kindOf = (name: string, item: string | [string, string]): RawFolderEntry['kind'] | 'symlink' => {
    if (typeof item !== 'string') return item[1] as RawFolderEntry['kind'] | 'symlink';
    return name.slice(1).includes('.') ? 'file' : 'directory';
  };
  const browser: FolderBrowser = {
    home: async () => HOME,
    holdsSignIn: async path => {
      calls.push(`holdsSignIn ${path}`);
      return holdsSignIn(names(path));
    },
    leaf: async path => (path in links ? 'link' : path in tree ? 'present' : 'missing'),
    realPaths: async paths =>
      paths.flatMap(path => {
        const real = links[path] ?? path;
        return real in tree ? [real] : [];
      }),
    open: async (path, verdict) => {
      calls.push(`open ${path}`);
      const named = links[path] ?? path;
      if (named.startsWith('/dev')) return { ok: false, reason: 'refused' };
      // Nothing there (a missing name, a dangling link) is a refusal on the real machine: it says nothing it has not verified.
      if (!(named in tree)) return { ok: false, reason: 'refused' };
      const first = await verdict(named);
      if (first !== undefined) return { ok: false, reason: first };
      const real = swapped[path] ?? named;
      const second = await verdict(real);
      if (second !== undefined) return { ok: false, reason: second as FolderOpenFailure };
      const folder: HeldFolder = {
        real,
        entries: async limit => {
          calls.push(`entries ${real}`);
          const items = (tree[real] ?? []).flatMap(item => {
            const name = typeof item === 'string' ? item : item[0];
            const kind = kindOf(name, item);
            return kind === 'symlink' || kind === ('other' as string) ? [] : [{ name, kind, modified: AT }];
          });
          return { entries: items.slice(0, limit), more: items.length > limit };
        },
        lookup: async name => {
          const item = (tree[real] ?? []).find(entry => (typeof entry === 'string' ? entry : entry[0]) === name);
          if (item === undefined) return 'missing';
          return kindOf(name, item) === 'symlink' ? 'link' : 'present';
        },
        readText: async () => undefined,
        hasGit: async name => git.includes(`${real}/${name}`),
        device: async () => 'd1',
        makeLeaf: async (name, judge): Promise<LeafMade> => {
          const target = `${real}/${name}`;
          if (names(real).includes(name)) return { kind: 'exists' };
          made.push(target);
          const lands = madeReaches[target] ?? target;
          const refusal = await judge(lands);
          if (refusal === undefined) return { kind: 'made', path: target };
          removed.push(target);
          return { kind: 'refused', reason: refusal };
        },
        close: async () => undefined,
      };
      return { ok: true, folder };
    },
  };
  const explorer = new FolderExplorer({
    browser,
    folders: {
      mayName: async path => {
        calls.push(`mayName ${path}`);
        return !path.startsWith('/home/me/fenced');
      },
    },
  });
  return { explorer, made, removed, calls };
}

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error as { status: number; code: string; message: string };
  }
  throw new Error('it answered');
};

const BASE: Tree = {
  [HOME]: ['code', 'Docs', 'notes.txt', '.ssh', '.config', '.bashrc', '.git-credentials', 'Alpha', '.claude', 'keys'],
  [`${HOME}/code`]: ['app', 'zeta.md', 'lib'],
  [`${HOME}/.config`]: ['gh', 'nvim'],
  [`${HOME}/.config/gh`]: ['hosts.yml'],
  [`${HOME}/.ssh`]: ['id_work_ed25519'],
  [`${HOME}/keys`]: ['id_rsa', 'x'],
  [`${HOME}/keys/sub`]: ['deeper'],
  [`${HOME}/keys/sub/deeper`]: [],
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

  test('names match the way a filesystem would: case, Unicode forms, width, invisible characters', () => {
    for (const spelling of ['.SSH', '.Ssh', '.ſsh', '.ｓｓｈ', '.s​sh', '.ssh‍', '.sṡh']) {
      expect(foldName(spelling)).toBe('.ssh');
      expect(isPrivateFolder([spelling])).toBe(true);
    }
    expect(isPrivateFolder(['.Config', 'GH', 'x'])).toBe(true);
    expect(isPrivateFolder(['.config', 'Gcloud'])).toBe(true);
    // A decomposed accent is the same name as the composed one on a disk that normalizes.
    expect(foldName('café')).toBe(foldName('café'));
    expect(holdsSignIn(['ID_RSA'])).toBe(true);
    expect(holdsSignIn(['Auth.JSON'])).toBe(true);
    expect(holdsSignIn(['id_rsa.pub'])).toBe(false);
  });

  test('a project folder holding a .env, a key file or an .npmrc is an ordinary folder, not a sign-in folder', () => {
    expect(holdsSignIn(['.env', '.npmrc', 'server.pem', 'package.json'])).toBe(false);
  });

  test('the fence reads the one shared secret-name list', () => {
    expect(holdsSignIn).toBe(sharedHoldsSignIn);
    expect(isPrivateFolder).toBe(sharedIsPrivateFolder);
    expect(foldName).toBe(sharedFoldName);
  });
});

describe('FolderExplorer.list', () => {
  test('starts at ~: folders first, hidden dot-names, private folders and sign-in folders left out, a link never listed', async () => {
    const { explorer } = machine({
      ...BASE,
      [HOME]: [...(BASE[HOME] as string[]), ['link', 'symlink'], ['pipe', 'other' as 'file']],
    });
    const listing = await explorer.list('~', false);
    expect(listing.path).toBe(HOME);
    expect(listing.crumbs).toEqual([{ name: '~', path: HOME }]);
    // `keys` holds an id_rsa: the parent does not list it either.
    expect(listing.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual([
      'folder:Alpha',
      'folder:Docs',
      'folder:code',
      'file:notes.txt',
    ]);
    expect(listing.truncated).toBe(false);
  });

  test('hidden=1 shows dot-names but still never a private folder or its name, in any spelling', async () => {
    const { explorer } = machine({ ...BASE, [HOME]: [...(BASE[HOME] as string[]), '.SSH', '.s​sh', '.Config'] });
    const names = (await explorer.list('~', true)).entries.map(entry => entry.name);
    expect(names).toContain('.config');
    expect(names).toContain('.Config');
    expect(names).toContain('.bashrc');
    for (const away of ['.ssh', '.claude', '.SSH', '.s​sh', 'keys']) expect(names).not.toContain(away);
    const hidden = (await explorer.list('~', true)).entries.find(entry => entry.name === '.config');
    expect(hidden?.hidden).toBe(true);
    // `.config/gh` is private, so listing `.config` names only the rest.
    expect((await explorer.list('~/.config', true)).entries.map(entry => entry.name)).toEqual(['nvim']);
    const upper = machine({ ...BASE, [`${HOME}/.config`]: ['GH', 'Gcloud', 'nvim'] });
    expect((await upper.explorer.list('~/.config', true)).entries.map(entry => entry.name)).toEqual(['nvim']);
  });

  test('a subfolder lists with breadcrumbs and a repo is marked', async () => {
    const { explorer } = machine(BASE, { git: [`${HOME}/code/app`] });
    const listing = await explorer.list(`${HOME}/code`, false);
    expect(listing.crumbs.map(crumb => crumb.name)).toEqual(['~', 'code']);
    expect(listing.crumbs[1]?.path).toBe(`${HOME}/code`);
    expect(listing.entries.map(entry => [entry.name, entry.isRepo])).toEqual([
      ['app', true],
      ['lib', false],
      ['zeta.md', false],
    ]);
  });

  test('refuses a private folder, a folder holding a key, and a link into a private folder', async () => {
    const { explorer } = machine(BASE, { links: { [`${HOME}/innocent`]: `${HOME}/.ssh` } });
    expect((await failure(() => explorer.list('~/.ssh', true))).code).toBe('private_folder');
    expect((await failure(() => explorer.list('~/.SSH', true))).code).toBe('private_folder');
    expect((await failure(() => explorer.list('~/.config/gh', true))).code).toBe('private_folder');
    // What the disk decides (a sign-in folder, a link into a private folder) is the one refusal, never "private".
    expect((await failure(() => explorer.list('~/keys', false))).code).toBe('folder_refused');
    expect((await failure(() => explorer.list('~/innocent', false))).code).toBe('folder_refused');
    expect((await failure(() => explorer.list('~/nope', false))).code).toBe('folder_refused');
    expect((await failure(() => explorer.list('code', false))).status).toBe(400);
    expect((await failure(() => explorer.list('~/../etc', false))).status).toBe(400);
  });

  test('one credential policy: a folder UNDER a sign-in folder is refused too, and so is each way to it', async () => {
    const { explorer } = machine(BASE, { links: { [`${HOME}/short`]: `${HOME}/keys/sub/deeper` } });
    expect((await failure(() => explorer.list('~/keys/sub', false))).code).toBe('folder_refused');
    expect((await failure(() => explorer.list('~/keys/sub/deeper', false))).code).toBe('folder_refused');
    expect((await failure(() => explorer.list('~/short', false))).code).toBe('folder_refused');
    // A folder that holds one of its own marks in a different case is the same folder on a disk that folds case.
    const mixed = machine({ ...BASE, [`${HOME}/Docs`]: ['ID_ED25519'] });
    expect((await failure(() => mixed.explorer.list('~/Docs', false))).code).toBe('folder_refused');
  });

  test('one fold for the marker check in every place: the listed folder, a listed child, an ancestor, the write parent, the destination', async () => {
    const tree: Tree = {
      ...BASE,
      [`${HOME}/a`]: ['Auth.JSON'],
      [`${HOME}/b`]: ['plain', 'marked'],
      [`${HOME}/b/plain`]: [],
      [`${HOME}/b/marked`]: ['ｉｄ_ｒｓａ'],
      [`${HOME}/c`]: ['ID_Ed25519', 'inner'],
      [`${HOME}/c/inner`]: [],
      [`${HOME}/d`]: ['Hosts.YML'],
      [`${HOME}/e`]: ['dest', 'fine'],
      [`${HOME}/e/dest`]: ['.CREDENTIALS.json'],
      [`${HOME}/e/fine`]: [],
    };
    const { explorer, made } = machine(tree);
    // The listed folder.
    expect((await failure(() => explorer.list('~/a', false))).code).toBe('folder_refused');
    // A listed child: shown by the parent only when it holds no marker in any spelling.
    expect((await explorer.list('~/b', false)).entries.map(entry => entry.name)).toEqual(['plain']);
    // An ancestor below the home.
    expect((await failure(() => explorer.list('~/c/inner', false))).code).toBe('folder_refused');
    // The write parent.
    expect((await failure(() => explorer.make({ parent: '~/d', name: 'x' }))).code).toBe('folder_refused');
    // The destination: an existing folder holding a marker is refused as the folder it is, before "already there".
    const destination = await failure(() => explorer.make({ parent: '~/e', name: 'dest' }));
    expect([destination.status, destination.code]).toEqual([403, 'folder_refused']);
    expect((await failure(() => explorer.make({ parent: '~/e', name: 'fine' }))).code).toBe('folder_exists');
    expect(made).toEqual([]);
  });

  test('a folder is listed from the object held, and a hold that is not the folder judged is refused unread', async () => {
    const swapped = machine(BASE, { swapped: { [`${HOME}/code`]: `${HOME}/.ssh` } });
    expect((await failure(() => swapped.explorer.list('~/code', true))).code).toBe('folder_refused');
    expect(swapped.calls.some(call => call.startsWith('entries'))).toBe(false);
    const out = machine(BASE, { swapped: { [`${HOME}/code`]: '/proc/1' } });
    expect((await failure(() => out.explorer.list('~/code', true))).code).toBe('folder_refused');
    expect(out.calls.some(call => call.startsWith('entries'))).toBe(false);
    // Listed from the real path of what was held.
    const held = machine(BASE, { swapped: { [`${HOME}/Docs`]: `${HOME}/code` } });
    const listing = await held.explorer.list('~/Docs', false);
    expect(listing.path).toBe(`${HOME}/code`);
    expect(listing.entries.map(entry => entry.name)).toContain('app');
  });

  test("outside the home, a caller that fails the gate gets the gate's answer before the machine is touched, whether or not it exists", async () => {
    const { explorer, calls } = machine(BASE, {
      links: { [`${HOME}/escape`]: '/etc', [`${HOME}/escape-missing`]: '/nowhere', [`${HOME}/dev`]: '/dev/null' },
    });
    const deny = async () => {
      throw new ApiError(403, 'needs configure', 'grant_step_up_required');
    };
    for (const path of ['/etc', '/etc/passwd', '/nonexistent', '/home/mee', '/home', '/', '/proc', '/home/other']) {
      calls.length = 0;
      const refused = await failure(() => explorer.list(path, false, deny));
      expect([refused.status, refused.code]).toEqual([403, 'grant_step_up_required']);
      expect(calls.filter(call => call.startsWith('open'))).toEqual([]);
    }
    // A link in the home that leads out is gated after it resolves, and nothing is read from there.
    for (const link of ['~/escape']) {
      calls.length = 0;
      expect((await failure(() => explorer.list(link, false, deny))).code).toBe('grant_step_up_required');
      expect(calls.some(call => call.startsWith('entries'))).toBe(false);
    }
    // GAP (stated in browse.ts): a link that leads nowhere never reaches the gate.
    expect((await failure(() => explorer.list('~/escape-missing', false, deny))).code).toBe('folder_refused');
    // The home is never gated.
    let asked = 0;
    const count = async () => {
      asked++;
    };
    await explorer.list('~/code', false, count);
    await explorer.list('~', false, count);
    expect(asked).toBe(0);
  });

  test('a caller that passes the gate lists outside the home: crumbs from /, the gate asked once, other homes and pseudo trees left out', async () => {
    const world = machine({
      ...BASE,
      '/': ['etc', 'proc', 'home', 'srv', 'dev', 'run', 'nix'],
      '/etc': ['passwd'],
      '/home': ['me', 'other', 'shared.txt'],
      '/srv': ['www', 'app', 'keys'],
      '/srv/www': ['site'],
      '/srv/www/site': [],
      '/srv/keys': ['id_rsa'],
    });
    let asked = 0;
    const allow = async () => {
      asked++;
    };
    const root = await world.explorer.list('/', false, allow);
    expect(root.path).toBe('/');
    expect(root.crumbs).toEqual([{ name: '/', path: '/' }]);
    expect(root.entries.map(entry => entry.name)).toEqual(['etc', 'home', 'nix', 'srv']);
    expect(root.broad).toBe(true);
    expect(asked).toBe(1);
    const home = await world.explorer.list('/home', false, allow);
    expect(home.entries.map(entry => entry.name)).toEqual(['me', 'shared.txt']);
    expect(home.broad).toBe(true);
    const site = await world.explorer.list('/srv/www/site', false, allow);
    expect(site.crumbs).toEqual([
      { name: '/', path: '/' },
      { name: 'srv', path: '/srv' },
      { name: 'www', path: '/srv/www' },
      { name: 'site', path: '/srv/www/site' },
    ]);
    expect(site.broad).toBeUndefined();
    // each request asks the gate ONCE however many real paths it judges (the spelling, the first look, the held object)
    asked = 0;
    await world.explorer.list('/srv/www', false, allow);
    expect(asked).toBe(1);
    // the same fence applies out there: a folder that holds a sign-in file is refused as the one it is, and so are the trees
    expect((await failure(() => world.explorer.list('/srv/keys', false, allow))).code).toBe('folder_refused');
    for (const path of ['/proc', '/dev', '/run', '/home/other', '/home/other/x'])
      expect((await failure(() => world.explorer.list(path, false, allow))).code).toBe('folder_refused');
  });

  test('without a gate (the caller at the machine) every place the policy accepts is listed, and a missing one is the one refusal', async () => {
    const { explorer } = machine({ ...BASE, '/srv': ['a'], '/srv/a': [] });
    expect((await explorer.list('/srv', false)).entries.map(entry => entry.name)).toEqual(['a']);
    expect((await failure(() => explorer.list('/nonexistent', false))).code).toBe('folder_refused');
  });

  test('a denied name is refused outside the home as it is inside (.ssh, .gnupg, .password-store as a path part), and a secret name is never listed', async () => {
    const world = machine({
      ...BASE,
      '/': ['srv', '.ssh', '.gnupg'],
      '/.ssh': ['config'],
      '/.gnupg': ['pubring.kbx'],
      '/srv': ['ok', '.ssh', '.password-store', 'plain'],
      '/srv/.ssh': ['known', 'deep'],
      '/srv/.ssh/deep': [],
      '/srv/.password-store': ['x'],
      '/srv/ok': ['.env', 'key.pem', 'cert.p12', 'id_ed25519.pub', '.env.local', 'notes.txt', 'sub'],
      '/srv/ok/sub': [],
      '/srv/plain': [],
    });
    const allow = async () => undefined;
    // the same refusal as a place that is not there: a denied name is never confirmed to exist
    for (const path of ['/.ssh', '/.gnupg', '/srv/.ssh', '/srv/.ssh/deep', '/srv/.password-store'])
      expect([path, (await failure(() => world.explorer.list(path, true, allow))).code]).toEqual([
        path,
        'folder_refused',
      ]);
    // a denied folder is not listed among its parent's names, even when hidden names are asked for
    const srv = await world.explorer.list('/srv', true, allow);
    expect(srv.entries.map(entry => entry.name)).toEqual(['ok', 'plain']);
    expect((await world.explorer.list('/', true, allow)).entries.map(entry => entry.name)).toEqual(['srv']);
    // a secret FILE name is not listed either, outside the home or in it
    const ok = await world.explorer.list('/srv/ok', true, allow);
    expect(ok.entries.map(entry => entry.name)).toEqual(['sub', 'notes.txt']);
    const code = await machine({ ...BASE, [`${HOME}/code`]: ['app', '.env', 'server.pem', 'readme.md'] }).explorer.list(
      '~/code',
      true,
    );
    expect(code.entries.map(entry => entry.name)).toEqual(['app', 'readme.md']);
  });

  test('a listing is bounded at 500 and says so, counting only what is shown', async () => {
    const many = Array.from({ length: 700 }, (_, index) => `d${String(index).padStart(4, '0')}`);
    const { explorer } = machine({ ...BASE, [`${HOME}/many`]: many });
    const listing = await explorer.list('~/many', false);
    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(true);
    expect(listing.entries[0]?.name).toBe('d0000');
    const few = machine({ ...BASE, [`${HOME}/few`]: many.slice(0, 500) });
    expect((await few.explorer.list('~/few', false)).truncated).toBe(false);
  });
});

describe('FolderExplorer.make', () => {
  test('makes one level under a held parent and answers the real path', async () => {
    const { explorer, made } = machine(BASE);
    expect(await explorer.make({ parent: '~/code', name: 'fresh' })).toEqual({ path: `${HOME}/code/fresh` });
    expect(made).toEqual([`${HOME}/code/fresh`]);
  });

  test('refuses an existing name, a private or outside parent, a fenced place and a missing parent; makes nothing', async () => {
    const { explorer, made } = machine(BASE, { links: { [`${HOME}/escape`]: '/etc' } });
    expect((await failure(() => explorer.make({ parent: '~/code', name: 'app' }))).code).toBe('folder_exists');
    expect((await failure(() => explorer.make({ parent: '~/.ssh', name: 'x' }))).code).toBe('private_folder');
    expect((await failure(() => explorer.make({ parent: '~/escape', name: 'x' }))).code).toBe('folder_refused');
    expect((await failure(() => explorer.make({ parent: '/etc', name: 'x' }))).code).toBe('folder_refused');
    expect((await failure(() => explorer.make({ parent: '~/nope', name: 'x' }))).code).toBe('folder_refused');
    await explorer.make({ parent: '~/Docs', name: 'a' });
    expect(made).toEqual([`${HOME}/Docs/a`]);
  });

  test('the imports fence refusing the target makes nothing', async () => {
    const { explorer, made } = machine({ ...BASE, [`${HOME}/fenced`]: [] });
    expect((await failure(() => explorer.make({ parent: '~/fenced', name: 'x' }))).code).toBe('folder_refused');
    expect(made).toEqual([]);
  });

  test('the one policy: not in a sign-in folder or under one, and the destination is judged before it is looked up', async () => {
    const { explorer, made, calls } = machine(BASE);
    expect((await failure(() => explorer.make({ parent: '~/keys', name: 'x' }))).code).toBe('folder_refused');
    expect((await failure(() => explorer.make({ parent: '~/keys/sub', name: 'x' }))).code).toBe('folder_refused');
    // `.config/gh` exists, and `.config/gcloud` does not: both are refused as private, never as taken or as free.
    for (const name of ['gh', 'GH', 'Gh', 'gcloud']) {
      calls.length = 0;
      expect((await failure(() => explorer.make({ parent: '~/.config', name }))).code).toBe('private_folder');
      expect(calls).toEqual([]);
    }
    expect((await failure(() => explorer.make({ parent: '~/.Config', name: 'gh' }))).code).toBe('private_folder');
    expect((await failure(() => explorer.make({ parent: '~/.local/share', name: 'keyrings' }))).code).toBe(
      'private_folder',
    );
    expect(made).toEqual([]);
    // The home is exempt from the sign-in rule, so a folder can be made in it.
    expect((await explorer.make({ parent: '~', name: 'ok' })).path).toBe(`${HOME}/ok`);
  });

  test('outside the home answers like a missing place: the same words, nothing probed', async () => {
    const { explorer, calls } = machine(BASE);
    const a = await failure(() => explorer.make({ parent: '/etc', name: 'x' }));
    const b = await failure(() => explorer.make({ parent: '/nonexistent/deep', name: 'x' }));
    expect([a.status, a.code, a.message]).toEqual([b.status, b.code, b.message]);
    expect(calls.filter(call => call.startsWith('open'))).toEqual([]);
  });

  test('a folder that is not where it should be once made is taken back and refused', async () => {
    const { explorer, made, removed } = machine(BASE, {
      madeReaches: { [`${HOME}/code/swapped`]: '/etc', [`${HOME}/code/inkeys`]: `${HOME}/.ssh` },
    });
    expect((await failure(() => explorer.make({ parent: '~/code', name: 'swapped' }))).code).toBe('folder_refused');
    expect((await failure(() => explorer.make({ parent: '~/code', name: 'inkeys' }))).code).toBe('folder_refused');
    expect(made).toEqual([`${HOME}/code/swapped`, `${HOME}/code/inkeys`]);
    expect(removed).toEqual(made);
  });

  test('the parent held is not the one named: judged again by what it is', async () => {
    const { explorer, made } = machine(BASE, { swapped: { [`${HOME}/code`]: `${HOME}/.ssh` } });
    expect((await failure(() => explorer.make({ parent: '~/code', name: 'x' }))).code).toBe('folder_refused');
    expect(made).toEqual([]);
  });
});

describe('private folders reached through a link inside the home (stow / dotfiles)', () => {
  /** `~/.gnupg`, `~/.aws` and `~/.ssh` are links to folders kept in `~/dotfiles`; the keys there are not marker names. */
  const stowed = () =>
    machine(
      {
        ...BASE,
        [HOME]: [...(BASE[HOME] as string[]), 'dotfiles', ['.gnupg', 'symlink'], ['.aws', 'symlink']],
        [`${HOME}/dotfiles`]: ['gnupg', 'aws', 'ssh', 'plain'],
        [`${HOME}/dotfiles/gnupg`]: ['private-keys-v1.d', 'sub'],
        [`${HOME}/dotfiles/gnupg/sub`]: [],
        [`${HOME}/dotfiles/aws`]: ['credentials'],
        [`${HOME}/dotfiles/ssh`]: ['id_work_ed25519'],
        [`${HOME}/dotfiles/plain`]: ['fine'],
        [`${HOME}/dotfiles/plain/fine`]: [],
      },
      {
        links: {
          [`${HOME}/.gnupg`]: `${HOME}/dotfiles/gnupg`,
          [`${HOME}/.aws`]: `${HOME}/dotfiles/aws`,
          [`${HOME}/.ssh`]: `${HOME}/dotfiles/ssh`,
        },
      },
    );

  test('the folder a private name links to is private itself, and so is everything under it', async () => {
    const { explorer, made } = stowed();
    for (const path of ['~/dotfiles/gnupg', '~/dotfiles/gnupg/sub', '~/dotfiles/aws', '~/dotfiles/ssh'])
      expect((await failure(() => explorer.list(path, true))).code).toBe('folder_refused');
    for (const parent of ['~/dotfiles/gnupg', '~/dotfiles/gnupg/sub', '~/dotfiles/aws', '~/dotfiles/ssh'])
      expect((await failure(() => explorer.make({ parent, name: 'x' }))).code).toBe('folder_refused');
    expect(made).toEqual([]);
    // The rest of the dotfiles folder is ordinary, and does not name the private ones.
    const listing = await explorer.list('~/dotfiles', true);
    expect(listing.entries.map(entry => entry.name)).toEqual(['plain']);
    expect((await explorer.make({ parent: '~/dotfiles/plain', name: 'ok' })).path).toBe(`${HOME}/dotfiles/plain/ok`);
  });

  test('a destination that is such a folder is refused, never made or reported taken', async () => {
    const { explorer, made } = stowed();
    for (const name of ['gnupg', 'aws', 'ssh'])
      expect((await failure(() => explorer.make({ parent: '~/dotfiles', name }))).code).toBe('folder_refused');
    expect(made).toEqual([]);
  });
});

describe('what the disk decided answers the same whether or not the place exists', () => {
  const answer = async (run: () => Promise<unknown>) => {
    const error = await failure(run);
    return [error.status, error.code, error.message].join(' ');
  };

  test('a guessed path under a sign-in folder or a link into a private folder, listed or written', async () => {
    const { explorer } = machine(BASE, { links: { [`${HOME}/innocent`]: `${HOME}/.ssh` } });
    const pairs: [string, string][] = [
      ['~/keys/sub', '~/keys/nothing-here'],
      ['~/keys', '~/keys-missing'],
      ['~/innocent', '~/nowhere'],
      ['~/innocent/id_work_ed25519', '~/innocent/guess'],
    ];
    for (const [present, absent] of pairs) {
      expect(await answer(() => explorer.list(present, false))).toBe(await answer(() => explorer.list(absent, false)));
      expect(await answer(() => explorer.make({ parent: present, name: 'x' }))).toBe(
        await answer(() => explorer.make({ parent: absent, name: 'x' })),
      );
    }
    expect(await answer(() => explorer.list('~/keys/sub', false))).toBe(
      '403 folder_refused that folder is not there, or cannot be listed',
    );
  });
});

describe('an existing destination is looked at without being followed', () => {
  test('a link there is "already there" (409) whatever it points at, and nothing behind it is opened', async () => {
    const { explorer, made, calls } = machine(
      {
        ...BASE,
        [HOME]: [...(BASE[HOME] as string[]), ['to-out', 'symlink'], ['to-keys', 'symlink'], ['to-nothing', 'symlink']],
        '/outside': ['id_rsa'],
      },
      { links: { [`${HOME}/to-out`]: '/outside', [`${HOME}/to-keys`]: `${HOME}/keys` } },
    );
    for (const name of ['to-out', 'to-keys', 'to-nothing']) {
      calls.length = 0;
      const taken = await failure(() => explorer.make({ parent: '~', name }));
      expect([taken.status, taken.code]).toEqual([409, 'folder_exists']);
      expect(calls.filter(call => call.startsWith('holdsSignIn /') && !call.startsWith(`holdsSignIn ${HOME}`))).toEqual(
        [],
      );
      expect(calls.some(call => call.includes(name))).toBe(false);
    }
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

  test('GET through a governed device: the home needs only what the route declares; a place outside it needs filesystem.configure', async () => {
    const { explorer } = machine({ ...BASE, '/': ['etc', 'srv'], '/etc': [], '/srv': [] });
    const list = listFoldersRoute(explorer);
    const governed = (configure: boolean): CallContext =>
      ({
        ...call({ path: '/' }),
        governance: {
          governed: true,
          decide: () =>
            configure ? { allowed: true, refusal: 'granted' } : { allowed: false, refusal: 'step-up-required' },
        },
      }) as unknown as CallContext;
    const useOnly = governed(false);
    const home = { ...useOnly, request: call({}).request } as CallContext;
    expect(JSON.parse(String((await list(home)).body)).path).toBe(HOME);
    const refused = await failure(() => list(useOnly));
    expect([refused.status, refused.code]).toEqual([403, 'grant_step_up_required']);
    const allowed = JSON.parse(String((await list(governed(true))).body)) as {
      path: string;
      crumbs: { name: string }[];
    };
    expect(allowed.path).toBe('/');
    expect(allowed.crumbs[0]?.name).toBe('/');
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
