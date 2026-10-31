import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { sweepPairingRedirects } from '../../src/adapters/pairing-redirect-sweep.ts';
import { PAIRING_REDIRECT_STALE_AFTER_MS } from '../../src/lib/pairing-redirect.ts';

const NOW = 1_800_000_000_000;
const OLD = new Date(NOW - PAIRING_REDIRECT_STALE_AFTER_MS - 5_000);
const FRESH = new Date(NOW - 1_000);

const cleanups = new Set<string>();

afterEach(async () => {
  for (const path of cleanups) await rm(path, { recursive: true, force: true });
  cleanups.clear();
});

async function stateHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ferretry-redirect-sweep-'));
  cleanups.add(path);
  return path;
}

/** A page directory shaped like the one `fy pair --open` makes, aged to `writtenAt`. */
async function leftover(home: string, name: string, writtenAt: Date): Promise<string> {
  const directory = join(home, name);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'pairing.html'), '<script>location.replace("http://x/#code")</script>', {
    mode: 0o600,
  });
  await utimes(join(directory, 'pairing.html'), writtenAt, writtenAt);
  await utimes(directory, writtenAt, writtenAt);
  return directory;
}

describe('sweepPairingRedirects', () => {
  it('removes a stale page and its directory, and says how many pages it took', async () => {
    const home = await stateHome();
    await leftover(home, 'pair-open-aB3dE9', OLD);
    await leftover(home, 'pair-open-Zz9876', OLD);

    should(await sweepPairingRedirects(home, NOW)).equal(2);
    should(await readdir(home)).eql([]);
  });

  it('leaves a page a running `fy pair` may still be showing its browser', async () => {
    const home = await stateHome();
    const directory = await leftover(home, 'pair-open-aB3dE9', FRESH);

    should(await sweepPairingRedirects(home, NOW)).equal(0);
    should(await readdir(directory)).eql(['pairing.html']);
  });

  it('removes the directory of an interrupted write that never produced a page', async () => {
    const home = await stateHome();
    const directory = join(home, 'pair-open-aB3dE9');
    await mkdir(directory, { mode: 0o700 });
    await utimes(directory, OLD, OLD);

    should(await sweepPairingRedirects(home, NOW)).equal(0);
    should(await readdir(home)).eql([]);
  });

  it('leaves a fresh page-less directory alone, aged by its own time', async () => {
    const home = await stateHome();
    const directory = join(home, 'pair-open-aB3dE9');
    await mkdir(directory, { mode: 0o700 });
    await utimes(directory, FRESH, FRESH);

    should(await sweepPairingRedirects(home, NOW)).equal(0);
    should(await readdir(home)).eql(['pair-open-aB3dE9']);
  });

  it('touches nothing it did not make: a near-miss name, a plain file and a neighbour stay', async () => {
    const home = await stateHome();
    await leftover(home, 'pair-open-notes', OLD);
    await leftover(home, 'pair-open-aB3dE90', OLD);
    await writeFile(join(home, 'pair-open-aB3dE9'), 'a file that merely has our name');
    await leftover(home, 'other', OLD);

    should(await sweepPairingRedirects(home, NOW)).equal(0);
    should((await readdir(home)).sort()).eql(['other', 'pair-open-aB3dE9', 'pair-open-aB3dE90', 'pair-open-notes']);
  });

  it('never follows a symbolic link: one named like our directory is left, and its target is untouched', async () => {
    const home = await stateHome();
    const victim = await stateHome();
    await writeFile(join(victim, 'pairing.html'), 'somebody else’s file');
    await symlink(victim, join(home, 'pair-open-aB3dE9'));

    should(await sweepPairingRedirects(home, NOW)).equal(0);
    should((await lstat(join(home, 'pair-open-aB3dE9'))).isSymbolicLink()).be.true();
    should(await readdir(victim)).eql(['pairing.html']);
  });

  it('does not unlink a page that is itself a symbolic link, and leaves the directory it could not empty', async () => {
    const home = await stateHome();
    const victim = await stateHome();
    const target = join(victim, 'precious');
    await writeFile(target, 'keep me');
    const directory = join(home, 'pair-open-aB3dE9');
    await mkdir(directory, { mode: 0o700 });
    await symlink(target, join(directory, 'pairing.html'));
    await utimes(directory, OLD, OLD);

    should(await sweepPairingRedirects(home, NOW)).equal(0);
    should(await readdir(directory)).eql(['pairing.html']);
    should(await readdir(victim)).eql(['precious']);
  });

  it('keeps a directory that holds something besides the page, since rmdir refuses to empty it', async () => {
    const home = await stateHome();
    const directory = await leftover(home, 'pair-open-aB3dE9', OLD);
    await writeFile(join(directory, 'notes.txt'), 'not ours');

    should(await sweepPairingRedirects(home, NOW)).equal(1);
    should(await readdir(directory)).eql(['notes.txt']);
  });

  it('answers zero for a state home that does not exist yet', async () => {
    const home = await stateHome();

    should(await sweepPairingRedirects(join(home, 'absent'), NOW)).equal(0);
  });
});
