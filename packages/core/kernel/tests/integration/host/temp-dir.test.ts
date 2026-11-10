/** The selftest scratch-directory adapter against the real filesystem: where it makes, what it refuses, what it removes. */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeTempDirs } from '../../../host/adapters/temp-dir.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-temp-dir-'));
  roots.push(root);
  return root;
}

const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;

describe('making and removing a scratch directory', () => {
  test('a directory is made fresh and owner-only under the temporary root, and remove takes it whole', async () => {
    const root = await scratch();
    const dirs = nodeTempDirs(join(root, 'home'), () => root);

    const made = await dirs.make();

    expect(made.startsWith(join(root, 'fyd-selftest-'))).toBe(true);
    expect((await stat(made)).mode & 0o777).toBe(0o700);
    await Bun.write(join(made, 'inner', 'file'), 'x');
    await dirs.remove(made);
    expect(await exists(made)).toBe(false);
    await dirs.remove(made);
  });

  test('removeAll removes every directory this object made, and again if one was recreated', async () => {
    const root = await scratch();
    const dirs = nodeTempDirs(join(root, 'home'), () => root);
    const first = await dirs.make();
    const second = await dirs.make();
    await dirs.remove(first);
    await mkdir(first);

    await dirs.removeAll();

    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(false);
  });

  test('removeAll swallows a directory it cannot remove and still removes the rest', async () => {
    const root = await scratch();
    const dirs = nodeTempDirs(join(root, 'home'), () => root);
    const stuck = await dirs.make();
    await Bun.write(join(stuck, 'file'), 'x');
    await chmod(stuck, 0o500);
    const other = await dirs.make();

    await dirs.removeAll();

    expect(await exists(other)).toBe(false);
    expect(await exists(stuck)).toBe(true);
    await chmod(stuck, 0o700);
  });
});

describe('never inside the state home', () => {
  test('a root below the home falls back to /tmp and leaves the home untouched', async () => {
    const root = await scratch();
    const home = join(root, 'home');
    await mkdir(join(home, 'x'), { recursive: true });
    const dirs = nodeTempDirs(home, () => join(home, 'x'));

    const made = await dirs.make();

    try {
      expect(made.startsWith('/tmp/fyd-selftest-')).toBe(true);
      expect(await readdir(join(home, 'x'))).toEqual([]);
    } finally {
      await dirs.remove(made);
    }
  });

  test('the home itself, and a link into it, are refused as a root', async () => {
    const root = await scratch();
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    await symlink(home, join(root, 'link'));

    const same = await nodeTempDirs(home, () => home).make();
    const linked = await nodeTempDirs(home, () => join(root, 'link')).make();

    for (const made of [same, linked]) {
      expect(made.startsWith(home)).toBe(false);
      expect(made.startsWith(join(root, 'link'))).toBe(false);
      await rm(made, { recursive: true, force: true });
    }
  });

  test('when no root outside the home exists the make fails rather than writing into the home', async () => {
    await expect(nodeTempDirs('/', () => '/tmp').make()).rejects.toThrow(
      'no temporary folder outside the state home is available',
    );
  });
});
