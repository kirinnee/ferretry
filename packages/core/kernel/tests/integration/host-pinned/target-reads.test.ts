import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalRel,
  contains,
  direntType,
  leafErrorKind,
  leafKind,
  PosixSessionRootPinner,
  ProcfsSessionRootPinner,
  refusedKind,
  WorkingDirectory,
} from '../../../host/adapters/pinned/index.ts';
import { FsError, type PinnedRoot, type SessionRootPinner, type WorkBudget } from '../../../contract/pinned.ts';
import { bunSpawn } from '../../../host/adapters/process.ts';
import { cleanupTempDirectories, tempDirectory } from './support.ts';

/**
 * What a held directory serves and refuses, against the real kernel, through each pinner the platform has.
 *
 * `read` is the bytes of the descriptor the walk opened, `list` is one level of a held directory with each child
 * described through it, and the refusals say WHY a link is not served. Everything here is a throwaway tree.
 */

afterAll(cleanupTempDirectories);

const PINNERS: readonly (readonly [string, () => SessionRootPinner])[] = [
  ...(process.platform === 'linux'
    ? ([['pinned through a procfs descriptor alias', () => new ProcfsSessionRootPinner()]] as const)
    : []),
  ['pinned through the kernel working directory', () => new PosixSessionRootPinner()],
];

async function tree(label: string): Promise<{ readonly root: string; readonly outside: string }> {
  const root = await tempDirectory(`${label}-root`);
  const outside = await tempDirectory(`${label}-outside`);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'alpha');
  await writeFile(path.join(root, 'src', 'b.ts'), 'bravo!');
  await mkdir(path.join(root, 'src', 'nested'));
  await writeFile(path.join(root, 'src', 'nested', 'deep.ts'), 'deep');
  await symlink('a.ts', path.join(root, 'src', 'inside-link'));
  await symlink('nested', path.join(root, 'src', 'dir-link'));
  await symlink(outside, path.join(root, 'src', 'outside-link'));
  await symlink(path.join(root, 'src', 'gone'), path.join(root, 'src', 'broken-link'));
  const fifo = Bun.spawnSync(['mkfifo', path.join(root, 'src', 'pipe')]);
  expect(fifo.exitCode).toBe(0);
  return { root, outside };
}

async function refusalOf(act: () => Promise<unknown>): Promise<FsError> {
  try {
    await act();
  } catch (error) {
    return error as FsError;
  }
  throw new Error('expected a refusal');
}

async function withPin<Result>(
  pinner: SessionRootPinner,
  root: string,
  act: (pinned: PinnedRoot) => Promise<Result>,
): Promise<Result> {
  const pinned = await pinner.pin(root);
  try {
    return await act(pinned);
  } finally {
    await pinned.close();
  }
}

describe.each(PINNERS)('a file or folder opened through the pin, %s', (_label, pinner) => {
  test('read serves the bytes of the open file, and nothing at all past the cap', async () => {
    const { root } = await tree('read');
    await withPin(pinner(), root, async pinned => {
      const file = await pinned.open('src/a.ts');
      expect(new TextDecoder().decode(await file.read(100))).toBe('alpha');
      expect(await file.read(4)).toBeUndefined();
      await file.close();
    });
  });

  test('read serves what exists when the file was cut short under the open descriptor', async () => {
    const { root } = await tree('read-short');
    await withPin(pinner(), root, async pinned => {
      const file = await pinned.open('src/b.ts');
      await truncate(path.join(root, 'src', 'b.ts'), 2);
      expect(new TextDecoder().decode(await file.read(100))).toBe('br');
      await file.close();
    });
  });

  test('list describes each child through the held directory, and leaves out what no viewer can render', async () => {
    const { root } = await tree('list');
    await withPin(pinner(), root, async pinned => {
      const directory = await pinned.open('src', { wantDirectory: true });
      const listing = await directory.list(50);
      await directory.close();
      expect(listing.truncated).toBe(false);
      const byName = new Map(listing.entries.map(entry => [entry.name, entry]));
      // the fifo is not listed at all
      expect([...byName.keys()].sort()).toEqual([
        'a.ts',
        'b.ts',
        'broken-link',
        'dir-link',
        'inside-link',
        'nested',
        'outside-link',
      ]);
      expect(byName.get('a.ts')).toMatchObject({ type: 'file', size: 5 });
      expect(typeof byName.get('a.ts')?.mtime).toBe('string');
      expect(byName.get('nested')).toMatchObject({ type: 'dir' });
      // a link that stays inside the tree says where it goes, canonically; one that leaves it, or goes nowhere, escapes
      expect(byName.get('inside-link')).toMatchObject({ type: 'symlink', size: 5, target: 'src/a.ts' });
      expect(byName.get('dir-link')).toMatchObject({ type: 'symlink', target: 'src/nested' });
      expect(byName.get('outside-link')).toEqual({ name: 'outside-link', type: 'symlink', escapes: true });
      expect(byName.get('broken-link')).toEqual({ name: 'broken-link', type: 'symlink', escapes: true });
    });
  });

  test('list stops one entry past the cap and says it is truncated', async () => {
    const { root } = await tree('list-cap');
    await withPin(pinner(), root, async pinned => {
      const directory = await pinned.open('src', { wantDirectory: true });
      const listing = await directory.list(2);
      await directory.close();
      expect(listing.entries).toHaveLength(2);
      expect(listing.truncated).toBe(true);
    });
  });

  test('list stops where it stands when the budget runs out, before describing the next child', async () => {
    const { root } = await tree('list-budget');
    await withPin(pinner(), root, async pinned => {
      const directory = await pinned.open('src', { wantDirectory: true });
      let asked = 0;
      const budget: WorkBudget = {
        expired: () => {
          asked += 1;
          return asked > 2;
        },
      };
      const listing = await directory.list(50, budget);
      await directory.close();
      expect(listing.truncated).toBe(true);
      expect(listing.entries).toHaveLength(2);
    });
  });

  test('a link at the leaf is refused, as leaving the tree when it does and as not served when it does not', async () => {
    const { root } = await tree('refusal');
    await withPin(pinner(), root, async pinned => {
      expect((await refusalOf(async () => await pinned.open('src/outside-link'))).code).toBe('escapes_root');
      expect((await refusalOf(async () => await pinned.open('src/inside-link'))).code).toBe('not_a_file');
      const broken = await refusalOf(async () => await pinned.open('src/broken-link'));
      expect(broken.code).toBe('not_a_file');
      expect(broken.message).toContain('src/broken-link');
    });
  });
});

