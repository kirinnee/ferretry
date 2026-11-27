import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kernelWorkingTree } from '../../daemon/lib/git-bundle.ts';
import { git, makeRepository, realKernel } from '../support/real-git.ts';

describe('the working tree, through real git', () => {
  test('head names the commit and the branch; a detached HEAD has no branch; a folder that is no work tree has none', async () => {
    const { folder } = makeRepository();
    const tree = kernelWorkingTree(realKernel(), folder);
    const head = await tree.head();
    expect(head?.branch).toBe('main');
    expect(head?.head).toMatch(/^[0-9a-f]{40,64}$/u);
    git(folder, 'checkout', '-q', '--detach');
    expect((await tree.head())?.branch).toBeUndefined();
    const plain = mkdtempSync(join(tmpdir(), 'relocate-plain-'));
    expect(await kernelWorkingTree(realKernel(), plain).head()).toBeUndefined();
  });

  test('a commit the remote already has makes no bundle, and a diff of a clean tree is empty', async () => {
    const { folder } = makeRepository();
    git(folder, 'push', '-q', 'origin', 'main');
    git(folder, 'checkout', '-q', '--', '.');
    const tree = kernelWorkingTree(realKernel(), folder);
    expect(await tree.commits(1024 * 1024)).toBeUndefined();
    expect((await tree.changes(1024 * 1024)).length).toBe(0);
  });

  test('an output larger than the move allows is refused, never cut', async () => {
    const { folder } = makeRepository();
    const tree = kernelWorkingTree(realKernel(), folder);
    await expect(tree.changes(10)).rejects.toThrow('larger than a move can carry');
    await expect(tree.commits(10)).rejects.toThrow('larger than a move can carry');
  });

  test('git failing on a folder that is no work tree is a sentence, not a crash', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'relocate-plain-'));
    await expect(kernelWorkingTree(realKernel(), plain).untracked()).rejects.toThrow('could not read');
  });

  test('read answers plain files only: a link, a second hard link, an oversize file and a ".." path are not read', async () => {
    const { folder } = makeRepository();
    const outside = join(mkdtempSync(join(tmpdir(), 'relocate-out-')), 'outside.txt');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(folder, 'link.txt'));
    linkSync(join(folder, 'new.txt'), join(folder, 'hard.txt'));
    mkdirSync(join(folder, 'dir'));
    writeFileSync(join(folder, 'big.txt'), 'x'.repeat(100));
    const tree = kernelWorkingTree(realKernel(), folder);
    expect(new TextDecoder().decode(await tree.read('tracked.txt', 1024))).toContain('changed');
    expect(await tree.read('link.txt', 1024)).toBeUndefined();
    expect(await tree.read('new.txt', 1024)).toBeUndefined();
    expect(await tree.read('dir', 1024)).toBeUndefined();
    expect(await tree.read('big.txt', 10)).toBeUndefined();
    expect(await tree.read('../outside.txt', 1024)).toBeUndefined();
    expect(await tree.read('missing.txt', 1024)).toBeUndefined();
  });
});
