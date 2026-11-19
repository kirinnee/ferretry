/**
 * The folder explorer over the kernel's REAL `imports` root on a temp disk (never a real home): a fake user home with a
 * link out of it, a private folder, a repository, and Ferretry's own home beside it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { kernelBrowser } from '../../../daemon/features/folders/adapter.ts';
import { FolderExplorer } from '../../../daemon/features/folders/browse.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-folders-`));
  parents.push(parent);
  const user = join(parent, 'user');
  const ferretryHome = join(parent, 'fy-home');
  const outside = join(parent, 'outside');
  for (const folder of [
    join(user, 'code', 'app', '.git'),
    join(user, 'code', 'plain'),
    join(user, 'Documents'),
    join(user, '.ssh'),
    join(user, '.config', 'gh'),
    join(user, '.config', 'nvim'),
    join(user, 'secrets-here'),
    join(ferretryHome, 'state'),
    join(outside, 'deep'),
  ])
    await mkdir(folder, { recursive: true });
  await writeFile(join(user, '.ssh', 'id_work_ed25519'), 'PRIVATE');
  await writeFile(join(user, '.config', 'gh', 'hosts.yml'), 'oauth_token: x');
  await writeFile(join(user, 'secrets-here', 'auth.json'), '{}');
  await writeFile(join(user, 'notes.txt'), 'hi');
  await writeFile(join(user, '.bashrc'), '');
  await symlink(outside, join(user, 'to-outside'));
  await symlink(join(user, 'code'), join(user, 'to-code'));
  await symlink(join(user, '.ssh'), join(user, 'to-ssh'));
  await symlink(join(user, 'notes.txt'), join(user, 'a-link-file'));
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: ferretryHome, plugin: 'projects', worktrees: `${ferretryHome}-w` },
    ['imports'],
    () => undefined,
  );
  const kernel = { roots, paths: { home: () => user } } as unknown as Pick<KernelPorts, 'roots' | 'paths'>;
  const made: string[] = [];
  const explorer = new FolderExplorer({
    browser: kernelBrowser(kernel),
    folders: {
      mayName: async path => roots.root('imports', { subfolder: path }).resolve('').ok,
      makeDirectory: async path => {
        made.push(path);
        await mkdir(path, { mode: 0o700 });
      },
    },
  });
  return { user, ferretryHome, outside, explorer, made };
}

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error as { status: number; code: string };
  }
  throw new Error('it answered');
};

describe('the explorer over the real imports root', () => {
  test('lists ~ with folders first, repos marked, links and private folders left out', async () => {
    const w = await world();
    const home = await w.explorer.list('~', false);
    expect(home.path).toBe(w.user);
    expect(home.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual(
      ['folder:Documents', 'folder:code', 'folder:secrets-here', 'file:notes.txt'].sort((a, b) =>
        a.startsWith('folder') === b.startsWith('folder') ? 0 : a.startsWith('folder') ? -1 : 1,
      ),
    );
    const code = await w.explorer.list('~/code', false);
    expect(code.entries.map(entry => [entry.name, entry.isRepo])).toEqual([
      ['app', true],
      ['plain', false],
    ]);
    expect(code.crumbs.map(crumb => crumb.name)).toEqual(['~', 'code']);
    const all = (await w.explorer.list('~', true)).entries.map(entry => entry.name);
    expect(all).toContain('.bashrc');
    expect(all).toContain('.config');
    for (const hiddenAway of ['.ssh', 'to-outside', 'to-code', 'to-ssh', 'a-link-file'])
      expect(all).not.toContain(hiddenAway);
  });

  test('refuses the private folders, a folder holding a sign-in file, and gh below .config', async () => {
    const w = await world();
    expect((await failure(() => w.explorer.list('~/.ssh', true))).code).toBe('private_folder');
    expect((await failure(() => w.explorer.list('~/.config/gh', true))).code).toBe('private_folder');
    expect((await failure(() => w.explorer.list('~/secrets-here', true))).code).toBe('private_folder');
    expect((await w.explorer.list('~/.config', true)).entries.map(entry => entry.name)).toEqual(['nvim']);
  });

  test('a link out of the home is refused where it lands; a link to a private folder is too', async () => {
    const w = await world();
    expect((await failure(() => w.explorer.list('~/to-outside', false))).code).toBe('outside_home');
    expect((await failure(() => w.explorer.list('~/to-ssh', false))).code).toBe('private_folder');
    expect((await failure(() => w.explorer.list(`${w.outside}/deep`, false))).code).toBe('outside_home');
    // A link that stays inside the home is fine and is listed by where it really is.
    expect((await w.explorer.list('~/to-code', false)).path).toBe(join(w.user, 'code'));
  });

  test('Ferretry’s own home, a file, and a missing folder are refused', async () => {
    const w = await world();
    expect((await failure(() => w.explorer.list(w.ferretryHome, false))).status).toBe(403);
    expect((await failure(() => w.explorer.list('~/notes.txt', false))).status).toBe(422);
    // The real root cannot tell a missing folder from a refused one, so neither says which.
    expect((await failure(() => w.explorer.list('~/absent', false))).code).toBe('folder_refused');
  });

  test('makes one owner-only folder, never over an existing name, never in a private or outside parent', async () => {
    const w = await world();
    expect(await w.explorer.make({ parent: '~/code', name: 'fresh' })).toEqual({ path: join(w.user, 'code', 'fresh') });
    expect((await stat(join(w.user, 'code', 'fresh'))).mode & 0o777).toBe(0o700);
    expect((await failure(() => w.explorer.make({ parent: '~/code', name: 'fresh' }))).code).toBe('folder_exists');
    expect((await failure(() => w.explorer.make({ parent: '~', name: 'a-link-file' }))).code).toBe('folder_exists');
    expect((await failure(() => w.explorer.make({ parent: '~/.ssh', name: 'x' }))).code).toBe('private_folder');
    expect((await failure(() => w.explorer.make({ parent: '~/to-outside', name: 'x' }))).code).toBe('outside_home');
    expect(w.made).toEqual([join(w.user, 'code', 'fresh')]);
  });
});
