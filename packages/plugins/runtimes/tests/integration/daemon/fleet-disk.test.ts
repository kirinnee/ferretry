/**
 * The provisioner's disk: where a write may land (the fleet folder only), where a component may come from (the fleet's
 * assets and the harness homes only), and that a sign-in is never a source. Rows: S43, S44, S49 (a file with a second
 * name is never a source), S144.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { link, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  credentialMounts,
  FleetDisk,
  NoDescriptorReachError,
  sourceMounts,
} from '../../../daemon/adapters/fleet-disk.ts';
import type { HostMounts } from '../../../daemon/adapters/root-host-files.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

describe('FleetDisk', () => {
  it('S43 serves a source from the fleet’s assets and the harness homes, and from nowhere else', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'a.md'), 'asset');
    await writeFile(join(world.fleet, 'homes', 'one', 'b.md'), 'a runtime’s own');
    await writeFile(join(world.person, '.claude', 'CLAUDE.md'), 'mine');
    await writeFile(join(world.home, 'machine.yaml'), 'daemon');

    expect(await world.disk.readSource(join(world.fleet, 'assets', 'a.md'), 1000)).toBe('asset');
    expect(await world.disk.readSource(join(world.person, '.claude', 'CLAUDE.md'), 1000)).toBe('mine');
    for (const refused of [
      join(world.fleet, 'homes', 'one', 'b.md'),
      join(world.home, 'machine.yaml'),
      join(world.parent, 'x'),
    ]) {
      expect(() => world.disk.assertServed(refused)).toThrow(/outside the folders Runtimes may read a component from/u);
      await expect(world.disk.readSource(refused, 1000)).rejects.toThrow(/outside the folders Runtimes may read/u);
    }
  });

  it('S144 refuses a sign-in name as any component of a source, as a copy source and as a read', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.person, '.codex', 'auth.json.d'), { recursive: true });
    await writeFile(join(world.person, '.codex', 'auth.json'), 'INERT_SIGN_IN_FIXTURE');
    await mkdir(join(world.fleet, 'assets', '.credentials.json'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', '.credentials.json', 'x'), 'x');

    for (const source of [
      join(world.person, '.codex', 'auth.json'),
      join(world.fleet, 'assets', '.credentials.json', 'x'),
    ]) {
      expect(() => world.disk.assertServed(source)).toThrow(/a sign-in file/u);
      await expect(world.disk.readSource(source, 1000)).rejects.toThrow(/a sign-in file/u);
      await expect(world.disk.copyInto(source, join(world.fleet, 'homes', 'out'), 0o600)).rejects.toThrow(
        /a sign-in file/u,
      );
    }
    // A sign-in IS a link target: the credential link reads nothing.
    await world.disk.checkLinkTarget(join(world.person, '.codex', 'auth.json'), false);
  });

  it('S49 skips a source file that has a second name rather than copying it', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.person, '.claude', 'skill'), { recursive: true });
    await writeFile(join(world.person, '.claude', 'skill', 'one.md'), 'one');
    await link(join(world.person, '.claude', 'skill', 'one.md'), join(world.parent, 'elsewhere.md'));
    await writeFile(join(world.person, '.claude', 'skill', 'two.md'), 'two');

    await world.disk.copyInto(join(world.person, '.claude', 'skill'), join(world.fleet, 'copied'), 0o600);

    expect(await world.disk.lstat(join(world.fleet, 'copied', 'one.md'))).toBeUndefined();
    expect(await readFile(join(world.fleet, 'copied', 'two.md'), 'utf8')).toBe('two');
  });

  it('S44 writes only inside the fleet folder, and a link on the way is a refusal, not a redirect', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.parent, 'outside'), { recursive: true });
    await symlink(join(world.parent, 'outside'), join(world.fleet, 'trap'));

    expect(() => world.disk.fenced(join(world.fleet, '..', 'x'))).toThrow(
      /refusing to write outside configured fleet roots/u,
    );
    expect(() => world.disk.fenced(join(world.home, 'config', 'x'))).toThrow(
      /refusing to write outside configured fleet roots/u,
    );
    await expect(world.disk.create(join(world.fleet, 'trap', 'x.txt'), new Uint8Array([1]), 0o600)).rejects.toThrow();
    expect(await readdir(join(world.parent, 'outside'))).toEqual([]);
  });

  it('refuses a name that is already taken instead of replacing it', async () => {
    const world = await fleetWorld();
    await writeFile(join(world.fleet, 'taken'), 'theirs');

    await expect(world.disk.create(join(world.fleet, 'taken'), new Uint8Array([1]), 0o600)).rejects.toThrow(
      /already exists/u,
    );
    await expect(world.disk.rename(join(world.fleet, 'taken'), join(world.fleet, 'taken'))).rejects.toThrow();
    expect(await readFile(join(world.fleet, 'taken'), 'utf8')).toBe('theirs');
  });

  it('says in a sentence that a host without descriptor reach cannot move an entry aside (macOS)', async () => {
    const world = await fleetWorld();
    const root = world.roots.root('fleet');
    const refusing = new Proxy(root, {
      get(target, property, receiver) {
        if (property === 'rename') {
          return async () => {
            throw new Error('root refused: no_descriptor_reach');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const disk = new FleetDisk({ fleet: refusing, directory: world.fleet, sources: () => undefined });
    await writeFile(join(world.fleet, 'a'), 'x');

    const act = disk.rename(join(world.fleet, 'a'), join(world.fleet, 'b'));

    await expect(act).rejects.toBeInstanceOf(NoDescriptorReachError);
    await expect(act).rejects.toThrow(/cannot move .* aside safely .* rolled back/u);
    expect(await readFile(join(world.fleet, 'a'), 'utf8')).toBe('x');
  });
});

/** Inert fixture text: it stands for a stored sign-in and must never reach a destination. */
const INERT = 'INERT_SIGN_IN_FIXTURE';

