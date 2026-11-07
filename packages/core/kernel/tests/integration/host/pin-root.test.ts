import { afterEach, describe, expect, test } from 'bun:test';
import { constants, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import { NODE_PIN_FILE_CALLS, platformRootPinner } from '../../../host/adapters/pinned/index.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { PinRegistry } from '../../../host/pins.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { scratchPort } from '../../../host/scratch.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-pin-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  await mkdir(`${home}/state/vault`, { recursive: true });
  await mkdir(`${work}/src`, { recursive: true });
  await writeFile(`${work}/src/a.ts`, 'a\n');
  return { parent, home, work };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

function rootOf(home: string, work: string) {
  const pins = new PinRegistry(() => platformRootPinner());
  const roots = rootsPortFor(
    nodeFs(() => 'r'),
    { home, plugin: 'ferrets', worktrees: `${home}-worktrees` },
    ['work'],
    () => workFolders(work),
    pins,
  );
  const root = roots.root('work', { ferret: 'F1' as FerretId });
  const at = (relative: string): FencedPath => {
    const resolved = root.resolve(relative);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
  };
  return { root, at };
}

describe('RootHandle.pin: a held folder inside a declared root', () => {
  test('pins a folder in the root and walks beneath it by descriptor', async () => {
    const { home, work } = await layout();
    const { root, at } = rootOf(home, work);
    const pinned = await root.pin(at(''));
    try {
      expect(pinned.rootReal).toBe(work);
      const file = await pinned.open('src/a.ts');
      expect(new TextDecoder().decode(await file.read(100))).toBe('a\n');
      await file.close();
      expect(typeof pinned.policyCwd).toBe('object');
    } finally {
      await pinned.close();
    }
  });

  test('a folder whose name leads out of the root through a link is refused', async () => {
    const { home, work } = await layout();
    await symlink(`${home}/state`, `${work}/out`);
    const { root, at } = rootOf(home, work);
    await expect(root.pin(at('out'))).rejects.toBeInstanceOf(RootError);
  });

  test('refuseRoot is asked of the object held, at the pin', async () => {
    const { home, work } = await layout();
    const { root, at } = rootOf(home, work);
    await expect(root.pin(at('src'), { refuseRoot: real => real.endsWith('/src') })).rejects.toMatchObject({
      code: 'denied',
    });
  });
});

describe('NODE_PIN_FILE_CALLS (today’s unit test, on the real folder)', () => {
  test('lstat and fstat of one folder give the same exact device and inode', () => {
    const fd = NODE_PIN_FILE_CALLS.open('.', constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const named = NODE_PIN_FILE_CALLS.lstat('.');
      const held = NODE_PIN_FILE_CALLS.fstat(fd);
      expect(typeof named.dev).toBe('bigint');
      expect(typeof held.dev).toBe('bigint');
      expect([named.dev, named.ino]).toEqual([held.dev, held.ino]);
    } finally {
      NODE_PIN_FILE_CALLS.close(fd);
    }
  });
});

describe('kernel.scratch: a private folder removed on close', () => {
  test('0700, exact file modes, a link staged as a link and never written through, gone after close', async () => {
    const scratch = await scratchPort('fy-scratch-test-').open();
    expect((await stat(scratch.path)).mode & 0o777).toBe(0o700);
    await scratch.makeDirectory('a/src');
    await scratch.writeFile('a/src/run.sh', '#!/bin/sh\n', 0o755);
    expect((await stat(`${scratch.path}/a/src/run.sh`)).mode & 0o777).toBe(0o755);
    await scratch.symlink('b', '/etc');
    expect(lstatSync(`${scratch.path}/b`).isSymbolicLink()).toBe(true);
    expect(await readlink(`${scratch.path}/b`)).toBe('/etc');
    await expect(scratch.writeFile('b/passwd', 'x')).rejects.toThrow(TypeError);
    await expect(scratch.writeFile('a/src/run.sh', 'again')).rejects.toThrow();
    await expect(scratch.writeFile('../escape', 'x')).rejects.toThrow(TypeError);
    await scratch.close();
    expect(await Bun.file(scratch.path).exists()).toBe(false);
    await expect(stat(scratch.path)).rejects.toThrow();
  });
});
