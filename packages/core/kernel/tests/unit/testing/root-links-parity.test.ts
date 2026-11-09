/**
 * The testing host's `linkTo`, `setMode` and `harnessFile` stay in step with the real host's: the same rules
 * (`host/root-rules.ts`) decide both, with the same refusals, so a plugin's unit test meets what production does. The
 * real host is booted for real (its own roots on the disk); each case is spelled with that host's own paths.
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
const CLAUDE_JSON = '{"mcpServers":{}}\n';

interface Seen {
  runtimes?: KernelPorts;
  stranger?: KernelPorts;
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
      permissions: { roots: ['fleet', 'harness-home', 'downloads'], harnessFiles: ['.claude.json'], setMode: true },
    }),
    {
      build: ({ kernel }) => {
        seen.runtimes = kernel;
        return {};
      },
    },
  ),
  implementDaemon(
    definePlugin({
      id: 'stranger',
      title: 'Stranger',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { roots: ['downloads', 'harness-home', 'agent-homes'], harnessFiles: ['*', '.claude.json'] },
    }),
    {
      build: ({ kernel }) => {
        seen.stranger = kernel;
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

/** The paths one host spells: the owner's home (beside the harness home) and the kernel's home (the fence). */
interface Places {
  readonly owner: string;
  readonly home: string;
  /** Puts a file in the harness home, as that host's world holds one. */
  readonly seedHarness: (leaf: string, text: string) => Promise<void>;
}