/** Every file below `folder`, relative, as text (so a test can prove the fixture text landed nowhere). */
async function everyText(folder: string, prefix = ''): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await everyText(path, `${prefix}${entry.name}/`)));
    else if (entry.isFile()) found.push(`${prefix}${entry.name}=${await readFile(path, 'utf8')}`);
  }
  return found;
}

describe('FleetDisk: every hop of a source is judged (S43, S144)', () => {
  /** A fleet folder holding what a link in `assets/` must never reach: a stored sign-in and another runtime's home. */
  async function fleetWithSecrets() {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'credentials', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'credentials', 'one', 'auth.json'), INERT);
    await writeFile(join(world.fleet, 'credentials', 'one', 'api-key'), INERT);
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'homes', 'one', 'history.jsonl'), INERT);
    await mkdir(join(world.fleet, 'assets'), { recursive: true });
    return world;
  }

  it('S43 P2 refuses an assets file that is a link into the stored credentials, and copies nothing', async () => {
    const world = await fleetWithSecrets();
    await symlink(join(world.fleet, 'credentials', 'one', 'auth.json'), join(world.fleet, 'assets', 'readme.md'));
    await symlink('../credentials/one/auth.json', join(world.fleet, 'assets', 'relative.md'));

    for (const name of ['readme.md', 'relative.md']) {
      await expect(
        world.disk.copyInto(join(world.fleet, 'assets', name), join(world.fleet, 'homes', `out-${name}`), 0o600),
      ).rejects.toThrow();
      await expect(world.disk.readSource(join(world.fleet, 'assets', name), 1000)).rejects.toThrow(
        /leads out of the folder/u,
      );
    }
    expect((await everyText(world.fleet)).filter(line => line.includes(INERT) && line.includes('out-'))).toEqual([]);
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out-readme.md'))).toBeUndefined();
  });

  it('S43 P3 refuses an assets file or folder that is a link into another runtime’s home', async () => {
    const world = await fleetWithSecrets();
    await symlink('../homes/one/history.jsonl', join(world.fleet, 'assets', 'f.md'));
    await symlink('../homes/one', join(world.fleet, 'assets', 'dir'));

    for (const name of ['f.md', 'dir']) {
      await expect(
        world.disk.copyInto(join(world.fleet, 'assets', name), join(world.fleet, 'homes', `out-${name}`), 0o600),
      ).rejects.toThrow();
    }
    expect((await everyText(world.fleet)).filter(line => line.includes(INERT) && line.includes('out-'))).toEqual([]);
  });

  it('S43 P4 refuses an assets folder that is a link to the credentials folder, and a link on the way down', async () => {
    const world = await fleetWithSecrets();
    await symlink('../credentials', join(world.fleet, 'assets', 'c'));
    await symlink('..', join(world.fleet, 'assets', 'up'));

    for (const source of [
      join(world.fleet, 'assets', 'c'),
      // A link in the MIDDLE of the path: `assets/up` is the fleet folder, so this reads `homes/one/history.jsonl`.
      join(world.fleet, 'assets', 'up', 'homes', 'one', 'history.jsonl'),
      join(world.fleet, 'assets', 'up', 'credentials', 'one', 'api-key'),
    ]) {
      await expect(world.disk.copyInto(source, join(world.fleet, 'homes', 'out'), 0o600)).rejects.toThrow();
      await expect(world.disk.assertSource(source)).rejects.toThrow();
      await expect(world.disk.readSource(source, 1000)).rejects.toThrow(/leads out of the folder/u);
    }
    expect((await everyText(world.fleet)).filter(line => line.includes(INERT) && line.includes('out'))).toEqual([]);
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S43 follows a link that stays inside assets/, and judges what it reaches', async () => {
    const world = await fleetWithSecrets();
    await mkdir(join(world.fleet, 'assets', 'skills', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'skills', 'one', 'SKILL.md'), 'a skill');
    await symlink('skills/one', join(world.fleet, 'assets', 'alias'));

    await world.disk.copyInto(join(world.fleet, 'assets', 'alias'), join(world.fleet, 'homes', 'copied'), 0o700);

    expect(await readFile(join(world.fleet, 'homes', 'copied', 'SKILL.md'), 'utf8')).toBe('a skill');
  });

  it('S43 a source in assets/ that is not there yet reads as missing, not as a refusal of the fleet', async () => {
    const world = await fleetWorld();

    await expect(
      world.disk.copyInto(join(world.fleet, 'assets', 'nothing.md'), join(world.fleet, 'homes', 'out'), 0o600),
    ).rejects.toThrow(/does not exist/u);
    expect(await world.disk.readSource(join(world.fleet, 'assets', 'nothing.md'), 1000)).toBeUndefined();
  });

  it('S144 P1 refuses a file source that is a link to a sign-in, by the real path, as a copy and as a read', async () => {
    const world = await fleetWorld();
    await writeFile(join(world.person, '.claude', '.credentials.json'), INERT);
    await symlink('.credentials.json', join(world.person, '.claude', 'notes.md'));
    await mkdir(join(world.fleet, 'assets', 'x'), { recursive: true });
    await writeFile(join(world.fleet, 'assets', 'x', 'auth.json'), INERT);
    await symlink('x/auth.json', join(world.fleet, 'assets', 'plain.md'));

    for (const source of [join(world.person, '.claude', 'notes.md'), join(world.fleet, 'assets', 'plain.md')]) {
      await expect(world.disk.copyInto(source, join(world.fleet, 'homes', 'out'), 0o600)).rejects.toThrow(
        /a sign-in file/u,
      );
      await expect(world.disk.readSource(source, 1000)).rejects.toThrow(/a sign-in file/u);
      await expect(world.disk.readSourceText(source)).rejects.toThrow(/a sign-in file/u);
      await expect(world.disk.assertSource(source)).rejects.toThrow(/a sign-in file/u);
    }
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S144 refuses a folder source that is a link to a folder named like a sign-in', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.person, '.codex', 'auth.json'), { recursive: true });
    await writeFile(join(world.person, '.codex', 'auth.json', 'note.md'), 'inside a folder named like a sign-in');
    await symlink('auth.json', join(world.person, '.codex', 'friendly'));

    await expect(
      world.disk.copyInto(join(world.person, '.codex', 'friendly'), join(world.fleet, 'homes', 'out'), 0o700),
    ).rejects.toThrow(/a sign-in file/u);
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S144 M4 walks a copied folder at ANY depth for a sign-in', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.person, '.claude', 'bundle', 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(world.person, '.claude', 'bundle', 'top.md'), 'fine');
    await writeFile(join(world.person, '.claude', 'bundle', 'a', 'b', 'c', '.credentials.json'), INERT);

    await expect(
      world.disk.copyInto(join(world.person, '.claude', 'bundle'), join(world.fleet, 'homes', 'out'), 0o700),
    ).rejects.toThrow(/a sign-in file/u);
    await expect(world.disk.assertSource(join(world.person, '.claude', 'bundle'))).rejects.toThrow(/a sign-in file/u);
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S144 m2 compares a sign-in name case-folded (a case-insensitive disk opens AUTH.JSON as auth.json)', async () => {
    const world = await fleetWorld();
    await writeFile(join(world.person, '.codex', 'AUTH.JSON'), INERT);
    await writeFile(join(world.person, '.claude', '.Credentials.JSON'), INERT);
    await mkdir(join(world.person, '.claude', 'bundle'), { recursive: true });
    await writeFile(join(world.person, '.claude', 'bundle', 'Auth.Json'), INERT);

    for (const source of [
      join(world.person, '.codex', 'AUTH.JSON'),
      join(world.person, '.claude', '.Credentials.JSON'),
      join(world.person, '.claude', 'bundle'),
    ]) {
      await expect(world.disk.copyInto(source, join(world.fleet, 'homes', 'out'), 0o700)).rejects.toThrow(
        /a sign-in file/u,
      );
    }
    await expect(world.disk.readSource(join(world.person, '.codex', 'AUTH.JSON'), 1000)).rejects.toThrow(
      /a sign-in file/u,
    );
  });
});

