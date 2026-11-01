import { describe, it } from 'bun:test';
import should from 'should';
import {
  assertSourceUnfenced,
  FencedSourceError,
  readFencedSource,
  resolveSourceFence,
} from '../../src/adapters/fenced-source.ts';
import { FakeGuardDisk } from './fake-guard-disk.ts';

/**
 * Where a component source may be a hard link (docs/secrets.md#what-the-state-home-fence-refuses): only under
 * a store the guard PROVES immutable — a multi-user Nix store, `root:nixbld 1775` — and nowhere else, so a hard
 * link to the admin token in an ordinary folder is refused.
 */

const HOME = '/home/me/.ferretry';
const USER = 1000;

/** A machine with a state home, its admin token, a multi-user Nix store and an ordinary folder. */
function machine(store: 'multi-user' | 'single-user'): FakeGuardDisk {
  const disk = new FakeGuardDisk();
  disk.own('/', 0, 0o755);
  disk.dir('/home');
  disk.dir('/home/me');
  disk.dir(HOME);
  disk.file(`${HOME}/api-token`, 16, 'fy_admin_secret\n');
  disk.dir('/home/me/notes');
  disk.dir('/nix');
  disk.own('/nix', 0, 0o755);
  disk.dir('/nix/store');
  if (store === 'multi-user') disk.own('/nix/store', 0, 0o1775, 30_000);
  else disk.own('/nix/store', USER, 0o755, 100);
  // The store's own folders and files are root's, as a multi-user store's are.
  for (const folder of ['/nix/store/abc-skill', '/nix/store/def-skill']) {
    disk.dir(folder);
    disk.own(folder, 0, 0o555);
  }
  disk.file('/nix/store/abc-skill/SKILL.md', 9, 'A skill.\n');
  disk.own('/nix/store/abc-skill/SKILL.md', 0, 0o444);
  disk.hardLink('/nix/store/def-skill/SKILL.md', '/nix/store/abc-skill/SKILL.md');
  return disk;
}

const fenceOf = (disk: FakeGuardDisk) => resolveSourceFence({ homes: [HOME], open: [`${HOME}/fleet/assets`] }, disk);

describe('a hard-linked component source', () => {
  it('should be read from a multi-user Nix store, where identical files share one inode', async () => {
    // Arrange
    const disk = machine('multi-user');

    // Act
    const text = await readFencedSource(await fenceOf(disk), '/nix/store/def-skill/SKILL.md', 1024);

    // Assert
    should(text).eql('A skill.\n');
  });

  it('should be refused anywhere else, where its other name could be the admin token', async () => {
    // Arrange
    const disk = machine('multi-user');
    disk.hardLink('/home/me/notes/CLAUDE.md', `${HOME}/api-token`);
    const fence = await fenceOf(disk);

    // Act
    const refusal = await assertSourceUnfenced(fence, '/home/me/notes/CLAUDE.md').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(refusal).be.instanceOf(FencedSourceError);
    should((refusal as FencedSourceError).rule).eql('hard-link');
    should((refusal as Error).message).not.match(/fy_admin_secret/u);
  });

  it('should be refused even in the store when this user owns it, as a single-user Nix install does', async () => {
    // Arrange
    const disk = machine('single-user');

    // Act
    const refusal = await assertSourceUnfenced(await fenceOf(disk), '/nix/store/def-skill/SKILL.md').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should((refusal as FencedSourceError).rule).eql('hard-link');
  });
});
