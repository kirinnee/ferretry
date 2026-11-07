import { afterAll, describe, it } from 'bun:test';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import {
  loadDirectorySyscalls,
  NODE_PIN_FILE_CALLS,
  type PinFileCalls,
  PosixSessionRootPinner,
  ProcfsSessionRootPinner,
} from '../../../../src/adapters/session/filesystem/index.ts';
import type { PinnedRoot, SessionRootPinner, WorkBudget } from '../../../../src/lib/session/filesystem/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../../support/repository.ts';

/**
 * The batched file probe an index proves its candidates through, against the real kernel.
 *
 * The probe is the one place a walk is SHARED between names, so the questions here are the ones sharing
 * could get wrong: a sibling answered from a directory held for a cousin, a link at the leaf reported as
 * its target, a refused directory leaking into the next name, and a probe that closes the root it was
 * borrowed from. The last suite counts the calls, because on a host whose endpoint security intercepts
 * every `open` the count IS the latency.
 */

const PINNERS: readonly (readonly [string, SessionRootPinner])[] = [
  ...(process.platform === 'linux'
    ? ([['pinned through a procfs descriptor alias', new ProcfsSessionRootPinner()]] as const)
    : []),
  ['pinned through the kernel working directory', new PosixSessionRootPinner()],
];

async function withPin<Result>(
  pinner: SessionRootPinner,
  cwd: string,
  act: (pinned: PinnedRoot) => Promise<Result>,
): Promise<Result> {
  const pinned = await pinner.pin(cwd);
  try {
    return await act(pinned);
  } finally {
    await pinned.close();
  }
}

async function classify(
  pinner: SessionRootPinner,
  cwd: string,
  rels: readonly string[],
  budget?: WorkBudget,
): Promise<readonly string[]> {
  return await withPin(pinner, cwd, async pinned => {
    const probe = pinned.probe();
    try {
      return await probe.classify(rels, budget);
    } finally {
      await probe.close();
    }
  });
}

