import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { PosixSessionRootPinner, ProcfsSessionRootPinner } from '../../../src/adapters/session/filesystem/index.ts';
import { FleetAssetStore } from '../../../src/lib/fleet/asset-store.ts';
import { FleetAssetRefusal } from '../../../src/lib/fleet/assets.ts';
import type { SessionRootPinner } from '../../../src/lib/session/filesystem/ports.ts';

/**
 * Both pinners face the same kernel here.
 *
 * The procfs one is what Linux runs and the POSIX one is what macOS runs; a containment claim that
 * has only ever met one of them is a claim about one platform. Any escape either allows surfaces as
 * the same named failure, so neither can quietly become the weaker one.
 */
const PINNERS = [
  ['pinned through a procfs descriptor alias', new ProcfsSessionRootPinner()],
  ['pinned through a POSIX working-directory swap', new PosixSessionRootPinner()],
] as const satisfies readonly (readonly [string, SessionRootPinner])[];

const temporaryDirectories: string[] = [];

/**
 * A state home with the asset tree at `fleet/assets` inside it, exactly as the daemon lays it out.
 *
 * `home` is what gets pinned and `fleet/assets` is what is guarded — the whole point being that the
 * guarded directory is never its own guard, so `fleet` and `assets` are ordinary components of the
 * walk and swapping either is refused.
 */
