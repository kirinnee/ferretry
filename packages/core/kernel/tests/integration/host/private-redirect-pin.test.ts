import { afterEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { pinCreated, touchesPrivate } from '../../../host/fence-guard.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { createStatePort, type PrivatePin } from '../../../host/state/state-port.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * A private page that holds a live pairing code (Access's `fy pair --open` redirect page, under `pairing-redirects`) is
 * fenced from the moment it exists. The look interval is 5 000 ms and every test runs well inside it, so a page that is
 * fenced on the very next root call can only be so because the write that made it asked the index to look again: the
 * DAEMON's state port does, the CLI's own (built without the pin) does not, and that is why the daemon makes the page.
 *
 * The alias is a hard link inside a hard-link root (an immutable store the disk proves closed): the one door a hard
 * link is allowed through, so the only one where the fence's identity index, not the link count, must refuse it.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const LOOK_MS = 5_000;
const REDIRECTS = defineState({ name: 'pairing-redirects', path: 'pairing-redirects/*', store: 'opaque', format: 1 });
const LIST = composePrivateFiles([{ id: 'access', privacy: { private: ['pairing-redirects'] } }]);
const DIRECTORY = 'pair-open-AbCdEf';
const PAGE = `${DIRECTORY}/pairing.html`;

/** What a read of `relative` through `root` ended in. */
const readOf = async (root: RootHandle, relative: string): Promise<string> => {
  const path = root.resolve(relative);
  if (!path.ok) return `unresolved:${path.error}`;
  try {
    return `served:${await root.readText(path.value as FencedPath)}`;
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
};

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-redirect-pin-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const store = `${parent}/store`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${store}/pkg`, { recursive: true });
  await writeFile(`${store}/pkg/own.txt`, 'store file');
  const real = nodeFs(() => 'r');
  // A disk that reports the store chain root-owned and closed (as a multi-user Nix store is). ONE disk object for the
  // pin and the root: the kept index is per disk, so they share it as they do in the host.
  const fs: HostFs = {
    ...real,
    identity: async path => {
      const found = await real.identity(path);
      if (found === undefined || !(store.startsWith(path) || path.startsWith(store))) return found;
      return { ...found, owner: 0, group: 0, mode: found.kind === 'directory' ? 0o755 : 0o444 };
    },
    writable: async () => false,
    groups: async () => [1000],
  };
  const imports = rootsPortFor(
    fs,
    { home, plugin: 'stranger', worktrees: `${home}-worktrees` },
    ['imports'],
    () => undefined,
    { random: () => 'r', privateFiles: LIST, privateRecheckMs: LOOK_MS, hardLinkRoots: [store] },
  ).root('imports', { subfolder: `${store}/pkg` });
  // The first fenced read builds the kept index while no page exists yet; it is not looked at again for 5 s.
  expect(await readOf(imports, 'own.txt')).toBe('served:store file');
  return { fs, home, store, imports };
}

/** Access's state port over the same disk: with the daemon's pin, or (the CLI's) without. */
function accessPort(fs: HostFs, home: string, pinned: boolean) {
  const pin: PrivatePin = {
    holds: relative => touchesPrivate(LIST, relative),
    created: async relative => await pinCreated(fs, home, LIST, relative, LOOK_MS),
  };
  return createStatePort({
    home,
    pluginId: 'access',
    files: [REDIRECTS],
    fs: createNodeHostFs(),
    ...(pinned ? { pin } : {}),
  });
}

/** Makes the page as `fy pair --open` does (a private directory, then the page in it), then aliases it into the store. */
async function makeAndAlias(fs: HostFs, home: string, store: string, pinned: boolean): Promise<void> {
  const port = accessPort(fs, home, pinned);
  await port.createPrivateDirectory(REDIRECTS, DIRECTORY);
  await port.write(REDIRECTS, new TextEncoder().encode('<p>live code</p>'), PAGE);
  await link(`${home}/state/access/pairing-redirects/${PAGE}`, `${store}/pkg/page.html`);
}

test('S40 the redirect page the daemon writes is fenced on the very next root call, under any alias of it', async () => {
  const { fs, home, store, imports } = await layout();
  await makeAndAlias(fs, home, store, true);
  expect(await readOf(imports, 'page.html')).toBe('refused:fenced');
  expect(await readOf(imports, 'own.txt')).toBe('served:store file');
  // It is owner-only on disk, in an owner-only directory: the rule `docs/pairing.md` states.
  expect((await stat(`${home}/state/access/pairing-redirects/${PAGE}`)).mode & 0o777).toBe(0o600);
  expect((await stat(`${home}/state/access/pairing-redirects/${DIRECTORY}`)).mode & 0o777).toBe(0o700);
});

test('S40 a page made through a state port built without the pin is served under its alias until the index next looks (the window the daemon closes)', async () => {
  const { fs, home, store, imports } = await layout();
  await makeAndAlias(fs, home, store, false);
  expect(await readOf(imports, 'page.html')).toBe('served:<p>live code</p>');
});
