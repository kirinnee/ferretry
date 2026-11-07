import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { PinnedRoot, PinOptions, SessionRootPinner } from '../../../contract/pinned.ts';
import { platformRootPinner } from '../../../host/adapters/pinned/index.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { PinRegistry } from '../../../host/pins.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { fenceOf, PINNED_KEY_PATHS } from '../../../host/fence-guard.ts';

/**
 * A ferret working in `~`: the pinned `work` root is an ANCESTOR of the state home. The root itself is outside the
 * fence, so the pin's own check passes, and the descriptor walk beneath it knows nothing of the home — every op the
 * pin hands out is judged against the fence again, as each op of an owner's root is (S40, S47).
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const SECRET = 'protected-fixture';
const fs = nodeFs(() => 'r');

/** `<parent>` is the work root; the state home is `<parent>/.ferretry` and a sibling file lives beside it. */
async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-pin-fence-`));
  parents.push(parent);
  const home = `${parent}/.ferretry`;
  await mkdir(`${home}/state/vault`, { recursive: true });
  await writeFile(`${home}/state/vault/vault.key`, SECRET);
  await writeFile(`${parent}/sibling.txt`, 'sibling-bytes');
  await mkdir(`${parent}/project`);
  await writeFile(`${parent}/project/a.ts`, 'project-bytes');
  return { parent, home };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

async function pinOf(
  home: string,
  work: string,
  pinner: SessionRootPinner = platformRootPinner(),
  options?: PinOptions,
) {
  const roots = rootsPortFor(
    fs,
    { home, plugin: 'ferrets', worktrees: `${home}-worktrees` },
    ['work'],
    () => workFolders(work),
    { pins: new PinRegistry(() => pinner) },
  );
  const root = roots.root('work', { ferret: 'F1' as FerretId });
  const resolved = root.resolve('.');
  if (!resolved.ok) throw new Error(resolved.error);
  return await root.pin(resolved.value, options);
}

/** What an op through the pin came to: its text, or the refusal it threw. */
async function outcome(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
}

const read = (pinned: PinnedRoot, rel: string) => async (): Promise<string> => {
  const target = await pinned.open(rel);
  try {
    return new TextDecoder().decode(await target.read(1024));
  } finally {
    await target.close();
  }
};

const listing = (pinned: PinnedRoot, rel: string) => async (): Promise<string> => {
  const target = await pinned.open(rel, { wantDirectory: true });
  try {
    return (await target.list(100)).entries.map(entry => entry.name).join(',');
  } finally {
    await target.close();
  }
};

describe('S40 S47 a pinned work root that is an ancestor of the state home', () => {
  test('S40 S47 a file inside the home is refused through the pin, and a sibling file is served', async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent);
    try {
      expect(await outcome(read(pinned, '.ferretry/state/vault/vault.key'))).toBe('refused:fenced');
      expect(await outcome(read(pinned, 'sibling.txt'))).toBe('sibling-bytes');
      expect(await outcome(read(pinned, 'project/a.ts'))).toBe('project-bytes');
    } finally {
      await pinned.close();
    }
  });

  test('S40 S47 the walk refuses to descend into the home: no listing of it or beneath it, a listing beside it is served', async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent);
    try {
      for (const rel of [
        '.ferretry',
        '.ferretry/state',
        '.ferretry/state/vault',
        '.ferretry/./state',
        'project/../.ferretry',
      ])
        expect(await outcome(listing(pinned, rel))).toBe('refused:fenced');
      expect(await outcome(listing(pinned, 'project'))).toBe('a.ts');
      expect((await outcome(listing(pinned, ''))).split(',').sort()).toEqual(['.ferretry', 'project', 'sibling.txt']);
    } finally {
      await pinned.close();
    }
  });

  test('S40 S47 the probe calls a name inside the home unsupported without walking it, and keeps the others in order', async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent);
    const probe = pinned.probe();
    try {
      expect(
        await probe.classify(['sibling.txt', '.ferretry/state/vault/vault.key', 'project/a.ts', 'missing.txt']),
      ).toEqual(['file', 'unsupported', 'file', 'unsupported']);
    } finally {
      await probe.close();
      await pinned.close();
    }
  });

  test('S40 S47 a home file hard-linked into the work folder is refused as hard_link', async () => {
    const { parent, home } = await layout();
    await link(`${home}/state/vault/vault.key`, `${parent}/planted`);
    const pinned = await pinOf(home, parent);
    try {
      expect(await outcome(read(pinned, 'planted'))).toBe('refused:hard_link');
      expect(await outcome(read(pinned, 'sibling.txt'))).toBe('sibling-bytes');
    } finally {
      await pinned.close();
    }
  });

  test('S40 S47 a component that IS the home by device and inode is refused though its name is innocent', async () => {
    const { parent, home } = await layout();
    const homeIdentity = await fs.identity(home);
    if (homeIdentity === undefined) throw new Error('the fixture home has no identity');
    // A walk that reached the home by another name (a bind mount, a case-insensitive spelling): only identity can tell.
    const real = platformRootPinner();
    const aliasing: SessionRootPinner = {
      pin: async (cwd, options) => {
        const held = await real.pin(cwd, options);
        return {
          rootReal: held.rootReal,
          policyCwd: held.policyCwd,
          probe: () => held.probe(),
          close: () => held.close(),
          open: async (rel, openOptions) => {
            const target = await held.open(rel, openOptions);
            return {
              metadata: target.metadata,
              canonical: target.canonical,
              identities: [
                ...target.identities,
                { dev: homeIdentity.device, ino: homeIdentity.inode, ctimeNs: 0n, mode: homeIdentity.mode },
              ],
              read: max => target.read(max),
              list: (max, budget) => target.list(max, budget),
              close: () => target.close(),
            };
          },
        };
      },
    };
    const pinned = await pinOf(home, parent, aliasing);
    try {
      expect(await outcome(read(pinned, 'sibling.txt'))).toBe('refused:fenced');
    } finally {
      await pinned.close();
    }
  });
});

/** A pinner whose walk reports the home's identity on every folder it opens at `aliased` (a bind mount of the home). */
function aliasingPinner(
  aliased: string,
  home: { readonly device: bigint; readonly inode: bigint; readonly mode: number },
) {
  const real = platformRootPinner();
  const pinner: SessionRootPinner = {
    pin: async (cwd, options) => {
      const held = await real.pin(cwd, options);
      return {
        rootReal: held.rootReal,
        policyCwd: held.policyCwd,
        probe: () => held.probe(),
        close: () => held.close(),
        open: async (rel, openOptions) => {
          const target = await held.open(rel, openOptions);
          const alias = rel === aliased || rel.startsWith(`${aliased}/`);
          return {
            metadata: target.metadata,
            canonical: target.canonical,
            identities: alias
              ? [...target.identities, { dev: home.device, ino: home.inode, ctimeNs: 0n, mode: home.mode }]
              : target.identities,
            read: max => target.read(max),
            list: (max, budget) => target.list(max, budget),
            close: () => target.close(),
          };
        },
      };
    },
  };
  return pinner;
}

describe('S47 the pin is caller-scoped: an agent is fenced, a person is not', () => {
  test('S47 a pin that names no caller is fenced, as an agent pin is (fail safe)', async () => {
    const { parent, home } = await layout();
    for (const options of [undefined, { fence: 'agent' as const }]) {
      const pinned = await pinOf(home, parent, platformRootPinner(), options);
      try {
        expect(await outcome(read(pinned, '.ferretry/state/vault/vault.key'))).toBe('refused:fenced');
        expect(await outcome(listing(pinned, '.ferretry'))).toBe('refused:fenced');
      } finally {
        await pinned.close();
      }
    }
  });

  test("S47 a person's pin reads inside the home and a hard-linked file as today, and lists the home", async () => {
    const { parent, home } = await layout();
    await link(`${home}/state/vault/vault.key`, `${parent}/planted`);
    const pinned = await pinOf(home, parent, platformRootPinner(), { fence: 'none' });
    const probe = pinned.probe();
    try {
      expect(await outcome(read(pinned, '.ferretry/state/vault/vault.key'))).toBe(SECRET);
      expect(await outcome(read(pinned, 'planted'))).toBe(SECRET);
      expect(await outcome(listing(pinned, '.ferretry'))).toBe('state');
      expect(await probe.classify(['.ferretry/state/vault/vault.key', 'sibling.txt'])).toEqual(['file', 'file']);
    } finally {
      await probe.close();
      await pinned.close();
    }
  });

  test('S47 the root itself is still refused for a person when it is inside the home', async () => {
    const { home } = await layout();
    expect(
      await outcome(async () => {
        await (await pinOf(home, `${home}/state`, platformRootPinner(), { fence: 'none' })).close();
        return 'pinned';
      }),
      // The root's own check (§7.7) refuses it before the pin: the lexical half names it, the held object is judged again.
    ).toMatch(/fenced$/);
  });
});

describe('S47 the held root answers a name verdict for output the walk never sees', () => {
  test('S47 a name inside the home is fenced by name, present or not; one beside it is not', async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent);
    try {
      expect(
        await pinned.fenced([
          '.ferretry',
          '.ferretry/state/vault/vault.key',
          '.ferretry/never-made.txt',
          '.ferretry-before-2026-01-01-0000/x',
          'sibling.txt',
          'project/a.ts',
          'project/deleted.ts',
          'gone/deeper/still.ts',
          '',
        ]),
      ).toEqual([true, true, true, true, false, false, false, false, false]);
    } finally {
      await pinned.close();
    }
  });

  test("S47 the verdict answers the same for a person's pin, which the walk does not fence", async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent, platformRootPinner(), { fence: 'none' });
    try {
      expect(await pinned.fenced(['.ferretry/state/vault/vault.key', 'sibling.txt'])).toEqual([true, false]);
    } finally {
      await pinned.close();
    }
  });

  test('S47 a folder that IS the home by identity fences every name in it, present or not', async () => {
    const { parent, home } = await layout();
    const identity = await fs.identity(home);
    if (identity === undefined) throw new Error('the fixture home has no identity');
    const pinned = await pinOf(home, parent, aliasingPinner('project', identity));
    try {
      expect(await pinned.fenced(['project/a.ts', 'project/not-there.ts', 'sibling.txt'])).toEqual([true, true, false]);
    } finally {
      await pinned.close();
    }
  });

  test('S47 a home that cannot be identified fences every name', async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent);
    try {
      await rm(home, { recursive: true, force: true });
      expect(await pinned.fenced(['sibling.txt', 'project/a.ts'])).toEqual([true, true]);
    } finally {
      await pinned.close();
    }
  });
});

describe("S47 S40 the fence holds the home's pinned key files and folders by identity", () => {
  test("S47 the fence's identities hold each pinned key path that is there, as today's list names them", async () => {
    const { home } = await layout();
    await writeFile(`${home}/api-token`, 'fy_admin');
    await writeFile(`${home}/state/secrets.key`, 'key');
    await mkdir(`${home}/fleet/homes`, { recursive: true });
    const fence = await fenceOf(fs, home);
    for (const key of ['api-token', 'state/secrets.key', 'fleet', 'fleet/homes']) {
      const identity = await fs.identity(`${home}/${key}`);
      expect(fence.identities.some(held => held.device === identity?.device && held.inode === identity.inode)).toBe(
        true,
      );
    }
    expect(PINNED_KEY_PATHS).toEqual([
      'api-token',
      'api-warden-token',
      'tmux.sock',
      'state/secrets.key',
      'state/secrets.json',
      'state/mcp-oauth-secrets.json',
      'state/login-secrets.json',
      'state/passkeys.json',
      'state/daemon-identity.json',
      'fleet',
      'fleet/homes',
      'state/sessions',
    ]);
  });

  test('S47 a key file linked into the work folder is refused for an agent by identity (fenced, not hard_link), and fenced in the verdict and probe', async () => {
    const { parent, home } = await layout();
    await writeFile(`${home}/api-token`, 'fy_admin');
    await link(`${home}/api-token`, `${parent}/innocent.txt`);
    const pinned = await pinOf(home, parent);
    const probe = pinned.probe();
    try {
      expect(await outcome(read(pinned, 'innocent.txt'))).toBe('refused:fenced');
      expect(await pinned.fenced(['innocent.txt', 'sibling.txt'])).toEqual([true, false]);
      expect(await probe.classify(['sibling.txt'])).toEqual(['file']);
    } finally {
      await probe.close();
      await pinned.close();
    }
  });

  test("S47 the probe calls a name in a folder that IS the home by identity unsupported (today's inHome)", async () => {
    const { parent, home } = await layout();
    const identity = await fs.identity(home);
    if (identity === undefined) throw new Error('the fixture home has no identity');
    const pinned = await pinOf(home, parent, aliasingPinner('project', identity));
    const probe = pinned.probe();
    try {
      expect(await probe.classify(['project/a.ts', 'sibling.txt'])).toEqual(['unsupported', 'file']);
    } finally {
      await probe.close();
      await pinned.close();
    }
  });
});

/**
 * The home's `state` and `config` are folders of their own in today's fence (`NodeStateHomes([home, state, config])`):
 * each by its real path and its device and inode. So one linked or bind-mounted out of the home is still the home's.
 * `<parent>/home/state` and `<parent>/home/config` are links to `<parent>/elsewhere/state` and `.../config`, and the
 * work folder is `<parent>/elsewhere`.
 */
async function linkedOut() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-pin-fence-out-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const elsewhere = `${parent}/elsewhere`;
  await mkdir(home);
  await mkdir(`${elsewhere}/state`, { recursive: true });
  await mkdir(`${elsewhere}/config`);
  await mkdir(`${elsewhere}/project`);
  await writeFile(`${elsewhere}/state/grants.json`, 'GRANTS-FIXTURE');
  await writeFile(`${elsewhere}/config/daemon.json`, 'CONFIG-FIXTURE');
  await writeFile(`${elsewhere}/project/a.ts`, 'project-bytes');
  await writeFile(`${elsewhere}/notes.txt`, 'notes-bytes');
  await symlink(`${elsewhere}/state`, `${home}/state`);
  await symlink(`${elsewhere}/config`, `${home}/config`);
  return { parent, home, elsewhere };
}

describe("S40 S47 the home's state and config folders are fenced wherever they really are", () => {
  test('S40 S47 an agent reads nothing of a state or config folder linked out of the home, and the rest of its work folder is served', async () => {
    const { home, elsewhere } = await linkedOut();
    const pinned = await pinOf(home, elsewhere);
    try {
      expect(await outcome(read(pinned, 'state/grants.json'))).toBe('refused:fenced');
      expect(await outcome(read(pinned, 'config/daemon.json'))).toBe('refused:fenced');
      expect(await outcome(listing(pinned, 'state'))).toBe('refused:fenced');
      expect(await outcome(listing(pinned, 'config'))).toBe('refused:fenced');
      expect(await outcome(read(pinned, 'notes.txt'))).toBe('notes-bytes');
      expect(await outcome(read(pinned, 'project/a.ts'))).toBe('project-bytes');
    } finally {
      await pinned.close();
    }
  });

  test('S40 S47 the verdict and the probe fence a name in a state or config folder linked out of the home, present or not', async () => {
    const { home, elsewhere } = await linkedOut();
    const pinned = await pinOf(home, elsewhere);
    const probe = pinned.probe();
    try {
      expect(
        await pinned.fenced([
          'state',
          'state/grants.json',
          'state/never-made.json',
          'config/daemon.json',
          'config/deeper/never-made.json',
          'notes.txt',
          'project/a.ts',
        ]),
      ).toEqual([true, true, true, true, true, false, false]);
      expect(await probe.classify(['notes.txt', 'state/grants.json', 'config/daemon.json'])).toEqual([
        'file',
        'unsupported',
        'unsupported',
      ]);
    } finally {
      await probe.close();
      await pinned.close();
    }
  });

  test('S40 S47 a work folder AT or inside the real state or config folder is refused at the pin, by name and through a link', async () => {
    const { parent, home, elsewhere } = await linkedOut();
    await mkdir(`${elsewhere}/state/work`);
    await symlink(`${elsewhere}/config`, `${parent}/via-link`);
    for (const work of [
      `${elsewhere}/state`,
      `${elsewhere}/config`,
      `${elsewhere}/state/work`,
      `${home}/state`,
      `${parent}/via-link`,
    ])
      for (const options of [undefined, { fence: 'agent' as const }, { fence: 'none' as const }])
        expect(
          await outcome(async () => {
            await (await pinOf(home, work, platformRootPinner(), options)).close();
            return 'pinned';
          }),
        ).toMatch(/fenced$/);
  });

  test('S40 S47 a folder that IS the state or config folder by device and inode fences its names though its own is innocent', async () => {
    const { home, elsewhere } = await linkedOut();
    for (const folder of ['state', 'config']) {
      const identity = await fs.identity(`${elsewhere}/${folder}`);
      if (identity === undefined) throw new Error(`the fixture ${folder} has no identity`);
      // A walk that met the folder under another name (a bind mount of it): only its device and inode tell.
      const pinned = await pinOf(home, elsewhere, aliasingPinner('project', identity));
      const probe = pinned.probe();
      try {
        expect(await outcome(read(pinned, 'project/a.ts'))).toBe('refused:fenced');
        expect(await outcome(read(pinned, 'notes.txt'))).toBe('notes-bytes');
        expect(await pinned.fenced(['project/a.ts', 'project/not-there.ts', 'notes.txt'])).toEqual([true, true, false]);
        expect(await probe.classify(['project/a.ts', 'notes.txt'])).toEqual(['unsupported', 'file']);
      } finally {
        await probe.close();
        await pinned.close();
      }
    }
  });

  test("S40 S47 a person's pin is unaffected beneath its root as today: the folders are served, the root check still applies", async () => {
    const { home, elsewhere } = await linkedOut();
    const pinned = await pinOf(home, elsewhere, platformRootPinner(), { fence: 'none' });
    try {
      expect(await outcome(read(pinned, 'state/grants.json'))).toBe('GRANTS-FIXTURE');
      expect(await outcome(read(pinned, 'config/daemon.json'))).toBe('CONFIG-FIXTURE');
      expect(await outcome(listing(pinned, 'state'))).toBe('grants.json');
      expect(await pinned.fenced(['state/grants.json', 'config/daemon.json', 'notes.txt'])).toEqual([
        true,
        true,
        false,
      ]);
    } finally {
      await pinned.close();
    }
  });

  test('S40 S47 the fence holds the real path and the device and inode of state and config, linked out of the home or in it', async () => {
    const out = await linkedOut();
    const linked = await fenceOf(fs, out.home);
    expect(linked.places).toEqual([`${out.elsewhere}/state`, `${out.elsewhere}/config`]);
    const inside = await layout();
    await mkdir(`${inside.home}/config`);
    const here = await fenceOf(fs, inside.home);
    expect(here.places).toEqual([`${inside.home}/state`, `${inside.home}/config`]);
    for (const [fence, root] of [
      [linked, out.elsewhere],
      [here, inside.home],
    ] as const)
      for (const folder of ['state', 'config']) {
        const identity = await fs.identity(`${root}/${folder}`);
        expect(fence.identities.some(held => held.device === identity?.device && held.inode === identity.inode)).toBe(
          true,
        );
      }
  });

  test('S40 S47 a state or config folder that is not there is left out, and one that is there but unreadable or not a folder fails closed', async () => {
    const { parent, home } = await layout();
    expect((await fenceOf(fs, home)).places).toEqual([`${home}/state`]);
    await symlink(`${parent}/nowhere`, `${home}/config`);
    expect((await fenceOf(fs, home)).places).toEqual([`${home}/state`]);
    // Anything but "not there" is a doubt: the fence cannot be made, so every owner's root and every name refuses.
    const denied: typeof fs = {
      ...fs,
      realpath: async path => {
        if (path === `${home}/config`) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return await fs.realpath(path);
      },
    };
    await rm(`${home}/config`);
    await mkdir(`${home}/config`);
    await expect(fenceOf(denied, home)).rejects.toThrow('denied');
    await rm(`${home}/config`, { recursive: true });
    await writeFile(`${home}/config`, 'a file');
    await expect(fenceOf(fs, home)).rejects.toThrow('cannot be identified');
    const pinned = await pinOf(home, parent).catch((error: unknown) => error);
    expect(pinned instanceof RootError ? pinned.refusal : 'pinned').toBe('fenced');
  });
});
