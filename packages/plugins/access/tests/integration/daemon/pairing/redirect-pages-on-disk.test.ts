/**
 * The pairing redirect pages on a REAL state folder: `fy pair --open` makes one inside a private directory of Access's
 * declared tree, and a killed run leaves it behind until the next `fy pair` or the daemon's boot sweeps it. Everything
 * here is a temp folder and the kernel's real state port; the launcher is a stand-in script on a private PATH, so no
 * browser is ever started and the link is only ever seen through the file the launcher was given.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KernelPorts, StatePort } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import {
  PAIRING_REDIRECT_DIRECTORY_PREFIX,
  PAIRING_REDIRECT_FILE_NAME,
  PAIRING_REDIRECT_STALE_AFTER_MS,
  PairingRedirectsFile,
} from '../../../../contract/index.ts';
import {
  createPairingRedirectPage,
  desktopBrowserOpener,
  onProcessExit,
} from '../../../../cli/adapters/pair/browser-opener.ts';
import { sweepPairingRedirectState } from '../../../../cli/adapters/pairing-redirect-sweep.ts';
import { pairingRedirectBoot } from '../../../../daemon/adapters/pairing/boot-redirect-sweep.ts';
import manifest from '../../../../manifest.ts';

const folders: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}

async function disk() {
  const home = await temp('fy-access-redirects-');
  const port = state.createStatePort({
    home,
    pluginId: 'access',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
  const tree = join(home, 'state', 'access', 'pairing-redirects');
  /** A page directory the way `fy pair --open` makes it, then aged by `ageMs`. */
  const leave = async (suffix: string, options: { readonly ageMs: number; readonly page?: boolean }) => {
    const name = `${PAIRING_REDIRECT_DIRECTORY_PREFIX}${suffix}`;
    await port.createPrivateDirectory(PairingRedirectsFile, name);
    if (options.page !== false)
      await port.write(
        PairingRedirectsFile,
        new TextEncoder().encode('<p>stale</p>'),
        `${name}/${PAIRING_REDIRECT_FILE_NAME}`,
      );
    const when = new Date(Date.now() - options.ageMs);
    if (options.page !== false) await utimes(join(tree, name, PAIRING_REDIRECT_FILE_NAME), when, when);
    await utimes(join(tree, name), when, when);
    return name;
  };
  const left = async (): Promise<readonly string[]> => (await readdir(tree).catch(() => [])).sort();
  return { home, port, tree, leave, left };
}

const OLD = PAIRING_REDIRECT_STALE_AFTER_MS + 60_000;

describe('the shipped opener, with a stand-in launcher on a private PATH', () => {
  it('should hand the launcher the path of a private page, never the link, and refuse when it has no state', async () => {
    const { port, tree, left } = await disk();
    const bin = await temp('fy-access-launcher-');
    const asked = join(bin, 'asked.txt');
    const script = `#!/bin/sh\nprintf '%s' "$1" > '${asked}'\n`;
    for (const name of ['xdg-open', 'open']) {
      await writeFile(join(bin, name), script);
      await chmod(join(bin, name), 0o755);
    }
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const link = 'https://ferretry.example.invalid/pair#v1;u;f;code=7F3K-Q2ND';

    const opened = await desktopBrowserOpener(await temp('fy-access-statehome-'), port).open(link);
    const refused = await desktopBrowserOpener(await temp('fy-access-statehome-'), undefined).open(link);
    // The launcher is a detached child: wait for what it HAS DONE (written its argument), never for a time.
    while (!(await Bun.file(asked).exists())) await Bun.sleep(10);
    const given = await readFile(asked, 'utf8');

    should(opened).equal(true);
    should(refused).equal(false);
    should(given.startsWith(tree)).equal(true);
    should(given).not.containEql('7F3K-Q2ND');
    should(await readFile(given, 'utf8')).containEql('7F3K-Q2ND');
    should(((await stat(given)).mode & 0o777).toString(8)).equal('600');
    should(await left()).have.length(1);
  });
});