describe('the held directory as a working directory', () => {
  test('a child started in the posix pin lives in the pinned folder, whatever the name now points at', async () => {
    const { root } = await tree('policy-cwd');
    const pinned = await new PosixSessionRootPinner().pin(root);
    try {
      expect(typeof pinned.policyCwd).toBe('object');
      expect((pinned.policyCwd as { describe: string }).describe).toBe(root);
      const child = bunSpawn({ PATH: process.env['PATH'] ?? '/usr/bin:/bin' }).start('pwd', ['-P'], {
        cwd: pinned.policyCwd as never,
      });
      expect((await new Response(child.stdout).text()).trim()).toBe(root);
      expect(await child.exited).toBe(0);
    } finally {
      await pinned.close();
    }
  });
});

describe('a platform that cannot reach the directory calls', () => {
  test('has no working-tree viewer: the first pin is refused as unsupported, every time', async () => {
    const root = await tempDirectory('no-syscalls');
    const pinner = new PosixSessionRootPinner(() => {
      throw new Error('no ffi here');
    });
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect((await refusalOf(async () => await pinner.pin(root))).code).toBe('unsupported');
  });
});

describe('the working directory the pins share', () => {
  test('when it cannot be restored and even / cannot be opened, the process stops rather than run on in a writable folder', () => {
    const written: string[] = [];
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${String(code)}`);
    }) as never);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      const directory = new WorkingDirectory(undefined, () => {
        throw new Error('cannot open /');
      });
      expect(() => directory.restore(() => -1, 3)).toThrow('exit 70');
      expect(written.join('')).toContain(
        'the working directory could not be restored after a folder step, and / could not be opened instead',
      );
      expect(directory.broken).toBe('the working directory could not be restored after a folder step');
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
  });

  test('when / opens but cannot be installed either, the process stops too; when it can be, the failure is only recorded', () => {
    const stops: string[] = [];
    const stop = (reason: string): never => {
      stops.push(reason);
      throw new Error('stopped');
    };
    const refusing = new WorkingDirectory(stop);
    expect(() => refusing.restore(() => -1, 3)).toThrow('stopped');
    expect(stops[0]).toContain('and / could not be installed instead');
    const recovering = new WorkingDirectory(stop);
    const calls: number[] = [];
    expect(
      recovering.restore(fd => {
        calls.push(fd);
        return fd === 3 ? -1 : 0;
      }, 3),
    ).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(3);
    expect(recovering.broken).toBe('the working directory could not be restored after a folder step');
  });
});

describe('the verdict helpers', () => {
  test('canonicalRel is root-relative and slash-joined, and nothing for the root itself', () => {
    expect(canonicalRel('/r', '/r')).toBeUndefined();
    expect(canonicalRel('/r', '/r/a/b')).toBe('a/b');
  });

  test('contains is the root itself or anything under it, not a sibling that shares a prefix', () => {
    expect(contains('/r', '/r')).toBe(true);
    expect(contains('/r', '/r/a')).toBe(true);
    expect(contains('/r', '/r2/a')).toBe(false);
  });

  test('direntType names a link, a folder, a file, and nothing for any other kind', () => {
    const kind = (is: 'l' | 'd' | 'f' | 'o') => ({
      isSymbolicLink: () => is === 'l',
      isDirectory: () => is === 'd',
      isFile: () => is === 'f',
    });
    expect(direntType(kind('l'))).toBe('symlink');
    expect(direntType(kind('d'))).toBe('dir');
    expect(direntType(kind('f'))).toBe('file');
    expect(direntType(kind('o'))).toBeUndefined();
  });

  test('a refusal that says the name holds nothing to read is "unsupported"; any other failure proves nothing', () => {
    expect(refusedKind(new FsError('not_found', 'x'))).toBe('unsupported');
    expect(refusedKind(new FsError('denied', 'x'))).toBe('unreadable');
    expect(refusedKind(new Error('EIO'))).toBe('unreadable');
    expect(leafErrorKind(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('unsupported');
    expect(leafErrorKind(new Error('EIO'))).toBe('unreadable');
    expect(leafKind({ isFile: () => true } as never)).toBe('file');
    expect(leafKind({ isFile: () => false } as never)).toBe('unsupported');
  });
});