describe('FleetDisk: a link TO the stored credential works, a copy of it never does (M1, S43, S144)', () => {
  it('M1 links a dangling credential target in the fleet’s credentials folder, reading nothing', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'credentials', 'one'), { recursive: true });
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    const target = join(world.fleet, 'credentials', 'one', 'auth.json');

    await world.disk.checkLinkTarget(target, true);
    await world.disk.linkTo(join(world.fleet, 'homes', 'one', 'auth.json'), target, true);

    expect(await readlink(join(world.fleet, 'homes', 'one', 'auth.json'))).toBe(target);
    // Once the harness has signed in THROUGH the link, the link is not a way to read it either.
    await writeFile(target, INERT);
    await expect(
      world.disk.copyInto(join(world.fleet, 'credentials', 'one', 'auth.json'), join(world.fleet, 'homes', 'c'), 0o600),
    ).rejects.toThrow();
    await expect(
      world.disk.copyInto(join(world.fleet, 'credentials', 'one'), join(world.fleet, 'homes', 'c'), 0o700),
    ).rejects.toThrow();
    expect(world.disk.isSource(target)).toBe(false);
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'c'))).toBeUndefined();
  });

  it('M1 only a DANGLING credential link may lead into the credentials folder; any other link there is refused', async () => {
    const world = await fleetWorld();
    await mkdir(join(world.fleet, 'credentials', 'one'), { recursive: true });
    await writeFile(join(world.fleet, 'credentials', 'one', 'auth.json'), INERT);
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    const target = join(world.fleet, 'credentials', 'one', 'auth.json');

    await expect(world.disk.checkLinkTarget(target, false)).rejects.toThrow(
      /outside the folders Runtimes may read a component from/u,
    );
    await expect(world.disk.linkTo(join(world.fleet, 'homes', 'one', 'a'), target, false)).rejects.toThrow(
      /outside the folders Runtimes may read a component from/u,
    );
    // Another runtime's home is no credential target either, dangling or not.
    for (const elsewhere of [join(world.fleet, 'homes', 'two', 'auth.json'), join(world.home, 'api-token')]) {
      await expect(world.disk.checkLinkTarget(elsewhere, true)).rejects.toThrow(
        /outside the folders Runtimes may read a component from/u,
      );
    }
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'one', 'a'))).toBeUndefined();
  });
});