async function cases(seen: Seen, places: Places): Promise<readonly (readonly [string, Answer])[]> {
  const runtimes = seen.runtimes as KernelPorts;
  const stranger = seen.stranger as KernelPorts;
  const at = (root: RootHandle, path: string): FencedPath => {
    const resolved = root.resolve(path);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
  };
  const fleet = runtimes.roots.root('fleet');
  const harness = runtimes.roots.root('harness-home', { subfolder: `${places.owner}/.claude` });
  const downloads = runtimes.roots.root('downloads');
  const theirs = stranger.roots.root('downloads');
  await places.seedHarness('.credentials.json', CREDENTIAL);
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  await fleet.writeText(at(fleet, 'homes/claude-a/settings.json'), '{}');
  await theirs.writeText(at(theirs, 'theirs.txt'), 'theirs');
  const credential = { root: harness, path: at(harness, '.credentials.json') };
  const place = at(fleet, 'homes/claude-a/.credentials.json');
  const settings = at(fleet, 'homes/claude-a/settings.json');
  const kindAt = async (path: FencedPath) => (await fleet.lstat(path))?.kind ?? null;
  const modeAt = async (path: FencedPath) => (await fleet.stat(path))?.mode ?? null;
  const theirFleet = stranger.roots.root('agent-homes', { subfolder: 'other' });
  await theirFleet.writeText(at(theirFleet, 'f.txt'), 'x');
  const claudeJson = `${places.owner}/.claude.json`;
  return [
    ['linkTo a harness credential into fleet', await answer(() => fleet.linkTo(place, credential))],
    ['the name is now a link', { ok: await kindAt(place) }],
    ['linkTo again at the same name', await answer(() => fleet.linkTo(place, credential))],
    [
      'linkTo a missing target',
      await answer(() =>
        fleet.linkTo(at(fleet, 'homes/claude-a/empty.json'), { root: harness, path: at(harness, 'empty.json') }),
      ),
    ],
    [
      'linkTo a missing target, dangling',
      await answer(() =>
        fleet.linkTo(at(fleet, 'homes/claude-a/empty.json'), {
          root: harness,
          path: at(harness, 'empty.json'),
          dangling: true,
        }),
      ),
    ],
    ['linkTo into a read-only root', await answer(() => harness.linkTo(at(harness, 'x.json'), credential))],
    ['linkTo into downloads', await answer(() => downloads.linkTo(at(downloads, 'x.json'), credential))],
    [
      'linkTo from a look-alike handle',
      await answer(() => fleet.linkTo(at(fleet, 'homes/claude-a/y'), { ...credential, root: { ...harness } })),
    ],
    [
      'linkTo from another plugin’s handle',
      await answer(() => fleet.linkTo(at(fleet, 'homes/claude-a/y'), { root: theirs, path: at(theirs, 'theirs.txt') })),
    ],
    ['setMode 0o755 on fleet', await answer(() => fleet.setMode(settings, 0o755))],
    ['its mode', { ok: await modeAt(settings) }],
    ['setMode 0o6644 on fleet', await answer(() => fleet.setMode(settings, 0o6644))],
    ['its mode again', { ok: await modeAt(settings) }],
    ['setMode on a read-only root', await answer(() => harness.setMode(credential.path, 0o600))],
    ['setMode with a mode out of range', await answer(() => fleet.setMode(settings, 0o10000))],
    ['setMode on a missing name', await answer(() => fleet.setMode(at(fleet, 'homes/claude-a/none'), 0o600))],
    [
      'setMode by a plugin that did not declare it',
      await answer(() => theirFleet.setMode(at(theirFleet, 'f.txt'), 0o600)),
    ],
    ['setMode on a link', await answer(() => fleet.setMode(place, 0o600))],
    ['rename a file', await answer(() => fleet.rename(settings, at(fleet, 'homes/claude-a/settings.aside')))],
    ['the old name is gone', { ok: await kindAt(settings) }],
    ['the new name is a file', { ok: await kindAt(at(fleet, 'homes/claude-a/settings.aside')) }],
    ['rename it back', await answer(() => fleet.rename(at(fleet, 'homes/claude-a/settings.aside'), settings))],
    [
      'rename a link, it stays a link',
      await answer(() => fleet.rename(place, at(fleet, 'homes/claude-a/linked.aside'))),
    ],
    ['the moved name is a link', { ok: await kindAt(at(fleet, 'homes/claude-a/linked.aside')) }],
    ['the old link name is gone', { ok: await kindAt(place) }],
    // a mode that is NOT the default (0o600), so a move that drops the mode is seen
    ['setMode 0o400 before the folder move', await answer(() => fleet.setMode(settings, 0o400))],
    ['rename a folder', await answer(() => fleet.rename(at(fleet, 'homes/claude-a'), at(fleet, 'homes/claude-b')))],
    ['the folder’s file moved with it', { ok: await kindAt(at(fleet, 'homes/claude-b/settings.json')) }],
    // asked WHILE the folder sits at its new name: moving it back would hide a link left behind
    ['link inside a moved folder is at the new place', { ok: await kindAt(at(fleet, 'homes/claude-b/linked.aside')) }],
    [
      'link inside a moved folder is gone from the old place',
      { ok: await kindAt(at(fleet, 'homes/claude-a/linked.aside')) },
    ],
    ['the moved file keeps its mode', { ok: await modeAt(at(fleet, 'homes/claude-b/settings.json')) }],
    [
      'rename it back, folder',
      await answer(() => fleet.rename(at(fleet, 'homes/claude-b'), at(fleet, 'homes/claude-a'))),
    ],
    ['make a folder to hold only a link', await answer(() => fleet.makeDirectory(at(fleet, 'homes/claude-c')))],
    ['linkTo inside it', await answer(() => fleet.linkTo(at(fleet, 'homes/claude-c/only.json'), credential))],
    // a folder that holds only a link is a folder to every reader, as it is to the move
    ['lstat a folder holding only a link', { ok: await kindAt(at(fleet, 'homes/claude-c')) }],
    [
      'realPath a folder holding only a link',
      await answer(async () => (await fleet.realPath(at(fleet, 'homes/claude-c'))) !== undefined),
    ],
    ['list a folder holding only a link', await answer(() => fleet.list(at(fleet, 'homes/claude-c')))],
    [
      'entries of a folder holding only a link',
      await answer(async () => (await fleet.entries(at(fleet, 'homes/claude-c'))).map(item => [item.name, item.kind])),
    ],
    [
      'rename a folder holding only a link',
      await answer(() => fleet.rename(at(fleet, 'homes/claude-c'), at(fleet, 'homes/claude-d'))),
    ],
    ['the only link is at the new place', { ok: await kindAt(at(fleet, 'homes/claude-d/only.json')) }],
    ['the only link is gone from the old place', { ok: await kindAt(at(fleet, 'homes/claude-c/only.json')) }],
    [
      'rename onto an existing name',
      await answer(() => fleet.rename(settings, at(fleet, 'homes/claude-a/linked.aside'))),
    ],
    [
      'rename a missing name',
      await answer(() => fleet.rename(at(fleet, 'homes/claude-a/none'), at(fleet, 'homes/claude-a/x'))),
    ],
    ['rename to the same name', await answer(() => fleet.rename(settings, settings))],
    ['rename with ..', await answer(() => fleet.rename(settings, `${settings}/../x` as FencedPath))],
    [
      'rename to a . segment',
      await answer(() => fleet.rename(settings, `${at(fleet, 'homes/claude-a')}/.` as FencedPath)),
    ],
    [
      'rename with an empty middle segment',
      await answer(() => fleet.rename(settings, `${at(fleet, 'homes/claude-a')}//x` as FencedPath)),
    ],
    ['rename on a read-only root', await answer(() => harness.rename(credential.path, at(harness, 'x.json')))],
    ['rename in downloads', await answer(() => downloads.rename(at(downloads, 'a'), at(downloads, 'b')))],
    [
      'rename a folder into itself',
      await answer(() => fleet.rename(at(fleet, 'homes/claude-a'), at(fleet, 'homes/claude-a/inner'))),
    ],
    // the target's folder must already exist, and no link may lie on the way to either end
    [
      'write the file to move into odd places',
      await answer(() => fleet.writeText(at(fleet, 'homes/claude-a/extra.txt'), 'x')),
    ],
    [
      'rename into a folder that does not exist',
      await answer(() => fleet.rename(at(fleet, 'homes/claude-a/extra.txt'), at(fleet, 'homes/nope/extra.txt'))),
    ],
    ['nothing was made by that refusal', { ok: await kindAt(at(fleet, 'homes/nope')) }],
    [
      'rename into a file used as a folder',
      await answer(() =>
        fleet.rename(at(fleet, 'homes/claude-a/extra.txt'), at(fleet, 'homes/claude-a/settings.json/x')),
      ),
    ],
    [
      'rename from a missing folder',
      await answer(() => fleet.rename(at(fleet, 'homes/nope/extra.txt'), at(fleet, 'homes/claude-a/moved.txt'))),
    ],
    [
      'linkTo a folder, for the link-on-the-way rows',
      await answer(() => fleet.linkTo(at(fleet, 'homes/alias'), { root: fleet, path: at(fleet, 'homes/claude-a') })),
    ],
    [
      'rename into a folder reached through a link',
      await answer(() => fleet.rename(at(fleet, 'homes/claude-a/extra.txt'), at(fleet, 'homes/alias/via'))),
    ],
    [
      'rename from a path through a link',
      await answer(() => fleet.rename(at(fleet, 'homes/alias/extra.txt'), at(fleet, 'homes/claude-a/moved.txt'))),
    ],
    ['the file stayed where it was', { ok: await kindAt(at(fleet, 'homes/claude-a/extra.txt')) }],
    ['harnessFile read', await answer(() => runtimes.roots.harnessFile(claudeJson).readText())],
    ['harnessFile stat kind', await answer(async () => (await runtimes.roots.harnessFile(claudeJson).stat())?.kind)],
    [
      'harnessFile a missing declared file',
      await answer(() => runtimes.roots.harnessFile(`${places.owner}/sub/.claude.json`).readDurable()),
    ],
    ['harnessFile an undeclared name', await answer(() => runtimes.roots.harnessFile(`${places.owner}/.bashrc`))],
    ['harnessFile by another plugin', await answer(() => stranger.roots.harnessFile(claudeJson))],
    ['harnessFile a relative path', await answer(() => runtimes.roots.harnessFile('.claude.json'))],
    ['harnessFile with ..', await answer(() => runtimes.roots.harnessFile(`${places.owner}/x/../.claude.json`))],
    ['harnessFile in the fence', await answer(() => runtimes.roots.harnessFile(`${places.home}/.claude.json`))],
  ];
}

