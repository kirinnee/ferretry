/**
 * The testing host's `RootHandle.remove` stays in step with the real host's: the leaf is never followed (a link goes as
 * a link, its target stays), `onlyIfEmpty` is `rmdir`, and every refusal carries the same code on both. The real host is
 * booted for real (its own roots on the disk); each case is spelled with that host's own paths.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { KernelPorts, RootHandle } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { RootError } from '../../../host/roots.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const CREDENTIAL = '{"planted":"credential"}\n';

interface Seen {
  runtimes?: KernelPorts;
}

const halves = (seen: Seen) => [
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtimes',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['fleet', 'harness-home', 'downloads'] },
    }),
    {
      build: ({ kernel }) => {
        seen.runtimes = kernel;
        return {};
      },
    },
  ),
];

type Answer = { readonly ok: unknown } | { readonly refused: string };
const answer = async (call: () => unknown): Promise<Answer> => {
  try {
    return { ok: (await call()) ?? null };
  } catch (error) {
    if (error instanceof RootError) return { refused: error.refusal };
    return { refused: `unexpected: ${(error as Error).message}` };
  }
};

interface Places {
  readonly owner: string;
  /** Puts a file in the harness home, as that host's world holds one. */
  readonly seedHarness: (leaf: string, text: string) => Promise<void>;
}