/** A disk whose `harness-home` sources run a hook at the moments a race would strike (the root, wrapped). */
function racingDisk(
  world: FleetWorld,
  hooks: {
    readonly afterRealPath?: (count: number) => Promise<void>;
    readonly beforeRead?: () => Promise<void>;
    /** After the bytes were read, while the file is still held. */
    readonly afterRead?: () => Promise<void>;
  },
): FleetDisk {
  const inner = sourceMounts(world.roots, world.fleet, [join(world.person, '.claude'), join(world.person, '.codex')]);
  let realPaths = 0;
  const sources: HostMounts = path => {
    const mounted = inner(path);
    if (mounted === undefined || mounted.kind !== 'root') return mounted;
    const root = new Proxy(mounted.root, {
      get(target, key) {
        if (key === 'realPath') {
          return async (at: Parameters<typeof target.realPath>[0]) => {
            const answer = await target.realPath(at);
            realPaths += 1;
            await hooks.afterRealPath?.(realPaths);
            return answer;
          };
        }
        if (key === 'readDurable') {
          return async (...args: Parameters<typeof target.readDurable>) => {
            await hooks.beforeRead?.();
            const [at, limit, hold] = args;
            return await target.readDurable(at, limit, async held => {
              await hooks.afterRead?.();
              return await (hold as (read: typeof held) => Promise<unknown>)(held);
            });
          };
        }
        return Reflect.get(target, key);
      },
    });
    return { ...mounted, root };
  };
  return new FleetDisk({
    fleet: world.roots.root('fleet'),
    directory: world.fleet,
    sources,
    credentials: credentialMounts(world.roots, world.fleet),
  });
}