/** A tree with every kind of name a tracked-file list can carry, and a sibling tree nothing may reach. */
async function fixture(): Promise<{ readonly root: string; readonly outside: string }> {
  const root = await tempDirectory('probe');
  const outside = await tempDirectory('probe-outside');
  await mkdir(path.join(root, 'a', 'b'), { recursive: true });
  await mkdir(path.join(root, 'c'), { recursive: true });
  await writeFile(path.join(root, 'top.ts'), 'x\n');
  await writeFile(path.join(root, 'a', 'one.ts'), 'x\n');
  await writeFile(path.join(root, 'a', 'two.ts'), 'x\n');
  await writeFile(path.join(root, 'a', 'b', 'deep.ts'), 'x\n');
  await writeFile(path.join(root, 'c', 'three.ts'), 'x\n');
  await writeFile(path.join(outside, 'secret.ts'), 'OUTSIDE\n');
  await mkdir(path.join(outside, 'dir'));
  await writeFile(path.join(outside, 'dir', 'inner.ts'), 'OUTSIDE\n');
  await symlink(path.join(outside, 'secret.ts'), path.join(root, 'a', 'escape.ts'));
  await symlink('one.ts', path.join(root, 'a', 'alias.ts'));
  await symlink(path.join(outside, 'dir'), path.join(root, 'linked'));
  await symlink('a', path.join(root, 'inside-link'));
  return { root, outside };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

for (const [label, pinner] of PINNERS) {
  describe(`a file probe ${label}`, () => {
    it('should call a regular file a file and everything a read would refuse unsupported', async () => {
      // Arrange
      const { root } = await fixture();

      // Act
      const kinds = await classify(pinner, root, [
        'top.ts',
        'a/one.ts',
        'a/escape.ts',
        'a/alias.ts',
        'a/missing.ts',
        'a/b',
        'linked/inner.ts',
        'inside-link/one.ts',
        'top.ts/under-a-file.ts',
        'gone/deeper/file.ts',
      ]);

      // Assert: a link is refused at the leaf AND mid-path, whether it escapes or not.
      should(kinds).eql([
        'file',
        'file',
        'unsupported',
        'unsupported',
        'unsupported',
        'unsupported',
        'unsupported',
        'unsupported',
        'unsupported',
        'unsupported',
      ]);
    });

    it('should refuse a name that walks out of a held directory without asking the kernel', async () => {
      // Arrange
      const { root } = await fixture();

      // Act
      const kinds = await classify(pinner, root, ['a/../top.ts', '../escape', 'a//one.ts', './top.ts', '']);

      // Assert
      should(kinds).eql(['unsupported', 'unsupported', 'unsupported', 'unsupported', 'unsupported']);
    });

    it('should answer siblings and cousins from the right directory whatever order they come in', async () => {
      // Arrange: the chain is held between names, so a cousin must close back to the shared ancestor
      // rather than look for its leaf in the directory the previous name left open.
      const { root } = await fixture();

      // Act
      const kinds = await classify(pinner, root, [
        'a/b/deep.ts',
        'a/one.ts',
        'c/three.ts',
        'a/b/deep.ts',
        'top.ts',
        'c/one.ts',
        'a/two.ts',
        'a/b/one.ts',
      ]);

      // Assert
      should(kinds).eql(['file', 'file', 'file', 'file', 'file', 'unsupported', 'file', 'unsupported']);
    });

    it('should keep a refused directory from answering for the names after it', async () => {
      // Arrange
      const { root } = await fixture();

      // Act: the link refuses, and the next name in a REAL directory of the same spelling depth is a file.
      const kinds = await classify(pinner, root, ['linked/inner.ts', 'linked/other.ts', 'a/one.ts', 'linkedx']);

      // Assert
      should(kinds).eql(['unsupported', 'unsupported', 'file', 'unsupported']);
    });

    it('should answer only the names it reached before the budget was spent', async () => {
      // Arrange: asked once per name, so the third question finds it spent.
      const { root } = await fixture();
      let asked = 0;
      const budget: WorkBudget = { expired: () => ++asked > 2 };

      // Act
      const kinds = await classify(pinner, root, ['a/one.ts', 'a/two.ts', 'c/three.ts', 'top.ts'], budget);

      // Assert
      should(kinds).eql(['file', 'file']);
      should(asked).eql(3);
    });

    it('should call a directory it may not enter unreadable rather than absent', async () => {
      // Arrange: a superuser walks through any mode, so the case only exists for an ordinary user.
      if (process.getuid?.() === 0) return;
      const { root } = await fixture();
      await mkdir(path.join(root, 'closed'));
      await writeFile(path.join(root, 'closed', 'inside.ts'), 'x\n');
      await chmod(path.join(root, 'closed'), 0o000);

      // Act
      let kinds: readonly string[];
      try {
        kinds = await classify(pinner, root, ['closed/inside.ts', 'top.ts']);
      } finally {
        await chmod(path.join(root, 'closed'), 0o755);
      }

      // Assert
      should(kinds).eql(['unreadable', 'file']);
    });

    it('should leave the root it borrowed from open after it closes', async () => {
      // Arrange
      const { root } = await fixture();

      // Act
      const read = await withPin(pinner, root, async pinned => {
        const probe = pinned.probe();
        await probe.classify(['a/one.ts', 'a/b/deep.ts']);
        await probe.close();
        const target = await pinned.open('c/three.ts');
        try {
          return { type: target.metadata.type, refused: await probe.classify(['top.ts']).catch(() => 'closed') };
        } finally {
          await target.close();
        }
      });

      // Assert
      should(read).eql({ type: 'file', refused: 'closed' });
    });
  });
}

/** Every call the POSIX pinner makes, counted by name. */
function countingCalls(): { readonly calls: PinFileCalls; readonly counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const counted =
    <Args extends unknown[], Result>(name: string, call: (...args: Args) => Result) =>
    (...args: Args): Result => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return call(...args);
    };
  const real = NODE_PIN_FILE_CALLS;
  const calls: PinFileCalls = {
    open: counted('open', (name: string, flags: number) => real.open(name, flags)),
    close: counted('close', (fd: number) => real.close(fd)),
    fstat: counted('fstat', (fd: number) => real.fstat(fd)),
    lstat: counted('lstat', (name: string) => real.lstat(name)),
    stat: counted('stat', (name: string) => real.stat(name)),
    realpath: counted('realpath', (name: string) => real.realpath(name)),
    opendir: counted('opendir', (name: string) => real.opendir(name)),
  };
  return { calls, counts };
}

