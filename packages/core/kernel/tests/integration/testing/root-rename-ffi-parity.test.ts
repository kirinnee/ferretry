/**
 * BG-001 BG-003 twin parity: the testing host's `rename`, `writeText` and `publish` answer what the real host answers
 * where no path reaches a held folder (macOS) and the descriptor calls do the work. The real side here is a REAL
 * `nodeFs` with no `/proc/self/fd` and the real `bun:ffi` binding (`libc.so.6` on this box), so a plugin's unit test on
 * the twin meets what a Mac does.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { KernelPorts, RootHandle, RootName } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
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
    // the raw error of a missing file or a lost exclusive create reads differently on each host; only that it raised is the rule
    return { refused: 'raised' };
  }
};

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

async function cases(fleet: RootHandle): Promise<readonly (readonly [string, Answer])[]> {
  const dir = (leaf: string) => at(fleet, `homes/claude-a/${leaf}`);
  const text = async (leaf: string) => await answer(() => fleet.readText(dir(leaf)));
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  await fleet.makeDirectory(dir('sub'));
  await fleet.writeText(dir('a'), 'AAA');
  await fleet.writeText(dir('b'), 'BBB');
  await fleet.writeText(dir('sub/inner'), 'inner');
  return [
    ['BG-001 move a file between two folders', await answer(() => fleet.rename(dir('a'), dir('sub/a')))],
    ['BG-001 it is at the new name', await text('sub/a')],
    ['BG-001 and gone from the old one', await text('a')],
    ['BG-001 move it back', await answer(() => fleet.rename(dir('sub/a'), dir('a')))],
    ['BG-001 onto an existing name', await answer(() => fleet.rename(dir('a'), dir('b')))],
    ['BG-001 both stay', { ok: [await text('a'), await text('b')] }],
    ['BG-001 a source that is not there', await answer(() => fleet.rename(dir('none'), dir('c')))],
    ['BG-001 under a folder that is not there', await answer(() => fleet.rename(dir('a'), dir('missing/c')))],
    ['BG-001 a folder moves whole', await answer(() => fleet.rename(dir('sub'), dir('sub2')))],
    ['BG-001 its file came along', await text('sub2/inner')],
    ['BG-001 a folder into itself', await answer(() => fleet.rename(dir('sub2'), dir('sub2/deeper')))],
    ['BG-003 a replacing write over a file', await answer(() => fleet.writeText(dir('a'), 'NEW'))],
    ['BG-003 the file holds the new text', await text('a')],
    [
      'BG-003 an exclusive write onto a taken name',
      await answer(() => fleet.writeText(dir('a'), 'X', { exclusive: true })),
    ],
    ['BG-003 the file was not touched', await text('a')],
    [
      'BG-003 a durable publish of a new name',
      await answer(async () => (await fleet.publish(dir('p'), bytes('P1'))).outcome),
    ],
    [
      'BG-003 an exclusive publish onto the taken name',
      await answer(async () => (await fleet.publish(dir('p'), bytes('P2'), { exclusive: true })).outcome),
    ],
    ['BG-003 the first publish stays', await text('p')],
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
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-rename-ffi-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  const declared: readonly RootName[] = ['fleet'];
  const fs = nodeFs(() => crypto.randomUUID(), {
    descriptorFolder: '/nonexistent-descriptor-folder',
    descriptorCalls: () => loadDescriptorCalls(),
  });
  const port = rootsPortFor(
    fs,
    { home, plugin: 'runtimes', worktrees: `${home}-worktrees` },
    declared,
    () => undefined,
    {
      setMode: true,
    },
  );
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'runtimes' },
    declared,
  );
  return await cases(port.root('fleet'));
}

test('BG-001 BG-003 rename, write and publish are answered alike by the testing host and a host without /proc that has the descriptor calls', async () => {
  const testing = await onTestingHost();
  const real = await onHostWithoutProc();
  expect(testing.map(([title]) => title)).toEqual(real.map(([title]) => title));
  expect(Object.fromEntries(testing)).toEqual(Object.fromEntries(real));
  // and what both answer is the rule (so parity is not two hosts agreeing on a wrong answer)
  const byCase = Object.fromEntries(real);
  expect(byCase['BG-001 move a file between two folders']).toEqual({ ok: null });
  expect(byCase['BG-001 it is at the new name']).toEqual({ ok: 'AAA' });
  expect(byCase['BG-001 onto an existing name']).toEqual({ refused: 'outside' });
  expect(byCase['BG-001 both stay']).toEqual({ ok: [{ ok: 'AAA' }, { ok: 'BBB' }] });
  expect(byCase['BG-001 a source that is not there']).toEqual({ refused: 'outside' });
  expect(byCase['BG-001 under a folder that is not there']).toEqual({ refused: 'changed' });
  expect(byCase['BG-001 a folder into itself']).toEqual({ refused: 'changed' });
  expect(byCase['BG-003 an exclusive write onto a taken name']).toEqual({ refused: 'raised' });
  expect(byCase['BG-003 the file was not touched']).toEqual({ ok: 'NEW' });
  expect(byCase['BG-003 an exclusive publish onto the taken name']).toEqual({ ok: 'exists' });
});