/** A disk whose fleet root runs a hook right before a folder copy starts (after the source was walked). */
function copyRacingDisk(world: FleetWorld, beforeCopy: () => Promise<void>): FleetDisk {
  const fleet = world.roots.root('fleet');
  const racing = new Proxy(fleet, {
    get(target, key) {
      if (key === 'copyTree') {
        return async (...args: Parameters<typeof target.copyTree>) => {
          await beforeCopy();
          return await target.copyTree(...args);
        };
      }
      return Reflect.get(target, key);
    },
  });
  return new FleetDisk({
    fleet: racing,
    directory: world.fleet,
    sources: sourceMounts(world.roots, world.fleet, [join(world.person, '.claude'), join(world.person, '.codex')]),
    credentials: credentialMounts(world.roots, world.fleet),
  });
}

/** Swaps `notes.md` of the Claude home for a link to the sign-in beside it, once, as a racing writer would. */
async function swapForSignIn(world: FleetWorld): Promise<void> {
  const notes = join(world.person, '.claude', 'notes.md');
  await rm(notes);
  await symlink('.credentials.json', notes);
}

describe('FleetDisk: the sign-in check is held at the read (S144, R2-m1, R2-m3)', () => {
  async function homeWithSignIn(world: FleetWorld): Promise<void> {
    await writeFile(join(world.person, '.claude', 'notes.md'), 'fine');
    await writeFile(join(world.person, '.claude', '.credentials.json'), INERT);
  }

  it('S144 R2-m1 refuses a copy whose name became a link to a sign-in after the last check, copying nothing', async () => {
    const world = await fleetWorld();
    await homeWithSignIn(world);
    let swapped = false;
    const disk = racingDisk(world, {
      beforeRead: async () => {
        if (!swapped) await swapForSignIn(world);
        swapped = true;
      },
    });

    await expect(
      disk.copyInto(join(world.person, '.claude', 'notes.md'), join(world.fleet, 'homes', 'out'), 0o600),
    ).rejects.toThrow(/changed while it was being read/u);
    expect(swapped).toBe(true);
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S144 R2-m1 refuses a read and a settings read whose name became a link to a sign-in after the check', async () => {
    const world = await fleetWorld();
    await homeWithSignIn(world);
    const notes = join(world.person, '.claude', 'notes.md');
    const swapOnce = async () => {
      if (!(await lstat(notes)).isSymbolicLink()) await swapForSignIn(world);
    };

    await expect(racingDisk(world, { beforeRead: swapOnce }).readSource(notes, 1000)).rejects.toThrow(
      /changed while it was being read/u,
    );

    // Put the plain file back: the settings read is held the same way.
    await rm(notes);
    await writeFile(notes, 'fine');
    await expect(racingDisk(world, { beforeRead: swapOnce }).readSourceText(notes)).rejects.toThrow(
      /changed while it was being read/u,
    );
  });

  it('S144 R2-m1 refuses a read whose name stopped reaching the file that was read, once it was read', async () => {
    const world = await fleetWorld();
    await homeWithSignIn(world);
    const notes = join(world.person, '.claude', 'notes.md');
    const disk = racingDisk(world, {
      afterRead: async () => {
        await rm(notes);
        await writeFile(notes, 'a different file');
      },
    });

    await expect(disk.copyInto(notes, join(world.fleet, 'homes', 'out'), 0o600)).rejects.toThrow(
      /changed while it was being read/u,
    );
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S144 R2-m3 O2 judges the real path again right before the file is read (a swap between the two checks)', async () => {
    const world = await fleetWorld();
    await homeWithSignIn(world);
    // `assertSource` judges (two real-path calls); the swap lands right after, before the copy's own judge.
    const disk = racingDisk(world, {
      afterRealPath: async count => {
        if (count === 2) await swapForSignIn(world);
      },
    });

    await expect(
      disk.copyInto(join(world.person, '.claude', 'notes.md'), join(world.fleet, 'homes', 'out'), 0o600),
    ).rejects.toThrow(/a sign-in file/u);
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S144 R2-m3 O4 refuses a sign-in name inside a copied folder whatever its kind (a folder, a link)', async () => {
    const world = await fleetWorld();
    for (const [name, make] of [
      ['asfolder', async (dir: string) => await mkdir(join(dir, 'auth.json'), { recursive: true })],
      ['aslink', async (dir: string) => await symlink('note.md', join(dir, '.credentials.json'))],
    ] as const) {
      const dir = join(world.person, '.claude', name);
      await mkdir(join(dir, 'deeper'), { recursive: true });
      await writeFile(join(dir, 'note.md'), 'fine');
      await make(join(dir, 'deeper'));

      await expect(world.disk.copyInto(dir, join(world.fleet, 'homes', `out-${name}`), 0o700)).rejects.toThrow(
        /a sign-in file/u,
      );
      expect(await world.disk.lstat(join(world.fleet, 'homes', `out-${name}`))).toBeUndefined();
    }
  });

  it('S144 R2-m1 removes a folder copy that came to hold a sign-in name between the walk and the copy', async () => {
    const world = await fleetWorld();
    const dir = join(world.person, '.claude', 'bundle');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'note.md'), 'fine');
    // The walk of the source found nothing; the name changes right before the copy starts.
    const disk = copyRacingDisk(world, async () => await rename(join(dir, 'note.md'), join(dir, 'auth.json')));

    await expect(disk.copyInto(dir, join(world.fleet, 'homes', 'out'), 0o700)).rejects.toThrow(/a sign-in file/u);
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S144 R2-m1 refuses a sign-in renamed onto the name after the check (a different file, not a link)', async () => {
    const world = await fleetWorld();
    await homeWithSignIn(world);
    const notes = join(world.person, '.claude', 'notes.md');
    let moved = false;
    const disk = racingDisk(world, {
      beforeRead: async () => {
        if (moved) return;
        moved = true;
        await rm(notes);
        await rename(join(world.person, '.claude', '.credentials.json'), notes);
      },
    });

    await expect(disk.copyInto(notes, join(world.fleet, 'homes', 'out'), 0o600)).rejects.toThrow(
      /changed while it was being read/u,
    );
    expect(await world.disk.lstat(join(world.fleet, 'homes', 'out'))).toBeUndefined();
  });

  it('S144 R2-m1 refuses a source that could not be judged, and still reads a missing one as absent', async () => {
    const world = await fleetWorld();
    await homeWithSignIn(world);
    const notes = join(world.person, '.claude', 'notes.md');
    const failing = racingDisk(world, {
      afterRealPath: async () => {
        throw new Error('the disk stopped answering');
      },
    });

    await expect(failing.readSource(notes, 1000)).rejects.toThrow(/could not be checked for a sign-in/u);
    await expect(failing.copyInto(notes, join(world.fleet, 'homes', 'out'), 0o600)).rejects.toThrow(
      /could not be checked for a sign-in/u,
    );
    expect(await world.disk.readSource(join(world.person, '.claude', 'missing.md'), 1000)).toBeUndefined();
  });
});

