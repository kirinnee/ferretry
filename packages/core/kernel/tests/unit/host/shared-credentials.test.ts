/**
 * Shared credentials: `RootsPort.shareCredential` mints ONE sign-in file of the `credentials` root's owner (Logins), bound
 * to one receiving plugin (`codex`), and `RootHandle.linkCredential` makes ONE symlink to it in the receiver's own
 * agent home. On the real roots port and a real disk, with the sign-in file pinned by inode as Logins' manifest pins it.
 * Who may mint, who may place and where, that the file must still be the one minted, and that nothing else the private
 * fence refuses is widened.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { RootHandle, RootName, RootsPort, SharedCredential } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { SharedTreeError } from '../../../host/shared-trees.ts';

const CREDENTIALS = defineState({ name: 'credentials', path: 'credentials/*', store: 'opaque', format: 1 });
/** Logins' manifest: `privacy.private: ['credentials']` composes to this pinned place. */
const PRIVATE = ['state/logins/credentials'];

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const fs = nodeFs(() => crypto.randomUUID());

interface PortOptions {
  readonly shareCredentials?: readonly string[];
}

/** A home with login `work`'s fake `auth.json`, pinned the way Logins' manifest pins it. */
async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-shared-creds-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state/logins/credentials/work`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/state/logins/credentials/work/auth.json`, '{"fake":"tokens"}\n', { mode: 0o600 });
  await ensureInternalRootBases(fs, { home, plugin: 'logins' }, ['credentials', 'agent-homes']);
  for (const plugin of ['codex', 'skills', 'claude-code'])
    await ensureInternalRootBases(fs, { home, plugin }, ['agent-homes']);
  const workFolders: WorkFolders = { folderOf: () => undefined, check: () => err('outside') };
  const stops: (() => void)[] = [];
  const port = (plugin: string, declared: readonly RootName[], options: PortOptions = {}): RootsPort =>
    rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, declared, () => workFolders, {
      ...(options.shareCredentials === undefined ? {} : { shareCredentials: options.shareCredentials }),
      stateFiles: [CREDENTIALS],
      privateFiles: PRIVATE,
      onStop: fn => stops.push(fn),
    });
  const logins = port('logins', ['credentials', 'agent-homes'], { shareCredentials: ['auth.json'] });
  const codex = port('codex', ['agent-homes']);
  const skills = port('skills', ['agent-homes']);
  const canonical = `${home}/state/logins/credentials/work/auth.json`;
  return {
    parent,
    home,
    port,
    logins,
    codex,
    skills,
    canonical,
    stopLogins: () => {
      for (const fn of stops.splice(0)) fn();
    },
    /** A ferret's own home, scoped the way the Codex harness scopes it. */
    homeOf: (root: RootsPort, ferret = 'f1'): RootHandle => root.root('agent-homes', { subfolder: ferret }),
    homePath: (plugin: string, ferret = 'f1') => `${home}/state/${plugin}/agent-homes/${ferret}`,
  };
}
type World = Awaited<ReturnType<typeof world>>;

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

const mint = async (w: World, over: Partial<{ folder: string; file: string; receiver: string }> = {}) =>
  await w.logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex', ...over });

const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'none';
  } catch (error) {
    if (error instanceof SharedTreeError) return error.refusal;
    if (error instanceof RootError) return `root:${error.refusal}`;
    throw error;
  }
};

