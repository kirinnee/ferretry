/**
 * The late identity guard of `rename` is armed: a writer on the same filesystem who swaps the placed credential link aside
 * for an ordinary file just before the kernel looks at it, and puts the original link back at the next disk call, does not
 * get the original link moved into another ferret's home. What the kernel recorded when it placed the link is kept through
 * the move decision and asked again at the held-source check, for the link itself and for a folder that holds it.
 * Real disk, a `HostFs` that runs an adversary before a chosen call; fake credentials in a temporary home.
 *
 * Scoped, not closed: between that held-source look and `rename(2)` there is no more checking (the standard library has
 * no compare-and-rename), so a writer who restores the link inside THAT window is not stopped (docs/secrets.md).
 */
import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err } from '@ferretry/std';
import type { WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { SharedTreeError } from '../../../host/shared-trees.ts';

const CREDENTIALS = defineState({ name: 'credentials', path: 'credentials/*', store: 'opaque', format: 1 });
const parents: string[] = [];
afterEach(async () => {
  hook = undefined;
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const ORIGINAL = '{"fake":"ORIGINAL"}\n';

let hook: undefined | ((name: string, args: unknown[]) => Promise<void>);
const baseFs = nodeFs(() => crypto.randomUUID());
const fs = new Proxy(baseFs, {
  get(target, key) {
    const value = (target as never as Record<PropertyKey, unknown>)[key];
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      await hook?.(String(key), args);
      return await (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as HostFs;

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-rename-race-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const creds = `${home}/state/logins/credentials`;
  await mkdir(`${creds}/work`, { recursive: true, mode: 0o700 });
  await writeFile(`${creds}/work/auth.json`, ORIGINAL, { mode: 0o600 });
  await ensureInternalRootBases(baseFs, { home, plugin: 'logins' }, ['credentials']);
  await ensureInternalRootBases(baseFs, { home, plugin: 'codex' }, ['agent-homes']);
  const workFolders: WorkFolders = { folderOf: () => undefined, check: () => err('outside') };
  const opts = { stateFiles: [CREDENTIALS], privateFiles: ['state/logins/credentials'] };
  const logins = rootsPortFor(
    fs,
    { home, plugin: 'logins', worktrees: `${home}-wt` },
    ['credentials'],
    () => workFolders,
    {
      ...opts,
      shareCredentials: ['auth.json'],
    },
  );
  const codex = rootsPortFor(
    fs,
    { home, plugin: 'codex', worktrees: `${home}-wt` },
    ['agent-homes'],
    () => workFolders,
    opts,
  );
  const homes = `${home}/state/codex/agent-homes`;
  await mkdir(`${homes}/f1`, { recursive: true, mode: 0o700 });
  return { home, homes, logins, codex };
}

const resolved = (root: RootHandle, path: string) => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};
const run = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof SharedTreeError) return error.refusal;
    if (error instanceof RootError) return `root:${error.refusal}`;
    return `ERROR:${String(error)}`;
  }
};

/** Places the credential at f1/auth.json, then makes `swapAt` (the first look at the leaf) replace it and the next call restore it. */
async function swapAndRestore(move: (all: RootHandle) => Promise<unknown>, leafName: string) {
  const w = await world();
  const credential = await w.logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' });
  const home = w.codex.root('agent-homes', { subfolder: 'f1' });
  await home.linkCredential(credential, resolved(home, 'auth.json'));
  const all = w.codex.root('agent-homes');
  await all.makeDirectory(resolved(all, 'f2'));
  const leaf = `${w.homes}/f1/auth.json`;
  let stage = 0;
  hook = async (name, args) => {
    if (stage === 0 && name === 'identity' && args[0] === leaf) {
      await rename(leaf, `${leaf}.held`);
      await writeFile(leaf, 'ordinary\n');
      stage = 1;
    } else if (stage === 1) {
      await rm(leaf);
      await rename(`${leaf}.held`, leaf);
      stage = 2;
    }
  };
  const result = await run(move(all)).finally(() => {
    hook = undefined;
  });
  const dest = `${w.homes}/${leafName}`;
  return {
    stage,
    result,
    destinationIsLink: (await lstat(dest).catch(() => undefined))?.isSymbolicLink(),
    destinationBytes: await readFile(dest, 'utf8').catch(() => undefined),
    leafKind: (await lstat(leaf).catch(() => undefined))?.isSymbolicLink(),
  };
}

test('the placed link is not moved when another writer replaces and restores it across the placement probe', async () => {
  const seen = await swapAndRestore(
    async all => await all.rename(resolved(all, 'f1/auth.json'), resolved(all, 'f2/auth.json')),
    'f2/auth.json',
  );
  expect(seen.stage).toBe(2);
  expect(seen.result).toBe('root:link_escape');
  expect(seen.destinationIsLink).toBeUndefined();
  expect(seen.destinationBytes).toBeUndefined();
  expect(seen.leafKind).toBe(true);
});

test('the folder that holds the placed link is not moved when the link is replaced and restored across the probe', async () => {
  const seen = await swapAndRestore(
    async all => await all.rename(resolved(all, 'f1'), resolved(all, 'f2/moved')),
    'f2/moved/auth.json',
  );
  expect(seen.stage).toBe(2);
  expect(seen.result).toBe('root:link_escape');
  expect(seen.destinationBytes).toBeUndefined();
  expect(seen.leafKind).toBe(true);
});

test('a link raw-replaced by an ordinary file, and left that way, moves like any file (the record is not a name ban)', async () => {
  const w = await world();
  const credential = await w.logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' });
  const home = w.codex.root('agent-homes', { subfolder: 'f1' });
  await home.linkCredential(credential, resolved(home, 'auth.json'));
  const all = w.codex.root('agent-homes');
  await all.makeDirectory(resolved(all, 'f2'));
  const leaf = `${w.homes}/f1/auth.json`;
  await rm(leaf);
  await writeFile(leaf, 'ordinary\n');
  expect(await run(all.rename(resolved(all, 'f1/auth.json'), resolved(all, 'f2/auth.json')))).toBe('accepted');
  expect(await readFile(`${w.homes}/f2/auth.json`, 'utf8')).toBe('ordinary\n');
});