async function cases(seen: Seen, places: Places): Promise<readonly (readonly [string, Answer])[]> {
  const runtimes = seen.runtimes as KernelPorts;
  const at = (root: RootHandle, path: string): FencedPath => {
    const resolved = root.resolve(path);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
  };
  const fleet = runtimes.roots.root('fleet');
  const harness = runtimes.roots.root('harness-home', { subfolder: `${places.owner}/.claude` });
  const downloads = runtimes.roots.root('downloads');
  await places.seedHarness('.credentials.json', CREDENTIAL);
  const credential = { root: harness, path: at(harness, '.credentials.json') };
  const kindAt = async (path: FencedPath) => (await fleet.lstat(path))?.kind ?? null;
  const dir = (leaf: string) => at(fleet, `homes/claude-a/${leaf}`);
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  await fleet.writeText(dir('a.txt'), 'a');
  await fleet.writeText(dir('b.txt'), 'b');
  await fleet.writeText(dir('nested/deep.txt'), 'deep');
  await fleet.makeDirectory(dir('empty'));
  await fleet.makeDirectory(dir('empty-too'));
  await fleet.makeDirectory(dir('holds-empty'));
  await fleet.makeDirectory(dir('holds-empty/inner'));
  await fleet.writeText(dir('full/one.txt'), 'one');
  await fleet.writeText(dir('tree/deep/x.txt'), 'x');
  await fleet.makeDirectory(dir('holds-link'));
  await fleet.linkTo(dir('holds-link/only.json'), credential);
  return [
    ['remove a file', await answer(() => fleet.remove(dir('a.txt')))],
    ['the file is gone', { ok: await kindAt(dir('a.txt')) }],
    ['its neighbour stays', { ok: await kindAt(dir('b.txt')) }],
    ['remove a name that is not there', await answer(() => fleet.remove(dir('absent.txt')))],
    [
      'remove a file with onlyIfEmpty, as without it',
      await answer(() => fleet.remove(dir('b.txt'), { onlyIfEmpty: true })),
    ],
    ['that file is gone', { ok: await kindAt(dir('b.txt')) }],

    // a link at the leaf goes as a link; what it points at stays
    ['link to a file outside the root', await answer(() => fleet.linkTo(dir('out-link'), credential))],
    ['remove the link to an outside file', await answer(() => fleet.remove(dir('out-link')))],
    ['the outside link is gone', { ok: await kindAt(dir('out-link')) }],
    ['the outside file survived', await answer(() => harness.readText(credential.path))],
    [
      'link to a missing outside file, dangling',
      await answer(() =>
        fleet.linkTo(dir('dangling'), { root: harness, path: at(harness, 'missing.json'), dangling: true }),
      ),
    ],
    ['remove the dangling link', await answer(() => fleet.remove(dir('dangling')))],
    ['the dangling link is gone', { ok: await kindAt(dir('dangling')) }],
    [
      'link to a file inside the root',
      await answer(() => fleet.linkTo(dir('in-link'), { root: fleet, path: dir('nested/deep.txt') })),
    ],
    ['remove the link to an inside file', await answer(() => fleet.remove(dir('in-link')))],
    ['the inside link is gone', { ok: await kindAt(dir('in-link')) }],
    ['the inside file survived', await answer(() => fleet.readText(dir('nested/deep.txt')))],
    [
      'link to a folder inside the root',
      await answer(() => fleet.linkTo(dir('alias'), { root: fleet, path: dir('nested') })),
    ],
    ['remove the link to an inside folder', await answer(() => fleet.remove(dir('alias')))],
    ['the folder link is gone', { ok: await kindAt(dir('alias')) }],
    ['the folder it pointed at kept its file', await answer(() => fleet.readText(dir('nested/deep.txt')))],
    [
      'link to an EMPTY folder inside the root',
      await answer(() => fleet.linkTo(dir('alias-empty'), { root: fleet, path: dir('empty-too') })),
    ],
    [
      'remove the link to an empty folder with onlyIfEmpty',
      await answer(() => fleet.remove(dir('alias-empty'), { onlyIfEmpty: true })),
    ],
    ['the empty-folder link is gone', { ok: await kindAt(dir('alias-empty')) }],
    ['the empty folder it pointed at stays a folder', { ok: await kindAt(dir('empty-too')) }],

    // onlyIfEmpty is rmdir
    ['onlyIfEmpty on an empty folder', await answer(() => fleet.remove(dir('empty'), { onlyIfEmpty: true }))],
    ['the empty folder is gone', { ok: await kindAt(dir('empty')) }],
    ['onlyIfEmpty on a folder with a file', await answer(() => fleet.remove(dir('full'), { onlyIfEmpty: true }))],
    ['the file is still there', await answer(() => fleet.readText(dir('full/one.txt')))],
    [
      'onlyIfEmpty on a folder holding only a link',
      await answer(() => fleet.remove(dir('holds-link'), { onlyIfEmpty: true })),
    ],
    ['the only link is still there', { ok: await kindAt(dir('holds-link/only.json')) }],
    [
      'onlyIfEmpty on a folder holding only an empty folder',
      await answer(() => fleet.remove(dir('holds-empty'), { onlyIfEmpty: true })),
    ],
    ['the inner folder is still there', { ok: await kindAt(dir('holds-empty/inner')) }],
    ['onlyIfEmpty on a name that is not there', await answer(() => fleet.remove(dir('absent'), { onlyIfEmpty: true }))],
    ['onlyIfEmpty false removes a whole tree', await answer(() => fleet.remove(dir('tree'), { onlyIfEmpty: false }))],
    ['the tree is gone', { ok: await kindAt(dir('tree')) }],
    ['no option removes a whole tree', await answer(() => fleet.remove(dir('full')))],
    ['the full folder is gone', { ok: await kindAt(dir('full')) }],

    // the refusals
    ['remove on a read-only root', await answer(() => harness.remove(credential.path))],
    ['the read-only file stays', await answer(() => harness.readText(credential.path))],
    [
      'link to a folder, for the through-a-link row',
      await answer(() => fleet.linkTo(dir('route'), { root: fleet, path: dir('holds-link') })),
    ],
    ['remove through a link to a folder inside the root', await answer(() => fleet.remove(dir('route/only.json')))],
    ['the entry behind that link is gone', { ok: await kindAt(dir('holds-link/only.json')) }],
    ['remove under a folder that is not there', await answer(() => fleet.remove(dir('nope/x.txt')))],
    // followups row 173 (7.7): a parent that is a FILE used as a folder is `changed`, and the file stays
    ['remove under a file used as a folder', await answer(() => fleet.remove(dir('nested/deep.txt/x')))],
    ['the file used as a folder stays', await answer(() => fleet.readText(dir('nested/deep.txt')))],
    ['remove with ..', await answer(() => fleet.remove(`${dir('nested')}/../x` as FencedPath))],
    ['remove a path of another root', await answer(() => fleet.remove(at(downloads, 'a.txt')))],
    // BG-015 m3: a link on the way that LEAVES the root is judged link_escape, and what it points at is untouched
    ['BG-015 a folder outside the fleet', await answer(() => downloads.makeDirectory(at(downloads, 'away')))],
    ['BG-015 its file', await answer(() => downloads.writeText(at(downloads, 'away/keep.txt'), 'KEPT'))],
    [
      'BG-015 link to the outside folder',
      await answer(() => fleet.linkTo(dir('esc'), { root: downloads, path: at(downloads, 'away') })),
    ],
    ['BG-015 remove through a link that leaves the root', await answer(() => fleet.remove(dir('esc/keep.txt')))],
    [
      'BG-015 onlyIfEmpty through a link that leaves the root',
      await answer(() => fleet.remove(dir('esc/keep.txt'), { onlyIfEmpty: true })),
    ],
    ['BG-015 the outside file survived', await answer(() => downloads.readText(at(downloads, 'away/keep.txt')))],

    // BG-006: a forged spelling names the same leaf as its plain form; a NUL is outside, on both hosts
    [
      'BG-006 link to a folder, for the forged-spelling rows',
      await answer(() => fleet.linkTo(dir('alias2'), { root: fleet, path: dir('nested') })),
    ],
    ['BG-006 remove with a trailing slash', await answer(() => fleet.remove(`${dir('alias2')}/` as FencedPath))],
    ['BG-006 the link went, not the folder', { ok: await kindAt(dir('alias2')) }],
    ['BG-006 the folder it pointed at kept its file', await answer(() => fleet.readText(dir('nested/deep.txt')))],
    [
      'BG-006 link again, for the trailing-dot row',
      await answer(() => fleet.linkTo(dir('alias3'), { root: fleet, path: dir('nested') })),
    ],
    ['BG-006 remove with a trailing dot', await answer(() => fleet.remove(`${dir('alias3')}/.` as FencedPath))],
    ['BG-006 the second link went', { ok: await kindAt(dir('alias3')) }],
    ['BG-006 the folder still has its file', await answer(() => fleet.readText(dir('nested/deep.txt')))],
    [
      'BG-006 link at the root, for the relative-name row',
      await answer(() => fleet.linkTo(at(fleet, 'top-alias'), { root: fleet, path: dir('nested') })),
    ],
    ['BG-006 remove a single relative name', await answer(() => fleet.remove('top-alias' as FencedPath))],
    ['BG-006 the top link went', { ok: await kindAt(at(fleet, 'top-alias')) }],
    ['BG-006 the folder still has its file again', await answer(() => fleet.readText(dir('nested/deep.txt')))],
    [
      'BG-006 remove with a NUL in the leaf',
      await answer(() => fleet.remove(`${dir('nested')}/de\0ep.txt` as FencedPath)),
    ],
    [
      'BG-006 remove with a NUL in the parent',
      await answer(() => fleet.remove(`${at(fleet, 'homes/claude-a')}/nes\0ted/deep.txt` as FencedPath)),
    ],
    ['BG-006 the file survived the NUL asks', await answer(() => fleet.readText(dir('nested/deep.txt')))],

    // BG-015 m4: the root itself is a folder like any other (LAST: it takes the whole root with it)
    [
      'BG-015 onlyIfEmpty on a root that holds entries',
      await answer(() => fleet.remove(at(fleet, '.'), { onlyIfEmpty: true })),
    ],
    ['BG-015 the root kept its file', await answer(() => fleet.readText(dir('nested/deep.txt')))],
    ['BG-015 remove the root itself', await answer(() => fleet.remove(at(fleet, '.')))],
  ];
}