describe('FleetDisk: a folder copy names what it leaves out (S49, S144)', () => {
  it('S49 names a link and a hard-linked file the copy skipped, and carries the rest', async () => {
    const world = await fleetWorld();
    const dir = join(world.person, '.claude', 'skill');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'keep.md'), 'keep');
    await writeFile(join(dir, 'sub', 'two.md'), 'two');
    await symlink('keep.md', join(dir, 'alias.md'));
    await link(join(dir, 'sub', 'two.md'), join(world.parent, 'elsewhere.md'));

    const copied = await world.disk.copyInto(dir, join(world.fleet, 'copied'), 0o700);

    expect(copied.kind).toBe('directory');
    expect([...copied.left].toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'alias.md', reason: 'it is a link, and a link in a copied folder is not followed' },
      { path: join('sub', 'two.md'), reason: 'it is a file with a second name (a hard link), which is not copied' },
    ]);
    expect(await readFile(join(world.fleet, 'copied', 'keep.md'), 'utf8')).toBe('keep');
    expect(await world.disk.lstat(join(world.fleet, 'copied', 'alias.md'))).toBeUndefined();
    // A folder with nothing to leave out names nothing, and a file never does.
    const plain = join(world.person, '.claude', 'plain');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'a.md'), 'a');
    expect((await world.disk.copyInto(plain, join(world.fleet, 'plain'), 0o700)).left).toEqual([]);
    expect((await world.disk.copyInto(join(plain, 'a.md'), join(world.fleet, 'a.md'), 0o600)).left).toEqual([]);
  });
});
