/**
 * The folder explorer over the kernel's REAL `imports` root on a temp disk (never a real home): a fake user home with a
 * link out of it, a private folder, a repository, and Ferretry's own home beside it. Folders are held open and made in
 * through the kernel's real pinning and spawn, so a name swapped for a link mid-operation is exercised for real (Linux).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, type KernelPorts, type SpawnPort } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../../../core/kernel/host/adapters/pinned/index.ts';
import { restrictSpawn } from '../../../../../core/kernel/host/permissions.ts';
import { PinRegistry } from '../../../../../core/kernel/host/pins.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { kernelBrowser } from '../../../daemon/features/folders/adapter.ts';
import { FolderExplorer } from '../../../daemon/features/folders/browse.ts';
import type { FolderBrowser, HeldFolder } from '../../../daemon/features/folders/port.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** A host's `mkdir`/`rmdir`, started in a held folder the way the kernel does (the pin's alias is the cwd). */
const hostSpawn: SpawnPort = {
  run: async (program, args, options) => {
    const child = Bun.spawn([program, ...args], {
      cwd: options?.cwd as string | undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, signal: null, stdout, stderr };
  },
  runBytes: async () => {
    throw new Error('not used');
  },
  start: () => {
    throw new Error('not used');
  },
};

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
    join(user, 'secrets-here', 'sub'),
    join(ferretryHome, 'state'),
    join(outside, 'deep'),
  ])
    await mkdir(folder, { recursive: true });
  await writeFile(join(user, '.ssh', 'id_work_ed25519'), 'PRIVATE');
  await writeFile(join(user, '.config', 'gh', 'hosts.yml'), 'oauth_token: x');
  await writeFile(join(user, 'secrets-here', 'auth.json'), '{}');
  await writeFile(join(user, 'notes.txt'), 'hi');
  await writeFile(join(user, '.bashrc'), '');
  await writeFile(join(outside, 'file.txt'), 'x');
  await symlink(outside, join(user, 'to-outside'));
  await symlink(join(outside, 'file.txt'), join(user, 'to-outside-file'));
  await symlink(join(parent, 'absent'), join(user, 'to-absent'));
  await symlink(join(user, 'code'), join(user, 'to-code'));
  await symlink(join(user, '.ssh'), join(user, 'to-ssh'));
  await symlink(join(user, 'notes.txt'), join(user, 'a-link-file'));
  const pins = new PinRegistry(() => platformRootPinner());
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: ferretryHome, plugin: 'projects', worktrees: `${ferretryHome}-w` },
    ['imports'],
    () => undefined,
    { pins },
  );
  const spawn = restrictSpawn('projects', ['mkdir', 'rmdir'], hostSpawn, undefined, pins);
  const kernel = { roots, paths: { home: () => user }, spawn } as unknown as Pick<
    KernelPorts,
    'roots' | 'paths' | 'spawn'
  >;
  const real = kernelBrowser(kernel);
  /** The explorer over a browser a test may wrap; `mayName` is the real root's fence. */
  const explorerOver = (browser: FolderBrowser = real) =>
    new FolderExplorer({
      browser,
      folders: { mayName: async path => roots.root('imports', { subfolder: path }).resolve('').ok },
    });
  return { user, parent, ferretryHome, outside, real, explorerOver, explorer: explorerOver() };
}

/** The outside-home gate of a caller who may not (a use-only remote device): it refuses. */
const deny = async () => {
  throw new ApiError(403, 'needs configure', 'grant_step_up_required');
};

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error as { status: number; code: string; message: string };
  }
  throw new Error('it answered');
};

/** A browser whose folders run `before` just before something is read or made in them (the swap under the check). */
const meddling = (
  inner: FolderBrowser,
  hooks: { afterFirstJudgment?: () => Promise<void>; beforeMake?: () => Promise<void> },
): FolderBrowser => ({
  ...inner,
  open: async (path, verdict) => {
    let first = true;
    const opened = await inner.open(path, async real => {
      const answer = await verdict(real);
      if (first) {
        first = false;
        await hooks.afterFirstJudgment?.();
      }
      return answer;
    });
    if (!opened.ok) return opened;
    const held: HeldFolder = {
      ...opened.folder,
      real: opened.folder.real,
      entries: limit => opened.folder.entries(limit),
      hasGit: name => opened.folder.hasGit(name),
      close: () => opened.folder.close(),
      makeLeaf: async (name, judge) => {
        await hooks.beforeMake?.();
        return await opened.folder.makeLeaf(name, judge);
      },
    };
    return { ok: true, folder: held };
  },
});