async function onTestingHost() {
  const seen: Seen = {};
  const owner = '/home/owner';
  const host = await testHost({ plugins: halves(seen), ownerHome: owner, fenceHome: '/home/owner/.test-home' });
  try {
    return await cases(seen, {
      owner,
      seedHarness: async (leaf, text) => host.putRoot('harness-home', leaf, text),
    });
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-parity-`));
  parents.push(parent);
  const owner = `${parent}/owner`;
  const home = `${owner}/.test-home`;
  await mkdir(`${owner}/.claude`, { recursive: true, mode: 0o700 });
  const seen: Seen = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: halves(seen),
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    return await cases(seen, {
      owner,
      seedHarness: async (leaf, text) => await writeFile(`${owner}/.claude/${leaf}`, text, { mode: 0o600 }),
    });
  } finally {
    await outcome.host.stop();
  }
}

// a folder remove needs descriptor reach, which only a host with /proc/self/fd has (macOS refuses it, S44)
test.skipIf(process.platform !== 'linux')(
  'remove parity: the leaf is never followed and onlyIfEmpty is rmdir, answered alike on both hosts',
  async () => {
    const testing = await onTestingHost();
    const real = await onRealHost();
    expect(testing.map(([title]) => title)).toEqual(real.map(([title]) => title));
    expect(Object.fromEntries(testing)).toEqual(Object.fromEntries(real));
    // and what both answer is the rule (so parity is not two hosts agreeing on a wrong answer)
    const byCase = Object.fromEntries(real);
    expect(byCase['remove a file']).toEqual({ ok: null });
    expect(byCase['the file is gone']).toEqual({ ok: null });
    expect(byCase['its neighbour stays']).toEqual({ ok: 'file' });
    expect(byCase['remove a name that is not there']).toEqual({ ok: null });
    expect(byCase['remove the link to an outside file']).toEqual({ ok: null });
    expect(byCase['the outside link is gone']).toEqual({ ok: null });
    expect(byCase['the outside file survived']).toEqual({ ok: CREDENTIAL });
    expect(byCase['the dangling link is gone']).toEqual({ ok: null });
    expect(byCase['the inside link is gone']).toEqual({ ok: null });
    expect(byCase['the inside file survived']).toEqual({ ok: 'deep' });
    expect(byCase['the folder link is gone']).toEqual({ ok: null });
    expect(byCase['the folder it pointed at kept its file']).toEqual({ ok: 'deep' });
    expect(byCase['remove the link to an empty folder with onlyIfEmpty']).toEqual({ ok: null });
    expect(byCase['the empty-folder link is gone']).toEqual({ ok: null });
    expect(byCase['the empty folder it pointed at stays a folder']).toEqual({ ok: 'directory' });
    expect(byCase['onlyIfEmpty on an empty folder']).toEqual({ ok: null });
    expect(byCase['the empty folder is gone']).toEqual({ ok: null });
    expect(byCase['onlyIfEmpty on a folder with a file']).toEqual({ refused: 'not_empty' });
    expect(byCase['the file is still there']).toEqual({ ok: 'one' });
    expect(byCase['onlyIfEmpty on a folder holding only a link']).toEqual({ refused: 'not_empty' });
    expect(byCase['the only link is still there']).toEqual({ ok: 'symlink' });
    expect(byCase['onlyIfEmpty on a folder holding only an empty folder']).toEqual({ refused: 'not_empty' });
    expect(byCase['the inner folder is still there']).toEqual({ ok: 'directory' });
    expect(byCase['onlyIfEmpty on a name that is not there']).toEqual({ ok: null });
    expect(byCase['the tree is gone']).toEqual({ ok: null });
    expect(byCase['the full folder is gone']).toEqual({ ok: null });
    expect(byCase['remove on a read-only root']).toEqual({ refused: 'read_only' });
    expect(byCase['remove through a link to a folder inside the root']).toEqual({ ok: null });
    expect(byCase['the entry behind that link is gone']).toEqual({ ok: null });
    expect(byCase['remove under a folder that is not there']).toEqual({ refused: 'changed' });
    expect(byCase['remove under a file used as a folder']).toEqual({ refused: 'changed' });
    expect(byCase['the file used as a folder stays']).toEqual({ ok: 'deep' });
    expect(byCase['remove with ..']).toEqual({ refused: 'outside' });
    expect(byCase['remove a path of another root']).toEqual({ refused: 'outside' });
    // BG-006: a forged spelling removes the LINK and never the folder behind it; a NUL is outside on both hosts
    expect(byCase['BG-006 remove with a trailing slash']).toEqual({ ok: null });
    expect(byCase['BG-006 the link went, not the folder']).toEqual({ ok: null });
    expect(byCase['BG-006 the folder it pointed at kept its file']).toEqual({ ok: 'deep' });
    expect(byCase['BG-006 remove with a trailing dot']).toEqual({ ok: null });
    expect(byCase['BG-006 the second link went']).toEqual({ ok: null });
    expect(byCase['BG-006 the folder still has its file']).toEqual({ ok: 'deep' });
    expect(byCase['BG-006 remove a single relative name']).toEqual({ ok: null });
    expect(byCase['BG-006 the top link went']).toEqual({ ok: null });
    expect(byCase['BG-006 the folder still has its file again']).toEqual({ ok: 'deep' });
    expect(byCase['BG-006 remove with a NUL in the leaf']).toEqual({ refused: 'outside' });
    expect(byCase['BG-006 remove with a NUL in the parent']).toEqual({ refused: 'outside' });
    expect(byCase['BG-006 the file survived the NUL asks']).toEqual({ ok: 'deep' });
    // BG-015: a link that leaves the root is judged on the way, and the root itself is a folder like any other
    expect(byCase['BG-015 remove through a link that leaves the root']).toEqual({ refused: 'link_escape' });
    expect(byCase['BG-015 onlyIfEmpty through a link that leaves the root']).toEqual({ refused: 'link_escape' });
    expect(byCase['BG-015 the outside file survived']).toEqual({ ok: 'KEPT' });
    expect(byCase['BG-015 onlyIfEmpty on a root that holds entries']).toEqual({ refused: 'not_empty' });
    expect(byCase['BG-015 the root kept its file']).toEqual({ ok: 'deep' });
    expect(byCase['BG-015 remove the root itself']).toEqual({ ok: null });
  },
);

// the flat test world has no base folder to be left missing, so what is left after the root went is only seen here
test('remove: the testing host takes every entry of the root with the root itself', async () => {
  const seen: Seen = {};
  const host = await testHost({ plugins: halves(seen), ownerHome: '/home/owner', fenceHome: '/home/owner/.test-home' });
  try {
    const fleet = (seen.runtimes as KernelPorts).roots.root('fleet');
    const named = (path: string): FencedPath => {
      const resolved = fleet.resolve(path);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.value;
    };
    await fleet.writeText(named('homes/a/one.txt'), 'one');
    await fleet.makeDirectory(named('homes/empty'));
    await fleet.remove(named('.'));
    expect(await fleet.list(named('homes'))).toEqual([]);
    expect(await fleet.lstat(named('homes/a/one.txt'))).toBeUndefined();
    expect(await fleet.lstat(named('homes/empty'))).toBeUndefined();
  } finally {
    await host.stop();
  }
});
