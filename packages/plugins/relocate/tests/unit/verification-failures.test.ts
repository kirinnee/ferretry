import { expect, test } from 'bun:test';
import { mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnBytesResult } from '@ferretry/kernel/contract';
import { RELOCATE_MAX_FILE_BYTES } from '../../contract/index.ts';
import { kernelWorkingTree, type WorkingTree } from '../../daemon/lib/git-bundle.ts';
import { assertSnapshotSize, gather, plan } from '../../daemon/lib/snapshot.ts';
import { fakeSource, summaryOf } from '../support/fake-ferrets.ts';
import { git, makeRepository, realKernel } from '../support/real-git.ts';

const failed = (stderr: string): SpawnBytesResult => ({
  exitCode: 128,
  stdout: new Uint8Array(),
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
});

test('an unreadable global ignore configuration refuses the listing rather than exposing excluded files', async () => {
  const { folder } = makeRepository();
  const kernel = realKernel();
  const run = kernel.spawn.runBytes;
  kernel.spawn.runBytes = async (program, args, options) =>
    args.includes('--global')
      ? failed('permission denied reading synthetic global config')
      : await run(program, args, options);
  await expect(kernelWorkingTree(kernel, folder).untracked()).rejects.toThrow('ignore rules');
});

test('an unborn repository is refused instead of silently losing its untracked working files', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'relocate-unborn-'));
  git(folder, 'init', '-q');
  writeFileSync(join(folder, 'new.txt'), 'synthetic work');
  await expect(kernelWorkingTree(realKernel(), folder).head()).rejects.toThrow('could not read');
});

test('a Git answer pointing at a different repository is refused', async () => {
  const { folder } = makeRepository();
  const kernel = realKernel();
  const run = kernel.spawn.runBytes;
  kernel.spawn.runBytes = async (program, args, options) => {
    const done = await run(program, args, options);
    return args.includes('--show-toplevel')
      ? { ...done, stdout: new TextEncoder().encode('/synthetic-other-repository\n') }
      : done;
  };
  await expect(kernelWorkingTree(kernel, folder).head()).rejects.toThrow('different working tree');
});

test('a failed branch lookup is refused instead of being called a detached HEAD', async () => {
  const { folder } = makeRepository();
  const kernel = realKernel();
  const run = kernel.spawn.runBytes;
  kernel.spawn.runBytes = async (program, args, options) =>
    args.includes('symbolic-ref') ? failed('synthetic damaged reference') : await run(program, args, options);
  await expect(kernelWorkingTree(kernel, folder).head()).rejects.toThrow('branch');
});

test('a commit added after the audit cannot enter the outgoing bundle unchecked', async () => {
  const { folder } = makeRepository();
  const kernel = realKernel();
  const run = kernel.spawn.runBytes;
  kernel.spawn.runBytes = async (program, args, options) => {
    if (args.includes('bundle')) {
      writeFileSync(join(folder, 'late.txt'), 'synthetic late work');
      git(folder, 'add', 'late.txt');
      git(folder, 'commit', '-qm', 'late commit');
    }
    return await run(program, args, options);
  };
  await expect(kernelWorkingTree(kernel, folder).commits(1024 * 1024)).rejects.toThrow('changed during');
});

test('a tracked file changed to a link after the audit cannot enter the diff', async () => {
  const { folder } = makeRepository();
  const kernel = realKernel();
  const run = kernel.spawn.runBytes;
  kernel.spawn.runBytes = async (program, args, options) => {
    if (args.includes('diff')) {
      unlinkSync(join(folder, 'tracked.txt'));
      symlinkSync('README.md', join(folder, 'tracked.txt'));
    }
    return await run(program, args, options);
  };
  await expect(kernelWorkingTree(kernel, folder).changes(1024 * 1024)).rejects.toThrow('became a link');
});

test('an oversize conversation refuses before listing or reading any more of the source', async () => {
  const source = {
    ...fakeSource({
      conversation: {
        ok: true,
        value: { relPath: 'synthetic.jsonl', bytes: new Uint8Array(RELOCATE_MAX_FILE_BYTES + 1) },
      },
    }),
    files: async () => {
      throw new Error('must not list after refusing');
    },
  };
  const found = await plan({ source, summary: summaryOf('idle'), tree: undefined });
  expect(found.refusals).toEqual(['the conversation is larger than one file of a move can be']);
});

test('HEAD changing after the working files were gathered refuses the snapshot', async () => {
  let heads = 0;
  const tree: WorkingTree = {
    remote: async () => undefined,
    head: async () => ({ head: (++heads < 3 ? 'a' : 'b').repeat(40) }),
    commits: async () => undefined,
    changes: async () => new Uint8Array(),
    untracked: async () => [],
    ignoredTopLevel: async () => [],
    size: async () => undefined,
    read: async () => undefined,
  };
  const inputs = { source: fakeSource(), summary: summaryOf('stopped'), tree };
  const found = await plan(inputs);
  await expect(gather(inputs, found)).rejects.toThrow('changed during');
});

test('the final per-file cap also rejects a source that outgrows its measured size', () => {
  expect(() =>
    assertSnapshotSize([
      { kind: 'session', path: 'attachments/grown.bin', bytes: new Uint8Array(RELOCATE_MAX_FILE_BYTES + 1) },
    ]),
  ).toThrow('attachments/grown.bin');
});
