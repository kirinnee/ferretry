/**
 * BG-002 twin parity: the testing host's `RootHandle.remove` answers what the real host answers where no path reaches a
 * held folder (macOS) and the removal goes through the folder's descriptor and the working-directory bracket. The real
 * side here is a REAL `nodeFs` with no `/proc/self/fd`, the real `bun:ffi` binding (`libc.so.6` on this box) and the
 * real `fchdir`, so a plugin's unit test on the twin meets what a Mac does.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { KernelPorts, RootHandle, RootName } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { loadProcessBracket } from '../../../host/adapters/pinned/descriptor-bracket.ts';
import { loadDescriptorCalls } from '../../../host/adapters/pinned/descriptor-calls.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

type Answer = { readonly ok: unknown } | { readonly refused: string };
const answer = async (call: () => unknown): Promise<Answer> => {
  try {
    return { ok: (await call()) ?? null };
  } catch (error) {
    if (error instanceof RootError) return { refused: error.refusal };
    return { refused: 'raised' };
  }
};

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

async function cases(fleet: RootHandle): Promise<readonly (readonly [string, Answer])[]> {
  const dir = (leaf: string) => at(fleet, `homes/claude-a/${leaf}`);
  /** What each file of the fixture reads as now (the twin's `list` is a flat-prefix listing, so a read is the probe). */
  const files = async (): Promise<Answer> => ({
    ok: await Promise.all(
      ['keep', 'victim', 'tree/a', 'tree/deep/b', 'full/x'].map(leaf => answer(() => fleet.readText(dir(leaf)))),
    ),
  });
  const names = files;
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  await fleet.makeDirectory(dir('tree'));
  await fleet.makeDirectory(dir('tree/deep'));
  await fleet.makeDirectory(dir('empty'));
  await fleet.makeDirectory(dir('full'));
  await fleet.writeText(dir('keep'), 'K');
  await fleet.writeText(dir('victim'), 'V');
  await fleet.writeText(dir('tree/a'), 'a');
  await fleet.writeText(dir('tree/deep/b'), 'b');
  await fleet.writeText(dir('full/x'), 'x');
  return [
    ['BG-002 remove a file', await answer(() => fleet.remove(dir('victim')))],
    ['BG-002 its neighbour stays and it is gone', await names()],
    ['BG-002 remove a name that is not there', await answer(() => fleet.remove(dir('absent')))],
    ['BG-002 remove a folder tree', await answer(() => fleet.remove(dir('tree')))],
    ['BG-002 after the tree', await names()],
    ['BG-002 onlyIfEmpty of an empty folder', await answer(() => fleet.remove(dir('empty'), { onlyIfEmpty: true }))],
    [
      'BG-002 onlyIfEmpty of a folder with an entry',
      await answer(() => fleet.remove(dir('full'), { onlyIfEmpty: true })),
    ],
    ['BG-002 the entry is still there', await answer(() => fleet.readText(dir('full/x')))],
    ['BG-002 remove the folder with its entry', await answer(() => fleet.remove(dir('full')))],
    ['BG-002 at the end', await names()],
  ];
}

async function onTestingHost() {
  const seen: { kernel?: KernelPorts } = {};
  const host = await testHost({
    plugins: [
      implementDaemon(
        definePlugin({
          id: 'runtimes',
          title: 'Runtimes',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          permissions: { roots: ['fleet'] },
        }),
        {
          build: ({ kernel }) => {
            seen.kernel = kernel;
            return {};
          },
        },
      ),
    ],
  });
  try {
    return await cases((seen.kernel as KernelPorts).roots.root('fleet'));
  } finally {
    await host.stop();
  }
}

async function onHostWithoutProc() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-bracket-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  const declared: readonly RootName[] = ['fleet'];
  const fs = nodeFs(() => crypto.randomUUID(), {
    descriptorFolder: '/nonexistent-descriptor-folder',
    descriptorCalls: () => loadDescriptorCalls(),
    bracket: () => loadProcessBracket(),
  });
  const port = rootsPortFor(
    fs,
    { home, plugin: 'runtimes', worktrees: `${home}-worktrees` },
    declared,
    () => undefined,
    { setMode: true },
  );
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'runtimes' },
    declared,
  );
  return await cases(port.root('fleet'));
}

test('BG-002 remove of a file, a tree and an empty folder is answered alike by the testing host and a host without /proc that has the bracket', async () => {
  const testing = await onTestingHost();
  const real = await onHostWithoutProc();
  expect(testing.map(([title]) => title)).toEqual(real.map(([title]) => title));
  expect(Object.fromEntries(testing)).toEqual(Object.fromEntries(real));
  // and what both answer is the rule (so parity is not two hosts agreeing on a wrong answer)
  const byCase = Object.fromEntries(real);
  expect(byCase['BG-002 remove a file']).toEqual({ ok: null });
  expect(byCase['BG-002 remove a name that is not there']).toEqual({ ok: null });
  expect(byCase['BG-002 remove a folder tree']).toEqual({ ok: null });
  expect(byCase['BG-002 onlyIfEmpty of a folder with an entry']).toEqual({ refused: 'not_empty' });
  expect(byCase['BG-002 the entry is still there']).toEqual({ ok: 'x' });
  const end = (byCase['BG-002 at the end'] as { ok: Answer[] }).ok;
  expect(end[0]).toEqual({ ok: 'K' });
  for (const gone of end.slice(1)) expect(gone).not.toHaveProperty('ok');
});
