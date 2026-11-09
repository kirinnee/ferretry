/**
 * The provisioner's disk: where a write may land (the fleet folder only), where a component may come from (the fleet's
 * assets and the harness homes only), and that a sign-in is never a source. Rows: S43, S44, S49 (a file with a second
 * name is never a source), S144.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { link, mkdir, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FleetDisk, NoDescriptorReachError } from '../../../daemon/adapters/fleet-disk.ts';
import { cleanupWorlds, fleetWorld } from '../support/fleet-world.ts';

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