async function assetTree(): Promise<{ home: string; assets: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fy-fleet-assets-'));
  temporaryDirectories.push(root);
  const home = join(root, 'fy-home');
  const assets = join(home, 'fleet', 'assets');
  const outside = join(root, 'outside');
  await mkdir(assets, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { home, assets, outside };
}

const storeOf = (home: string, pinner: SessionRootPinner = PINNERS[0][1]): FleetAssetStore =>
  new FleetAssetStore({
    trustedRoot: home,
    assetsPrefix: 'fleet/assets',
    assetsDirectory: join(home, 'fleet', 'assets'),
    pinner,
  });

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const refusalOf = async (act: () => Promise<unknown>): Promise<string> => {
  try {
    await act();
  } catch (error) {
    should(error).be.instanceof(FleetAssetRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('FleetAssetStore reading', () => {
  it('should return the text of an asset inside the tree', async () => {
    // Arrange
    const { home, assets } = await assetTree();
    await writeFile(join(assets, 'CLAUDE.md'), 'be brief\n');
    const subject = storeOf(home);

    // Act
    const actual = await subject.read('CLAUDE.md');

    // Assert
    should(actual).deepEqual({ path: 'CLAUDE.md', content: 'be brief\n', bytes: 9 });
  });

  it('should refuse a path whose intermediate component is a link', async () => {
    // Arrange
    const { home, assets, outside } = await assetTree();
    await writeFile(join(outside, 'secret.md'), 'not yours\n');
    await symlink(outside, join(assets, 'linked'));
    const subject = storeOf(home);

    // Act
    const actual = await refusalOf(async () => await subject.read('linked/secret.md'));

    // Assert
    should(actual).match(/passes through a link/u);
  });

  it.each(PINNERS)(
    'should refuse a read whose intermediate directory was swapped for a link, %s',
    async (_, pinner) => {
      // Arrange — the tree is real and innocent when it is written, and the directory a caller has to
      // pass through is then renamed away and replaced with a link out of the tree. A path-based read
      // would follow it and serve bytes from outside, having passed every earlier check.
      const { home, assets, outside } = await assetTree();
      await mkdir(join(assets, 'skills'));
      await writeFile(join(assets, 'skills', 'skill.md'), 'ours\n');
      await mkdir(join(outside, 'skills'));
      await writeFile(join(outside, 'skills', 'skill.md'), 'not yours\n');
      await rename(join(assets, 'skills'), join(assets, 'skills-real'));
      await symlink(join(outside, 'skills'), join(assets, 'skills'));
      const subject = storeOf(home, pinner);

      // Act
      const actual = await refusalOf(async () => await subject.read('skills/skill.md'));

      // Assert — refused, and nothing from outside the tree came back.
      should(actual).match(/passes through a link or leaves the asset tree/u);
    },
  );

  it.each(PINNERS)('should refuse a read when the asset root itself was swapped for a link, %s', async (_, pinner) => {
    // Arrange — the escape the old design could not see. When the pin WAS `fleet/assets`, swapping
    // that one directory for a link happened before the pin, the pin followed it, and every
    // component below was then walked faithfully inside somebody else's tree. Pinning the state
    // home instead makes `assets` an ordinary component of the walk.
    const { home, assets, outside } = await assetTree();
    await writeFile(join(outside, 'CLAUDE.md'), 'not yours\n');
    await rename(assets, join(home, 'fleet', 'assets-real'));
    await symlink(outside, assets);
    const subject = storeOf(home, pinner);

    // Act
    const actual = await refusalOf(async () => await subject.read('CLAUDE.md'));

    // Assert
    should(actual).match(/passes through a link or leaves the asset tree/u);
  });

  it.each(PINNERS)('should refuse a read when the fleet directory itself was swapped, %s', async (_, pinner) => {
    // Arrange — one level higher again: every component between the pin and the leaf is guarded,
    // not merely the last one before the asset tree.
    const { home, assets, outside } = await assetTree();
    await mkdir(join(outside, 'assets'), { recursive: true });
    await writeFile(join(outside, 'assets', 'CLAUDE.md'), 'not yours\n');
    await rm(assets, { recursive: true, force: true });
    await rename(join(home, 'fleet'), join(home, 'fleet-real'));
    await symlink(outside, join(home, 'fleet'));
    const subject = storeOf(home, pinner);

    // Act
    const actual = await refusalOf(async () => await subject.read('CLAUDE.md'));

    // Assert
    should(actual).match(/passes through a link or leaves the asset tree/u);
  });

  it.each(PINNERS)('should refuse a read of a leaf swapped for a link, %s', async (_, pinner) => {
    // Arrange
    const { home, assets, outside } = await assetTree();
    await writeFile(join(outside, 'secret.md'), 'not yours\n');
    await symlink(join(outside, 'secret.md'), join(assets, 'CLAUDE.md'));
    const subject = storeOf(home, pinner);

    // Act
    const actual = await refusalOf(async () => await subject.read('CLAUDE.md'));

    // Assert — refused as a link, not read through as though it were the file it points at.
    should(actual).match(/passes through a link or leaves the asset tree/u);
  });

  it('should refuse a directory where a readable asset should be', async () => {
    // Arrange
    const { home, assets } = await assetTree();
    await mkdir(join(assets, 'CLAUDE.md'));
    const subject = storeOf(home);

    // Act
    const actual = await refusalOf(async () => await subject.read('CLAUDE.md'));

    // Assert
    should(actual).match(/not a regular file/u);
  });

  it('should refuse an asset that is not valid text', async () => {
    // Arrange
    const { home, assets } = await assetTree();
    await writeFile(join(assets, 'binary.md'), new Uint8Array([0xff, 0xfe, 0x00]));
    const subject = storeOf(home);

    // Act
    const actual = await refusalOf(async () => await subject.read('binary.md'));

    // Assert
    should(actual).match(/not valid text/u);
  });

  it('should report a missing asset as missing rather than as damage', async () => {
    // Arrange — staleness checking depends on this distinction: absent is a state a change may
    // legitimately expect, and damage is not.
    const { home } = await assetTree();
    const subject = storeOf(home);

    // Act
    let missing = false;
    try {
      await subject.read('nothing.md');
    } catch (error) {
      missing = (error as FleetAssetRefusal).missing;
    }

    // Assert
    should(missing).be.true();
  });
});

describe('FleetAssetStore listing', () => {
  it('should describe what it can edit and explain what it cannot', async () => {
    // Arrange
    const { home, assets, outside } = await assetTree();
    await mkdir(join(assets, 'skills'));
    await writeFile(join(assets, 'CLAUDE.md'), 'be brief\n');
    await writeFile(join(assets, 'skills', 'binary.md'), new Uint8Array([0xff, 0xfe, 0x00]));
    await symlink(outside, join(assets, 'linked'));
    const subject = storeOf(home);

    // Act
    const actual = await subject.list();

    // Assert — an entry the editor will not touch is still listed, with a reason.
    should(actual.complete).be.true();
    should(actual.files.map(file => file.path)).deepEqual(['CLAUDE.md', 'linked', 'skills/binary.md']);
    should(actual.files.find(file => file.path === 'linked')).match({ readable: false, reason: /link/u });
    should(actual.files.find(file => file.path === 'skills/binary.md')).match({ readable: false });
  });

  it.each(PINNERS)('should enumerate nothing when the asset root itself was swapped, %s', async (_, pinner) => {
    // Arrange — the listing half of the same escape. Following it would enumerate somebody else's
    // directory as though it were this host's assets, which is worse than showing nothing.
    const { home, assets, outside } = await assetTree();
    await writeFile(join(outside, 'secret.md'), 'not yours\n');
    await rename(assets, join(home, 'fleet', 'assets-real'));
    await symlink(outside, assets);
    const subject = storeOf(home, pinner);

    // Act
    const actual = await subject.list();

    // Assert — nothing from outside, and it says the picture is not the whole tree.
    should(actual.files).deepEqual([]);
    should(actual.complete).be.false();
  });

  it.each(PINNERS)('should enumerate nothing when the fleet directory itself was swapped, %s', async (_, pinner) => {
    // Arrange
    const { home, assets, outside } = await assetTree();
    await mkdir(join(outside, 'assets'), { recursive: true });
    await writeFile(join(outside, 'assets', 'secret.md'), 'not yours\n');
    await rm(assets, { recursive: true, force: true });
    await rename(join(home, 'fleet'), join(home, 'fleet-real'));
    await symlink(outside, join(home, 'fleet'));
    const subject = storeOf(home, pinner);

    // Act
    const actual = await subject.list();

    // Assert
    should(actual.files).deepEqual([]);
    should(actual.complete).be.false();
  });

  it.each(PINNERS)('should never walk into an intermediate directory swapped for a link, %s', async (_, pinner) => {
    // Arrange — the same escape as the read case, on the traversal path. The tree is real and
    // innocent first, and only then is `skills` renamed aside and replaced with a link out of the
    // tree. A listing that followed it would enumerate somebody else's directory as this host's.
    const { home, assets, outside } = await assetTree();
    await writeFile(join(assets, 'CLAUDE.md'), 'be brief\n');
    await mkdir(join(assets, 'skills'));
    await writeFile(join(assets, 'skills', 'ours.md'), 'ours\n');
    await mkdir(join(outside, 'skills'));
    await writeFile(join(outside, 'skills', 'secret.md'), 'not yours\n');
    await rename(join(assets, 'skills'), join(assets, 'skills-real'));
    await symlink(join(outside, 'skills'), join(assets, 'skills'));
    const subject = storeOf(home, pinner);

    // Act
    const actual = await subject.list();

    // Assert — the link is described, never followed, and nothing from outside appears.
    should(actual.files.map(file => file.path)).deepEqual(['CLAUDE.md', 'skills', 'skills-real/ours.md']);
    should(actual.files.find(file => file.path === 'skills')).match({ readable: false, reason: /link/u });
    should(actual.files.some(file => file.path.includes('secret'))).be.false();
  });

  it.each(PINNERS)('should describe a leaf swapped for a link without reading it, %s', async (_, pinner) => {
    // Arrange
    const { home, assets, outside } = await assetTree();
    await writeFile(join(outside, 'secret.md'), 'not yours\n');
    await symlink(join(outside, 'secret.md'), join(assets, 'CLAUDE.md'));
    const subject = storeOf(home, pinner);

    // Act
    const actual = await subject.list();

    // Assert
    should(actual.files).match([{ path: 'CLAUDE.md', readable: false, reason: /link/u }]);
  });

  it('should say so when a bound stopped it describing the whole tree', async () => {
    // Arrange — a deep chain, deeper than a path may be, so the walk stops before the bottom.
    const { home, assets } = await assetTree();
    const deep = join(assets, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'buried.md'), 'too deep\n');
    const subject = storeOf(home);

    // Act
    const actual = await subject.list();

    // Assert — a truncated list that looked complete is how somebody concludes a file is missing.
    should(actual.complete).be.false();
  });

  it.each(PINNERS)('should refuse, naming the cause, when the tree cannot be held open, %s', async (_, pinner) => {
    // Arrange — a regular file where the asset directory should be. That is damage, not absence,
    // and reporting it as an empty tree would tell a person their instructions had vanished.
    const { assets } = await assetTree();
    const notADirectory = join(assets, 'not-a-directory');
    await writeFile(notADirectory, 'a file where the asset tree should be\n');
    const subject = new FleetAssetStore({
      trustedRoot: notADirectory,
      assetsPrefix: 'fleet/assets',
      assetsDirectory: join(notADirectory, 'fleet', 'assets'),
      pinner,
    });

    // Act
    const actual = await refusalOf(async () => await subject.list());

    // Assert — the refusal carries the underlying reason rather than a bare failure.
    should(actual).match(/asset tree could not be opened safely: .+/u);
  });

  it('should return nothing at all for a tree that does not exist yet', async () => {
    // Arrange
    const { home } = await assetTree();
    const subject = storeOf(join(home, 'never-created'));

    // Act
    const actual = await subject.list();

    // Assert
    should(actual).deepEqual({ files: [], complete: true });
  });
});