describe('the calls one index probe makes through the kernel working directory', () => {
  /** 20 packages × 2 directories × 5 files: 200 names in 60 directories, two deep. */
  async function wideTree(): Promise<{ readonly root: string; readonly rels: readonly string[] }> {
    const root = await tempDirectory('probe-budget');
    const rels: string[] = [];
    for (let pkg = 0; pkg < 20; pkg += 1) {
      for (const leaf of ['src', 'test']) {
        await mkdir(path.join(root, `pkg${pkg}`, leaf), { recursive: true });
        for (let file = 0; file < 5; file += 1) {
          await writeFile(path.join(root, `pkg${pkg}`, leaf, `f${file}.ts`), 'x\n');
          rels.push(`pkg${pkg}/${leaf}/f${file}.ts`);
        }
      }
    }
    return { root, rels: rels.sort() };
  }

  it('should open each directory once and never open a leaf', async () => {
    // Arrange
    const { root, rels } = await wideTree();
    const directories = 20 + 20 * 2;
    const { calls, counts } = countingCalls();
    let installs = 0;
    const syscalls = loadDirectorySyscalls();
    const pinner = new PosixSessionRootPinner(
      () => ({
        ...syscalls,
        fchdir: fd => {
          installs += 1;
          return syscalls.fchdir(fd);
        },
      }),
      calls,
    );

    // Act
    const pinned = await pinner.pin(root);
    counts.clear();
    installs = 0;
    const probe = pinned.probe();
    const kinds = await probe.classify(rels);
    await probe.close();
    await pinned.close();

    // Assert: a directory step is one bracket proved by `open('.')` plus the step's own `open`, so two
    // opens per directory is the whole budget. The leaves cost one `lstat` each and the brackets one
    // `lstat('.')` per directory run. The per-file walk this replaced spent about eight opens PER FILE.
    should(kinds.every(kind => kind === 'file')).be.true();
    should(counts.get('open') ?? 0).be.belowOrEqual(2 * directories);
    should(counts.get('lstat') ?? 0).be.belowOrEqual(rels.length + 2 * directories);
    should(installs).be.belowOrEqual(2 * 2 * directories);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0) + installs;
    should(total).be.belowOrEqual(rels.length + 12 * directories);
  });

  it('should spend at least five times fewer calls than walking each name on its own', async () => {
    // Arrange: the same tree, asked both ways, so the bound above is shown to be the improvement it
    // claims rather than a number that happened to fit. Five is a floor for a tree this shallow — five
    // files a directory — and the ratio only grows with files per directory and with depth.
    const { root, rels } = await wideTree();
    const { calls, counts } = countingCalls();
    const pinner = new PosixSessionRootPinner(loadDirectorySyscalls, calls);
    const pinned = await pinner.pin(root);
    const sum = (): number => [...counts.values()].reduce((total, count) => total + count, 0);

    // Act
    counts.clear();
    for (const rel of rels) await (await pinned.open(rel)).close();
    const perName = sum();
    counts.clear();
    const probe = pinned.probe();
    await probe.classify(rels);
    await probe.close();
    const probed = sum();
    await pinned.close();

    // Assert
    should(probed * 5).be.belowOrEqual(perName);
  });
});
