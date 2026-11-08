/**
 * The provisioner's disk: where a write may land (the fleet folder only), where a component may come from (the fleet's
 * assets and the harness homes only), and that a sign-in is never a source. Rows: S43, S44, S49 (a file with a second
 * name is never a source), S144.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { link, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
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