describe('the redirect page the CLI writes into the state tree', () => {
  it('should write it inside a fresh private directory and take both away when discarded', async () => {
    const { port, tree, left } = await disk();

    const page = await createPairingRedirectPage(port, '<p>redirect</p>');
    const written = await readFile(page.file, 'utf8');
    const before = await left();
    await page.discard();

    should(written).equal('<p>redirect</p>');
    should(page.file.startsWith(tree)).equal(true);
    should(before).have.length(1);
    should(before[0]).match(/^pair-open-[A-Za-z0-9]{6}$/u);
    should(await left()).deepEqual([]);
  });

  it('should leave nothing behind when the page cannot be written', async () => {
    const { port, left } = await disk();
    const failing: Pick<StatePort, 'write' | 'pathOf' | 'remove' | 'removeEmptyDirectory' | 'createPrivateDirectory'> =
      {
        write: async () => {
          throw new Error('the disk is full');
        },
        pathOf: (file, name) => port.pathOf(file, name),
        remove: (file, name) => port.remove(file, name),
        removeEmptyDirectory: (file, name) => port.removeEmptyDirectory(file, name),
        createPrivateDirectory: (file, name) => port.createPrivateDirectory(file, name),
      };

    await createPairingRedirectPage(failing, '<p>x</p>').then(
      () => should.fail(undefined, undefined, 'the write should have failed'),
      (error: unknown) => should((error as Error).message).equal('the disk is full'),
    );

    should(await left()).deepEqual([]);
  });
});

describe('ending the process', () => {
  it('should still exit with the conventional status when the cleanup itself throws', async () => {
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    onProcessExit(
      {
        once: (event, listener) => {
          listeners.set(event, listener);
        },
        exit: code => {
          exits.push(code);
          return undefined as never;
        },
      },
      () => {
        throw new Error('the cleanup fell over');
      },
    );

    listeners.get('exit')?.();
    listeners.get('SIGTERM')?.();
    await Bun.sleep(20);

    should(exits).deepEqual([143]);
  });
});

describe('the sweep of pages a killed run left behind', () => {
  async function sweepsOf(world: Awaited<ReturnType<typeof disk>>) {
    return [
      { name: 'the CLI sweep', run: async () => await sweepPairingRedirectState(world.port, Date.now()) },
      {
        name: 'the daemon boot sweep',
        run: async () =>
          await pairingRedirectBoot().beforeListen({
            kernel: { state: world.port, clock: { nowMs: () => Date.now() } } as unknown as KernelPorts,
          }),
      },
    ];
  }

  it('should remove an old page and its directory, and leave a young one, a stranger and a link alone', async () => {
    for (const label of ['cli', 'boot']) {
      const world = await disk();
      const sweep = (await sweepsOf(world))[label === 'cli' ? 0 : 1];
      const old = await world.leave('aaaaaa', { ageMs: OLD });
      const young = await world.leave('bbbbbb', { ageMs: 1_000 });
      const interrupted = await world.leave('cccccc', { ageMs: OLD, page: false });
      await mkdir(join(world.tree, 'not-ours'));
      const elsewhere = await temp('fy-access-elsewhere-');
      await writeFile(join(elsewhere, 'precious.txt'), 'keep');
      await symlink(elsewhere, join(world.tree, `${PAIRING_REDIRECT_DIRECTORY_PREFIX}dddddd`));

      await sweep?.run();

      const remaining = await world.left();
      should(remaining).containEql(young);
      should(remaining).containEql('not-ours');
      should(remaining).containEql(`${PAIRING_REDIRECT_DIRECTORY_PREFIX}dddddd`);
      should(remaining).not.containEql(old);
      should(remaining).not.containEql(interrupted);
      should(await readFile(join(elsewhere, 'precious.txt'), 'utf8')).equal('keep');
    }
  });

  it('should leave a directory with unexpected contents where it is, and sweep nothing from an absent tree', async () => {
    for (const label of ['cli', 'boot']) {
      const world = await disk();
      const sweep = (await sweepsOf(world))[label === 'cli' ? 0 : 1];
      await sweep?.run();
      const odd = await world.leave('eeeeee', { ageMs: OLD });
      await writeFile(join(world.tree, odd, 'unexpected.txt'), 'not a page of ours');
      await utimes(join(world.tree, odd), new Date(Date.now() - OLD), new Date(Date.now() - OLD));

      await sweep?.run();

      should(await world.left()).deepEqual([odd]);
      should((await readdir(join(world.tree, odd))).sort()).deepEqual(['unexpected.txt']);
    }
  });

  it('should never stop a pairing or a boot, whatever the state port says', async () => {
    const world = await disk();
    const broken = {
      ...world.port,
      list: async () => {
        throw new Error('the tree is unreadable');
      },
    } as unknown as StatePort;

    await sweepPairingRedirectState(broken, Date.now());
    await sweepPairingRedirectState(undefined, Date.now());
    await pairingRedirectBoot().beforeListen({
      kernel: { state: broken, clock: { nowMs: () => Date.now() } } as unknown as KernelPorts,
    });
  });
});