async function onTestingHost() {
  const seen: Seen = {};
  const owner = '/home/owner';
  const host = await testHost({
    plugins: halves(seen),
    ownerHome: owner,
    fenceHome: '/home/owner/.test-home',
    harnessFiles: { [`${owner}/.claude.json`]: CLAUDE_JSON },
  });
  try {
    return await cases(seen, {
      owner,
      home: '/home/owner/.test-home',
      seedHarness: async (leaf, text) => host.putRoot('harness-home', leaf, text),
    });
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-links-parity-`));
  parents.push(parent);
  const owner = `${parent}/owner`;
  const home = `${owner}/.test-home`;
  await mkdir(`${owner}/.claude`, { recursive: true, mode: 0o700 });
  await mkdir(`${owner}/sub`, { recursive: true, mode: 0o700 });
  await writeFile(`${owner}/.claude.json`, CLAUDE_JSON, { mode: 0o600 });
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
      home,
      seedHarness: async (leaf, text) => await writeFile(`${owner}/.claude/${leaf}`, text, { mode: 0o600 }),
    });
  } finally {
    await outcome.host.stop();
  }
}

test('roots part 2 parity: linkTo, setMode and harnessFile answer every case alike on both hosts', async () => {
  const testing = await onTestingHost();
  const real = await onRealHost();
  expect(testing).toEqual(real);
  // and what both answer is the rule (so parity is not two hosts agreeing on a wrong answer)
  const byCase = Object.fromEntries(real);
  expect(byCase['linkTo a harness credential into fleet']).toEqual({ ok: null });
  expect(byCase['the name is now a link']).toEqual({ ok: 'symlink' });
  expect(byCase['linkTo again at the same name']).toEqual({ refused: 'outside' });
  expect(byCase['linkTo a missing target']).toEqual({ refused: 'outside' });
  expect(byCase['linkTo a missing target, dangling']).toEqual({ ok: null });
  expect(byCase['linkTo into a read-only root']).toEqual({ refused: 'read_only' });
  expect(byCase['linkTo into downloads']).toEqual({ refused: 'read_only' });
  expect(byCase['linkTo from a look-alike handle']).toEqual({ refused: 'not_declared' });
  expect(byCase['linkTo from another plugin’s handle']).toEqual({ refused: 'not_declared' });
  expect(byCase['its mode']).toEqual({ ok: 0o700 });
  expect(byCase['its mode again']).toEqual({ ok: 0o600 });
  expect(byCase['setMode on a read-only root']).toEqual({ refused: 'read_only' });
  expect(byCase['setMode with a mode out of range']).toEqual({ refused: 'outside' });
  expect(byCase['setMode on a missing name']).toEqual({ refused: 'outside' });
  expect(byCase['setMode by a plugin that did not declare it']).toEqual({ refused: 'not_declared' });
  expect(byCase['setMode on a link']).toEqual({ refused: 'link_escape' });
  expect(byCase['rename to a . segment']).toEqual({ refused: 'outside' });
  expect(byCase['rename with an empty middle segment']).toEqual({ refused: 'outside' });
  expect(byCase['link inside a moved folder is at the new place']).toEqual({ ok: 'symlink' });
  expect(byCase['link inside a moved folder is gone from the old place']).toEqual({ ok: null });
  expect(byCase['setMode 0o400 before the folder move']).toEqual({ ok: null });
  expect(byCase['the moved file keeps its mode']).toEqual({ ok: 0o400 });
  expect(byCase['lstat a folder holding only a link']).toEqual({ ok: 'directory' });
  expect(byCase['realPath a folder holding only a link']).toEqual({ ok: true });
  expect(byCase['list a folder holding only a link']).toEqual({ ok: ['only.json'] });
  expect(byCase['entries of a folder holding only a link']).toEqual({ ok: [['only.json', 'symlink']] });
  expect(byCase['rename into a folder that does not exist']).toEqual({ refused: 'changed' });
  expect(byCase['nothing was made by that refusal']).toEqual({ ok: null });
  expect(byCase['rename into a file used as a folder']).toEqual({ refused: 'changed' });
  expect(byCase['rename from a missing folder']).toEqual({ refused: 'changed' });
  expect(byCase['rename into a folder reached through a link']).toEqual({ refused: 'link_escape' });
  expect(byCase['rename from a path through a link']).toEqual({ refused: 'link_escape' });
  expect(byCase['the file stayed where it was']).toEqual({ ok: 'file' });
  expect(byCase['rename a folder holding only a link']).toEqual({ ok: null });
  expect(byCase['the only link is at the new place']).toEqual({ ok: 'symlink' });
  expect(byCase['the only link is gone from the old place']).toEqual({ ok: null });
  expect(byCase['harnessFile read']).toEqual({ ok: CLAUDE_JSON });
  expect(byCase['harnessFile stat kind']).toEqual({ ok: 'file' });
  expect(byCase['harnessFile a missing declared file']).toEqual({ ok: null });
  expect(byCase['harnessFile an undeclared name']).toEqual({ refused: 'not_declared' });
  expect(byCase['harnessFile by another plugin']).toEqual({ refused: 'not_declared' });
  expect(byCase['harnessFile a relative path']).toEqual({ refused: 'outside' });
  expect(byCase['harnessFile with ..']).toEqual({ refused: 'outside' });
  expect(byCase['harnessFile in the fence']).toEqual({ refused: 'fenced' });
});
