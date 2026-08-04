import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NixStoreGcRoot } from '../../../src/adapters/daemon/nix-gc-root.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import type { CommandOutcome, IDaemonProcessPort } from '../../../src/lib/daemon/ports.ts';

/**
 * The Nix garbage-collection root adapter: real filesystem, scripted `nix-store`.
 *
 * The filesystem half is the half worth running for real — creating the directory nothing else owns,
 * clearing a stale link an upgrade left behind, resolving a profile symlink, removing a root. The
 * `nix-store` half is scripted through the process port on purpose: invoking the real `nix-store`
 * would write a garbage-collection root into `/nix/var/nix/gcroots/auto` on whatever machine ran the
 * suite, and would silently skip itself on any machine without Nix — which is the same as having no
 * test at all. The argv asserted below was verified against the real `nix-store` by hand first.
 */

const roots = new Set<string>();
/** A syntactically real store path: Nix base32 excludes e, o, u and t. */
const STORE_PATH = '/nix/store/q1w2r3y4i5p6asdfghjklzxcvbnm1234-ferretry-0.125.0';

/** Records every command, and answers with whatever the test scripted. */
class RecordingProcesses implements IDaemonProcessPort {
  readonly ran: string[][] = [];

  constructor(private readonly answer: CommandOutcome = { code: 0, stdout: '', stderr: '' }) {}

  run(argv: readonly string[]): Promise<CommandOutcome> {
    this.ran.push([...argv]);
    return Promise.resolve(this.answer);
  }

  spawnDetached(): Promise<never> {
    return Promise.reject(new Error('this test never launches the daemon'));
  }

  signal(): boolean {
    return false;
  }

  alive(): boolean {
    return false;
  }
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-nix-root-'));
  roots.add(root);
  return root;
}

/** `lstat`, not `Bun.file`: the paths here are a directory and a symbolic link, not regular files. */
async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe('nix garbage-collection root adapter', () => {
  it('should ask nix-store for an indirect root, and create the directory it lives in', async () => {
    // Arrange — nothing else owns this directory: it is the CLI's, outside the daemon's state home.
    const root = await createTemporaryRoot();
    const rootPath = join(root, 'state', 'ferretry', 'nix', 'fyd');
    const processes = new RecordingProcesses();

    // Act
    const failure = await new NixStoreGcRoot(processes).pin(STORE_PATH, rootPath);

    // Assert — `--indirect` is what makes a link outside the store count as a root, and `--realise`
    // is what takes a store path. Both are load-bearing; neither is decoration.
    should(failure).be.undefined();
    should(processes.ran).deepEqual([['nix-store', '--add-root', rootPath, '--indirect', '--realise', STORE_PATH]]);
    should(await exists(join(root, 'state', 'ferretry', 'nix'))).be.true();
  });

  it('should clear a stale root before asking for a new one', async () => {
    // Arrange — an upgrade re-points the root, and `nix-store --add-root` will not overwrite a link.
    const root = await createTemporaryRoot();
    const rootPath = join(root, 'fyd');
    await symlink('/nix/store/an-older-output', rootPath);

    // Act
    const failure = await new NixStoreGcRoot(new RecordingProcesses()).pin(STORE_PATH, rootPath);

    // Assert
    should(failure).be.undefined();
    should(await exists(rootPath)).be.false();
  });

  it.each([
    {
      name: 'nix-store is not installed',
      outcome: { code: 127, stdout: '', stderr: '' },
      expected: 'nix-store is not on PATH',
    },
    {
      name: 'nix-store refuses the path',
      outcome: { code: 1, stdout: '', stderr: 'error: path is not valid\n' },
      expected: 'error: path is not valid',
    },
    {
      name: 'nix-store fails silently',
      outcome: { code: 3, stdout: '', stderr: '  ' },
      expected: 'nix-store exited 3',
    },
  ])('should report rather than throw when $name', async ({ outcome, expected }) => {
    // Arrange
    const root = await createTemporaryRoot();

    // Act
    const failure = await new NixStoreGcRoot(new RecordingProcesses(outcome)).pin(STORE_PATH, join(root, 'fyd'));

    // Assert — the caller warns and carries on; a failed pin must never fail a working install.
    should(failure).equal(expected);
  });

  it('should report rather than throw when the root directory cannot be created', async () => {
    // Arrange — a FILE where the root's parent directory must go, so `mkdir` cannot succeed.
    const root = await createTemporaryRoot();
    const blocker = join(root, 'blocked');
    await writeFile(blocker, 'not a directory');
    const processes = new RecordingProcesses();

    // Act
    const failure = await new NixStoreGcRoot(processes).pin(STORE_PATH, join(blocker, 'nix', 'fyd'));

    // Assert — and nix-store is never asked, because there is nowhere to put the root.
    should(failure).match(/could not create/);
    should(processes.ran).be.empty();
  });

  it('should map a command that does not exist to the code the adapter reads as absent', async () => {
    // Arrange — the 127 above is only meaningful if the real process port actually produces it for a
    // missing executable, which is how a machine with no Nix presents itself.
    const subject = new BunDaemonProcess();

    // Act
    const actual = await subject.run(['fy-nix-store-that-cannot-exist']);

    // Assert
    should(actual.code).equal(127);
  });

  it('should resolve a symbolic link so a profile install is classified by what it points at', async () => {
    // Arrange — `nix profile install` puts ~/.nix-profile/bin/fy on PATH, not the store path itself.
    const root = await createTemporaryRoot();
    const target = join(root, 'real-fyd');
    const link = join(root, 'linked-fyd');
    await writeFile(target, '', { mode: 0o755 });
    await symlink(target, link);
    const subject = new NixStoreGcRoot(new RecordingProcesses());

    // Act
    const resolved = await subject.realPath(link);
    const missing = await subject.realPath(join(root, 'not-here'));

    // Assert — an unresolvable path comes back unchanged; it is simply not a Nix path.
    should(resolved).equal(target);
    should(missing).equal(join(root, 'not-here'));
  });

  it('should release a root by removing the link, and treat an absent one as released', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const rootPath = join(root, 'fyd');
    await symlink(STORE_PATH, rootPath);
    const subject = new NixStoreGcRoot(new RecordingProcesses());

    // Act
    await subject.release(rootPath);
    const secondRelease = await subject.release(join(root, 'never-existed')).then(
      () => 'resolved',
      () => 'rejected',
    );

    // Assert — the entry Nix keeps in its auto-roots directory then dangles, which Nix already treats
    // as no longer a root. Nothing here has to reach into /nix/var.
    should(await readlink(rootPath).catch(() => undefined)).be.undefined();
    should(secondRelease).equal('resolved');
  });
});