describe('RootsPort.shareCredential: who may mint, from what', () => {
  test('1: a plugin other than logins that declares shareCredentials and credentials mints nothing', async () => {
    const w = await world();
    const impostor = w.port('skills', ['credentials'], { shareCredentials: ['auth.json'] });
    expect(await refusalOf(impostor.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' }))).toBe(
      'not_permitted',
    );
    // and its credentials root is not even holdable
    expect(() => impostor.root('credentials')).toThrow();
  });

  test('2: logins without shareCredentials, or a file the list does not name, mints nothing', async () => {
    const w = await world();
    const none = w.port('logins', ['credentials']);
    expect(await refusalOf(none.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' }))).toBe(
      'not_permitted',
    );
    const listed = w.port('logins', ['credentials'], { shareCredentials: ['auth.json'] });
    await writeFile(`${w.home}/state/logins/credentials/work/other.json`, '{}', { mode: 0o600 });
    for (const file of ['other.json', '*', '', 'auth.json/..', '../auth.json'])
      expect(await refusalOf(listed.shareCredential({ folder: 'work', file, receiver: 'codex' }))).toBe(
        'not_permitted',
      );
    // a star in the list matches nothing
    const star = w.port('logins', ['credentials'], { shareCredentials: ['*'] });
    expect(await refusalOf(star.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' }))).toBe(
      'not_permitted',
    );
    // logins must also have declared the credentials root
    const undeclared = w.port('logins', ['agent-homes'], { shareCredentials: ['auth.json'] });
    expect(await refusalOf(undeclared.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' }))).toBe(
      'not_permitted',
    );
  });

  test('3: a folder that is not one plain segment, or a file that is a link, a folder or has two names, is refused', async () => {
    const w = await world();
    for (const folder of ['..', 'a/b', '', '.', '/work']) expect(await refusalOf(mint(w, { folder }))).toBe('not_own');
    for (const receiver of ['', 'a/b', '..']) expect(await refusalOf(mint(w, { receiver }))).toBe('not_own');
    expect(await refusalOf(mint(w, { folder: 'missing' }))).toBe('absent');
    // a symlink at the file's name
    await mkdir(`${w.home}/state/logins/credentials/linked`, { mode: 0o700 });
    await symlink(w.canonical, `${w.home}/state/logins/credentials/linked/auth.json`);
    expect(await refusalOf(mint(w, { folder: 'linked' }))).toBe('not_own');
    // a directory at the file's name
    await mkdir(`${w.home}/state/logins/credentials/dir/auth.json`, { recursive: true, mode: 0o700 });
    expect(await refusalOf(mint(w, { folder: 'dir' }))).toBe('not_own');
    // a file with a second hard link
    await mkdir(`${w.home}/state/logins/credentials/twice`, { mode: 0o700 });
    await link(w.canonical, `${w.home}/state/logins/credentials/twice/auth.json`);
    expect(await refusalOf(mint(w, { folder: 'twice' }))).toBe('not_own');
    // a login folder that is itself a link
    await symlink(`${w.home}/state/logins/credentials/work`, `${w.home}/state/logins/credentials/alias`);
    expect(await refusalOf(mint(w, { folder: 'alias' }))).toBe('not_own');
    // a file that is not there
    await mkdir(`${w.home}/state/logins/credentials/empty`, { mode: 0o700 });
    expect(await refusalOf(mint(w, { folder: 'empty' }))).toBe('absent');
  });
});

describe('a shared credential is unforgeable, bound to its receiver, and lives as long as its minter', () => {
  test('4: a forged object, a spread copy and a JSON round trip open nothing, and the JSON names only the file', async () => {
    const w = await world();
    const credential = await mint(w);
    const home = w.homeOf(w.codex);
    expect(JSON.stringify(credential)).toBe('{"credential":"auth.json"}');
    expect(Object.keys(credential)).toEqual([]);
    expect(Object.isFrozen(credential)).toBe(true);
    expect(JSON.stringify(credential)).not.toContain(w.home);
    expect(JSON.stringify(credential)).not.toContain('work');
    for (const fake of [
      {},
      { ...credential },
      JSON.parse(JSON.stringify(credential)),
      null,
      'auth.json',
    ] as unknown as SharedCredential[])
      expect(await refusalOf(home.linkCredential(fake, resolved(home, 'auth.json')))).toBe('not_shared');
    await expect(lstat(`${w.homePath('codex')}/auth.json`)).rejects.toThrow();
  });

  test('4: the minter’s stop revokes every credential it minted', async () => {
    const w = await world();
    const credential = await mint(w);
    const home = w.homeOf(w.codex);
    w.stopLogins();
    expect(await refusalOf(home.linkCredential(credential, resolved(home, 'auth.json')))).toBe('not_shared');
  });

  test('5: another plugin’s agent-homes handle given a credential bound to codex is refused not_receiver', async () => {
    const w = await world();
    const credential = await mint(w);
    for (const other of [w.skills, w.port('claude-code', ['agent-homes']), w.logins]) {
      const home = w.homeOf(other);
      expect(await refusalOf(home.linkCredential(credential, resolved(home, 'auth.json')))).toBe('not_receiver');
    }
    await expect(lstat(`${w.homePath('skills')}/auth.json`)).rejects.toThrow();
  });

  test('a destination that is not agent-homes is refused before the credential is opened', async () => {
    const w = await world();
    const credential = await mint(w);
    const creds = w.logins.root('credentials');
    expect(await refusalOf(creds.linkCredential(credential, resolved(creds, 'work/auth2.json')))).toBe('not_internal');
    expect(await refusalOf(creds.linkCredential({} as SharedCredential, resolved(creds, 'x')))).toBe('not_internal');
  });
});

describe('RootHandle.linkCredential: where it may land', () => {
  test('6: a handle not scoped to a subfolder, a nested path or another name is refused outside', async () => {
    const w = await world();
    const credential = await mint(w);
    const unscoped = w.codex.root('agent-homes');
    expect(await refusalOf(unscoped.linkCredential(credential, resolved(unscoped, 'auth.json')))).toBe('root:outside');
    expect(await refusalOf(unscoped.linkCredential(credential, resolved(unscoped, 'f1/auth.json')))).toBe(
      'root:outside',
    );
    const home = w.homeOf(w.codex);
    expect(await refusalOf(home.linkCredential(credential, resolved(home, 'sub/auth.json')))).toBe('root:outside');
    expect(await refusalOf(home.linkCredential(credential, resolved(home, 'other.json')))).toBe('root:outside');
    expect(await refusalOf(home.linkCredential(credential, resolved(home, '.')))).toBe('root:outside');
    // a path that tries to climb out of the home
    expect(await refusalOf(home.linkCredential(credential, '../g/auth.json' as FencedPath))).toStartWith('root:');
    await expect(lstat(`${w.homePath('codex')}/auth.json`)).rejects.toThrow();
    await expect(lstat(`${w.homePath('codex')}/sub`)).rejects.toThrow();
  });

  test('6: an existing leaf (a file, a link, a folder) is refused and left as it was', async () => {
    const w = await world();
    const credential = await mint(w);
    const home = w.homeOf(w.codex);
    await mkdir(w.homePath('codex'), { recursive: true, mode: 0o700 });
    await writeFile(`${w.homePath('codex')}/auth.json`, 'stale');
    expect(await refusalOf(home.linkCredential(credential, resolved(home, 'auth.json')))).toBe('root:outside');
    expect(await readFile(`${w.homePath('codex')}/auth.json`, 'utf8')).toBe('stale');
    await rm(`${w.homePath('codex')}/auth.json`);
    await symlink(`${w.parent}/elsewhere`, `${w.homePath('codex')}/auth.json`);
    expect(await refusalOf(home.linkCredential(credential, resolved(home, 'auth.json')))).toBe('root:outside');
    expect(await readlink(`${w.homePath('codex')}/auth.json`)).toBe(`${w.parent}/elsewhere`);
  });

  test('a home that is itself a link is refused, and nothing is written through it', async () => {
    const w = await world();
    const credential = await mint(w);
    await mkdir(`${w.parent}/elsewhere`);
    await symlink(`${w.parent}/elsewhere`, w.homePath('codex'));
    const home = w.homeOf(w.codex);
    expect(await refusalOf(home.linkCredential(credential, resolved(home, 'auth.json')))).toStartWith('root:');
    await expect(lstat(`${w.parent}/elsewhere/auth.json`)).rejects.toThrow();
  });

  test('7: the happy path makes one symlink to the canonical file, which no plugin can read through', async () => {
    const w = await world();
    const credential = await mint(w);
    const home = w.homeOf(w.codex);
    await home.linkCredential(credential, resolved(home, 'auth.json'));
    const at = `${w.homePath('codex')}/auth.json`;
    expect((await lstat(at)).isSymbolicLink()).toBe(true);
    expect(await readlink(at)).toBe(w.canonical);
    // the OS (the harness child) reads the sign-in through it...
    expect(await readFile(at, 'utf8')).toBe('{"fake":"tokens"}\n');
    // ...no plugin does: the link resolves outside agent-homes
    const path = resolved(home, 'auth.json');
    expect(await refusalOf(home.readText(path))).toBe('root:link_escape');
    expect(await refusalOf(home.readBytes(path))).toBe('root:link_escape');
    expect(await refusalOf(home.stat(path))).toBe('root:link_escape');
  });

  test('7: unlink removes only the link, and removing the whole home leaves the canonical file byte-identical', async () => {
    const w = await world();
    const home = w.homeOf(w.codex);
    const before = await stat(w.canonical);
    await home.linkCredential(await mint(w), resolved(home, 'auth.json'));
    await home.unlink(resolved(home, 'auth.json'));
    await expect(lstat(`${w.homePath('codex')}/auth.json`)).rejects.toThrow();
    expect(await readFile(w.canonical, 'utf8')).toBe('{"fake":"tokens"}\n');
    // a fresh mint links again, then the whole ferret home goes
    await home.linkCredential(await mint(w), resolved(home, 'auth.json'));
    const all = w.codex.root('agent-homes');
    await all.remove(resolved(all, 'f1'));
    await expect(lstat(w.homePath('codex'))).rejects.toThrow();
    expect(await readFile(w.canonical, 'utf8')).toBe('{"fake":"tokens"}\n');
    const after = await stat(w.canonical);
    expect([after.ino, after.nlink, after.mode]).toEqual([before.ino, before.nlink, before.mode]);
  });

  test('7: the home’s other files and folders are made by the receiver as ever, beside the link', async () => {
    const w = await world();
    const home = w.homeOf(w.codex);
    await home.writeText(resolved(home, 'config.toml'), 'x = 1\n');
    await home.linkCredential(await mint(w), resolved(home, 'auth.json'));
    expect(await readFile(`${w.homePath('codex')}/config.toml`, 'utf8')).toBe('x = 1\n');
    expect((await lstat(`${w.homePath('codex')}/auth.json`)).isSymbolicLink()).toBe(true);
  });
});

describe('the file must still be the one minted', () => {
  test('8: replaced by a rename between mint and link, it is refused changed and nothing is linked', async () => {
    const w = await world();
    const credential = await mint(w);
    await writeFile(`${w.canonical}.new`, '{"fake":"new"}\n', { mode: 0o600 });
    await rename(`${w.canonical}.new`, w.canonical);
    const home = w.homeOf(w.codex);
    expect(await refusalOf(home.linkCredential(credential, resolved(home, 'auth.json')))).toBe('root:changed');
    await expect(lstat(`${w.homePath('codex')}/auth.json`)).rejects.toThrow();
    // the next launch mints afresh and links
    await home.linkCredential(await mint(w), resolved(home, 'auth.json'));
    expect(await readFile(`${w.homePath('codex')}/auth.json`, 'utf8')).toBe('{"fake":"new"}\n');
  });

  test('8: rewritten in place (Codex’s refresh) keeps the identity, so the link is still made', async () => {
    const w = await world();
    const credential = await mint(w);
    await writeFile(w.canonical, '{"fake":"rotated"}\n');
    const home = w.homeOf(w.codex);
    await home.linkCredential(credential, resolved(home, 'auth.json'));
    expect(await readFile(`${w.homePath('codex')}/auth.json`, 'utf8')).toBe('{"fake":"rotated"}\n');
  });

  test('8: removed, swapped for a link, or given a second name after the mint, it is refused changed', async () => {
    const w = await world();
    const home = w.homeOf(w.codex);
    const gone = await mint(w);
    await rm(w.canonical);
    expect(await refusalOf(home.linkCredential(gone, resolved(home, 'auth.json')))).toBe('root:changed');
    await writeFile(w.canonical, '{"fake":"tokens"}\n', { mode: 0o600 });
    const twice = await mint(w);
    await link(w.canonical, `${w.parent}/second-name`);
    expect(await refusalOf(home.linkCredential(twice, resolved(home, 'auth.json')))).toBe('root:changed');
    await rm(`${w.parent}/second-name`);
    const swapped = await mint(w);
    await rm(w.canonical);
    await writeFile(`${w.parent}/target.json`, '{}');
    await symlink(`${w.parent}/target.json`, w.canonical);
    expect(await refusalOf(home.linkCredential(swapped, resolved(home, 'auth.json')))).toBe('root:changed');
    await expect(lstat(`${w.homePath('codex')}/auth.json`)).rejects.toThrow();
  });
});

describe('9: the fence is not widened', () => {
  test('linkTo and copyShared toward credentials/<id>/auth.json are still refused, and share of credentials/* is still not_own', async () => {
    const w = await world();
    const creds = w.logins.root('credentials');
    const agent = w.codex.root('agent-homes', { subfolder: 'f1' });
    const target = { root: creds, path: resolved(creds, 'work/auth.json') };
    // the receiver (or any plugin) cannot link the sign-in file through `linkTo`: the target handle is not its own
    expect(await refusalOf(agent.linkTo(resolved(agent, 'auth.json'), target))).toBe('root:not_declared');
    await expect(lstat(`${w.homePath('codex')}/auth.json`)).rejects.toThrow();
    // and no plugin but the owner can hold the credentials root at all
    expect(() => w.port('codex', ['credentials']).root('credentials')).toThrow();
    // a copy of the credentials folder as a shared tree is not shareable
    const sharing = w.port('logins', ['credentials'], { shareCredentials: ['auth.json'] });
    expect(await refusalOf(sharing.share({ state: CREDENTIALS, name: 'work' }))).toBe('not_permitted');
    const trees = rootsPortFor(
      fs,
      { home: w.home, plugin: 'logins', worktrees: `${w.home}-worktrees` },
      ['credentials'],
      () => undefined,
      { shareTrees: true, stateFiles: [CREDENTIALS], privateFiles: PRIVATE },
    );
    expect(await refusalOf(trees.share({ state: CREDENTIALS, name: 'work' }))).toBe('not_own');
    // a shared credential gives the receiver no copyTree/copyShared door either: only the one link
    const credential = await mint(w);
    const home = w.homeOf(w.codex);
    expect(await refusalOf(home.copyShared(credential as never, resolved(home, 'copied')))).toBe('not_shared');
  });
});