describe('the explorer over the real imports root', () => {
  test('lists ~ with folders first, repos marked, links, private and sign-in folders left out', async () => {
    const w = await world();
    const home = await w.explorer.list('~', false);
    expect(home.path).toBe(w.user);
    expect(home.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual([
      'folder:Documents',
      'folder:code',
      'file:notes.txt',
    ]);
    const code = await w.explorer.list('~/code', false);
    expect(code.entries.map(entry => [entry.name, entry.isRepo])).toEqual([
      ['app', true],
      ['plain', false],
    ]);
    expect(code.crumbs.map(crumb => crumb.name)).toEqual(['~', 'code']);
    const all = (await w.explorer.list('~', true)).entries.map(entry => entry.name);
    expect(all).toContain('.bashrc');
    expect(all).toContain('.config');
    for (const hiddenAway of ['.ssh', 'secrets-here', 'to-outside', 'to-code', 'to-ssh', 'a-link-file'])
      expect(all).not.toContain(hiddenAway);
  });

  test('refuses the private folders, a folder holding a sign-in file and everything under it, in any spelling', async () => {
    const w = await world();
    // A private NAME is refused by its spelling, before the disk is touched.
    for (const path of ['~/.ssh', '~/.SSH', '~/.s​sh', '~/.ｓｓｈ', '~/.config/gh', '~/.Config/GH'])
      expect((await failure(() => w.explorer.list(path, true))).code).toBe('private_folder');
    // A folder the DISK shows holds a sign-in is the one refusal, the same as a place that is not there.
    for (const path of ['~/secrets-here', '~/secrets-here/sub'])
      expect((await failure(() => w.explorer.list(path, true))).code).toBe('folder_refused');
    expect((await w.explorer.list('~/.config', true)).entries.map(entry => entry.name)).toEqual(['nvim']);
  });

  test('a marker in any spelling is a marker: the listed folder, a listed child, an ancestor, the write parent and the destination', async () => {
    const w = await world();
    const marked = async (folder: string, marker: string) => {
      await mkdir(join(w.user, folder), { recursive: true });
      await writeFile(join(w.user, folder, marker), '{}');
    };
    await marked('spell-listed', 'AUTH.json');
    await mkdir(join(w.user, 'spell-parent', 'child-ok'), { recursive: true });
    await marked('spell-parent/child-marked', 'ID_RSA');
    await marked('spell-ancestor', 'ｉｄ_ｅｄ25519');
    await mkdir(join(w.user, 'spell-ancestor', 'inner'), { recursive: true });
    await marked('spell-write', 'Hosts.YML');
    await mkdir(join(w.user, 'spell-dest', 'taken'), { recursive: true });
    await writeFile(join(w.user, 'spell-dest', 'taken', '.CREDENTIALS.JSON'), '{}');
    await mkdir(join(w.user, 'spell-dest', 'plain-taken'), { recursive: true });
    // The listed folder.
    expect((await failure(() => w.explorer.list('~/spell-listed', false))).code).toBe('folder_refused');
    // A listed child.
    expect((await w.explorer.list('~/spell-parent', false)).entries.map(entry => entry.name)).toEqual(['child-ok']);
    // An ancestor below the home.
    expect((await failure(() => w.explorer.list('~/spell-ancestor/inner', false))).code).toBe('folder_refused');
    // The write parent.
    expect((await failure(() => w.explorer.make({ parent: '~/spell-write', name: 'x' }))).code).toBe('folder_refused');
    expect(await readdir(join(w.user, 'spell-write'))).toEqual(['Hosts.YML']);
    // The destination: refused as the folder it is BEFORE "already there"; a plain taken name is still "already there".
    const taken = await failure(() => w.explorer.make({ parent: '~/spell-dest', name: 'taken' }));
    expect([taken.status, taken.code]).toEqual([403, 'folder_refused']);
    expect((await failure(() => w.explorer.make({ parent: '~/spell-dest', name: 'plain-taken' }))).code).toBe(
      'folder_exists',
    );
  });

  test('the sign-in look is bounded BY CONSTRUCTION: it asks for each known marker by name, so how wide a folder is decides nothing', async () => {
    const w = await world();
    // Made by the shell, not by thousands of promises: the file count is the point, and a test that allocates that much would
    // move when the garbage collector runs in the tests around it.
    const fill = async (folder: string, count: number) => {
      await mkdir(join(w.user, folder), { recursive: true });
      const made = Bun.spawn(['sh', '-c', `seq -f n%g ${count} | xargs touch`], { cwd: join(w.user, folder) });
      expect(await made.exited).toBe(0);
    };
    await fill('wide', 5001);
    await fill('wide-with-key', 5001);
    await writeFile(join(w.user, 'wide-with-key', 'id_ed25519'), 'not a key');
    // no marker seen, but the listing was cut at the bound: said as `'partial'` (a differently spelled marker is not ruled out)
    expect(await w.real.holdsSignIn(join(w.user, 'wide'))).toBe('partial');
    expect(await w.real.holdsSignIn(join(w.user, 'wide-with-key'))).toBe(true);
    // a wide ordinary folder is shown in its parent's listing; one that holds a marker is not
    const names = (await w.explorer.list('~', false)).entries.map(entry => entry.name);
    expect(names).toContain('wide');
    expect(names).not.toContain('wide-with-key');
  });

  test('a caller that fails the gate: a link out of the home, an outside path, whether or not it exists, is one answer; a dangling link is the one refusal', async () => {
    const w = await world();
    const paths = [
      '~/to-outside',
      '~/to-outside-file',
      w.outside,
      `${w.outside}/deep`,
      `${w.outside}/file.txt`,
      `${w.outside}/absent`,
      w.ferretryHome,
      '/etc',
      '/nonexistent',
    ];
    const answers = [];
    for (const path of paths) {
      const refused = await failure(() => w.explorer.list(path, false, deny));
      answers.push(`${refused.status} ${refused.code} ${refused.message}`);
    }
    expect(new Set(answers)).toEqual(new Set(['403 grant_step_up_required needs configure']));
    // A dangling link never resolves, so it never reaches the gate (GAP stated in `browse.ts`).
    expect((await failure(() => w.explorer.list('~/to-absent', false, deny))).code).toBe('folder_refused');
    // Nothing the gate refused was read: the outside folder is still whole.
    expect(await readdir(w.outside)).toEqual(['deep', 'file.txt']);
    // A link to a private folder is refused as one; a link that stays inside the home is listed by where it really is.
    expect((await failure(() => w.explorer.list('~/to-ssh', false))).code).toBe('folder_refused');
    expect((await w.explorer.list('~/to-code', false)).path).toBe(join(w.user, 'code'));
    // Inside the home a file is a file; the same link-or-path OUTSIDE it was refused above without saying what is there.
    expect((await failure(() => w.explorer.list('~/notes.txt', false))).code).toBe('not_a_folder');
  });

  test('makes one owner-only folder, never over an existing name, never in a private or outside parent', async () => {
    const w = await world();
    expect(await w.explorer.make({ parent: '~/code', name: 'fresh' })).toEqual({ path: join(w.user, 'code', 'fresh') });
    expect((await stat(join(w.user, 'code', 'fresh'))).mode & 0o777).toBe(0o700);
    expect((await failure(() => w.explorer.make({ parent: '~/code', name: 'fresh' }))).code).toBe('folder_exists');
    expect((await failure(() => w.explorer.make({ parent: '~', name: 'a-link-file' }))).code).toBe('folder_exists');
    expect((await failure(() => w.explorer.make({ parent: '~', name: 'to-outside' }))).code).toBe('folder_exists');
    expect((await failure(() => w.explorer.make({ parent: '~/.ssh', name: 'x' }))).code).toBe('private_folder');
    expect((await failure(() => w.explorer.make({ parent: '~/secrets-here/sub', name: 'x' }))).code).toBe(
      'folder_refused',
    );
    expect((await failure(() => w.explorer.make({ parent: '~/.config', name: 'GH' }))).code).toBe('private_folder');
    expect((await failure(() => w.explorer.make({ parent: '~/to-outside', name: 'x' }))).code).toBe('folder_refused');
    expect((await failure(() => w.explorer.make({ parent: w.outside, name: 'x' }))).code).toBe('folder_refused');
    expect(await readdir(w.outside)).toEqual(['deep', 'file.txt']);
    expect(await readdir(join(w.user, '.ssh'))).toEqual(['id_work_ed25519']);
  });

  test('a folder swapped for a link to outside AFTER it was checked is refused and nothing is read from there', async () => {
    const w = await world();
    const folder = join(w.user, 'Documents');
    const racing = w.explorerOver(
      meddling(w.real, {
        afterFirstJudgment: async () => {
          await rename(folder, `${folder}-moved`);
          await symlink(w.outside, folder);
        },
      }),
    );
    // For a caller that fails the gate the swap is the gate's refusal; for the owner at the machine it is a listing of the outside folder only because the policy allows it.
    expect((await failure(() => racing.list('~/Documents', false, deny))).code).toBe('grant_step_up_required');
  });

  test('a folder swapped for a link to an outside file, or for nothing, after the check is the one refusal, never "not a folder"', async () => {
    const w = await world();
    const folder = join(w.user, 'Documents');
    const asFile = w.explorerOver(
      meddling(w.real, {
        afterFirstJudgment: async () => {
          await rename(folder, `${folder}-moved`);
          await symlink(join(w.outside, 'file.txt'), folder);
        },
      }),
    );
    expect((await failure(() => asFile.list('~/Documents', false, deny))).code).toBe('folder_refused');
    const gone = w.explorerOver(
      meddling(w.real, {
        afterFirstJudgment: async () => {
          await rm(join(w.user, 'code', 'plain'), { recursive: true });
        },
      }),
    );
    expect((await failure(() => gone.list('~/code/plain', false))).code).toBe('folder_refused');
    // Verified first (a file inside the home), it is said to be a file.
    expect((await failure(() => w.explorer.list('~/notes.txt', false))).code).toBe('not_a_folder');
  });

  test('a folder swapped for a link into a private folder after the check is refused', async () => {
    const w = await world();
    const folder = join(w.user, 'Documents');
    const racing = w.explorerOver(
      meddling(w.real, {
        afterFirstJudgment: async () => {
          await rename(folder, `${folder}-moved`);
          await symlink(join(w.user, '.ssh'), folder);
        },
      }),
    );
    expect((await failure(() => racing.list('~/Documents', true))).code).toBe('folder_refused');
  });

  test('the parent swapped for a link after it was checked: the folder is made in the folder that was held, never outside', async () => {
    const w = await world();
    const parent = join(w.user, 'code');
    const racing = w.explorerOver(
      meddling(w.real, {
        beforeMake: async () => {
          await rename(parent, `${parent}-moved`);
          await symlink(join(w.user, '.ssh'), parent);
        },
      }),
    );
    // What was made went into the held folder (now `code-moved`); the path no longer reaches it, so it is taken back.
    const refused = await failure(() => racing.make({ parent: '~/code', name: 'x' }));
    expect(refused.status).toBe(403);
    expect(await readdir(join(w.user, '.ssh'))).toEqual(['id_work_ed25519']);
    expect(await readdir(`${parent}-moved`)).not.toContain('x');
  });

  test('the new folder swapped for a link at the moment it is made is taken back, and nothing outside is touched', async () => {
    const w = await world();
    const parent = join(w.user, 'code');
    const racing = w.explorerOver(
      meddling(w.real, {
        beforeMake: async () => {
          // The held folder is renamed away and a link to outside put in its place before the mkdir lands.
          await rename(parent, `${parent}-moved`);
          await symlink(w.outside, parent);
        },
      }),
    );
    const refused = await failure(() => racing.make({ parent: '~/code', name: 'y' }));
    expect(refused.status).toBe(403);
    expect(await readdir(w.outside)).toEqual(['deep', 'file.txt']);
  });

  test('a private folder kept elsewhere in the home and linked from its usual name is private at both names (stow style)', async () => {
    const w = await world();
    // The keys are named like nothing the marker list knows: only where the folder REALLY is says it is private.
    await mkdir(join(w.user, 'dotfiles', 'gnupg', 'private-keys-v1.d'), { recursive: true });
    await mkdir(join(w.user, 'dotfiles', 'aws'), { recursive: true });
    await writeFile(join(w.user, 'dotfiles', 'aws', 'credentials'), '[default]');
    await mkdir(join(w.user, 'dotfiles', 'ssh'), { recursive: true });
    await writeFile(join(w.user, 'dotfiles', 'ssh', 'id_work_ed25519'), 'PRIVATE');
    await mkdir(join(w.user, 'dotfiles', 'plain'), { recursive: true });
    await rm(join(w.user, '.ssh'), { recursive: true });
    await symlink(join(w.user, 'dotfiles', 'gnupg'), join(w.user, '.gnupg'));
    await symlink(join(w.user, 'dotfiles', 'aws'), join(w.user, '.aws'));
    await symlink(join(w.user, 'dotfiles', 'ssh'), join(w.user, '.ssh'));
    for (const path of ['~/dotfiles/gnupg', '~/dotfiles/gnupg/private-keys-v1.d', '~/dotfiles/aws', '~/dotfiles/ssh'])
      expect((await failure(() => w.explorer.list(path, true))).code).toBe('folder_refused');
    for (const parent of ['~/dotfiles/gnupg', '~/dotfiles/gnupg/private-keys-v1.d', '~/dotfiles/aws', '~/dotfiles/ssh'])
      expect((await failure(() => w.explorer.make({ parent, name: 'x' }))).code).toBe('folder_refused');
    // The usual names are still refused by name, and a destination that is one of them is refused, not "taken".
    expect((await failure(() => w.explorer.list('~/.gnupg', true))).code).toBe('private_folder');
    for (const name of ['gnupg', 'aws', 'ssh'])
      expect((await failure(() => w.explorer.make({ parent: '~/dotfiles', name }))).code).toBe('folder_refused');
    // Nothing was made, and the dotfiles folder lists without naming them.
    expect(await readdir(join(w.user, 'dotfiles', 'gnupg'))).toEqual(['private-keys-v1.d']);
    expect(await readdir(join(w.user, 'dotfiles', 'aws'))).toEqual(['credentials']);
    expect(await readdir(join(w.user, 'dotfiles', 'ssh'))).toEqual(['id_work_ed25519']);
    expect((await w.explorer.list('~/dotfiles', true)).entries.map(entry => entry.name)).toEqual(['plain']);
    expect((await w.explorer.make({ parent: '~/dotfiles/plain', name: 'ok' })).path).toBe(
      join(w.user, 'dotfiles', 'plain', 'ok'),
    );
  });

  test('a place that exists and one that does not answer alike when the disk says no (list and write parent)', async () => {
    const w = await world();
    const answer = async (run: () => Promise<unknown>) => {
      const error = await failure(run);
      return `${error.status} ${error.code} ${error.message}`;
    };
    const pairs: [string, string][] = [
      ['~/secrets-here/sub', '~/secrets-here/not-there'],
      ['~/to-ssh', '~/to-missing'],
      ['~/to-ssh/id_work_ed25519', '~/to-ssh/guess'],
    ];
    for (const [present, absent] of pairs) {
      expect(await answer(() => w.explorer.list(present, false))).toBe(
        await answer(() => w.explorer.list(absent, false)),
      );
      expect(await answer(() => w.explorer.make({ parent: present, name: 'x' }))).toBe(
        await answer(() => w.explorer.make({ parent: absent, name: 'x' })),
      );
    }
    expect(await readdir(join(w.user, '.ssh'))).toEqual(['id_work_ed25519']);
  });

  test('a destination that is a link to an outside folder is "already there" without the link being followed', async () => {
    const w = await world();
    // The outside folder holds a sign-in marker: following the link would have answered 403, not 409.
    await writeFile(join(w.outside, 'deep', 'auth.json'), '{}');
    await symlink(join(w.outside, 'deep'), join(w.user, 'to-marked-outside'));
    const taken = await failure(() => w.explorer.make({ parent: '~', name: 'to-marked-outside' }));
    const plain = await failure(() => w.explorer.make({ parent: '~', name: 'to-outside' }));
    expect([taken.status, taken.code]).toEqual([409, 'folder_exists']);
    expect([plain.status, plain.code]).toEqual([409, 'folder_exists']);
    expect(await readdir(join(w.outside, 'deep'))).toEqual(['auth.json']);
  });
});
