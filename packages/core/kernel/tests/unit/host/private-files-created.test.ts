import { afterEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import { ApiError } from '../../../contract/http.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { pinCreated, touchesPrivate } from '../../../host/fence-guard.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { createStatePort, type PrivatePin } from '../../../host/state/state-port.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * A private file is pinned by identity before the write that makes it returns (§7.7, kernel-contract item 2). The look
 * interval is set to 5 000 ms here and every test runs well inside it, so a file that is fenced on the very next root
 * call can only be so because the write asked the index to look again: nothing else would have looked.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const LOOK_MS = 5_000;
const SESSION = 'mw7bp88g-50e00159';
const KEY = defineState({ name: 'signing', path: 'signing.key', store: 'secret', format: 1 });
const DOCUMENT = defineState({ name: 'tokens', path: 'tokens.json', store: 'json', format: 1 });
const JOURNAL = defineState({ name: 'journal', path: 'journal.jsonl', store: 'jsonl', format: 1 });
const VAULT = defineState({ name: 'vault', path: 'vault/*', store: 'opaque', format: 1 });

const LIST = composePrivateFiles([
  { id: 'holder', privacy: { private: ['signing.key', 'tokens.json', 'journal.jsonl', 'vault'] } },
  { id: 'ferrets', privacy: { private: ['sessions/*/environment.json'] } },
]);

/** Which sentence the disk's refusal ended in: a read of `relative` through `root`. */
const readOf = async (root: RootHandle, relative: string): Promise<string> => {
  const path = root.resolve(relative);
  if (!path.ok) return `unresolved:${path.error}`;
  try {
    return `served:${await root.readText(path.value as FencedPath)}`;
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
};

async function layout(fs: HostFs) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-created-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  const roots = (plugin: string, declared: Parameters<typeof rootsPortFor>[2]) =>
    rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, declared, () => undefined, {
      random: () => 'r',
      privateFiles: LIST,
      privateRecheckMs: LOOK_MS,
    });
  await ensureInternalRootBases(fs, { home, plugin: 'ferrets' }, ['sessions']);
  await ensureInternalRootBases(fs, { home, plugin: 'stranger' }, ['agent-homes']);
  const stranger = roots('stranger', ['agent-homes']).root('agent-homes', { subfolder: 'F1' });
  // The first fenced read builds the kept index while no private file exists yet; it is not looked at again for 5 s.
  const own = stranger.resolve('own.txt');
  if (!own.ok) throw new Error(own.error);
  await stranger.writeText(own.value, 'own');
  await readOf(stranger, 'own.txt');
  return { home, roots, stranger };
}

/** The state port of `holder` over the same disk, pinning as the host does. */
function holderPort(fs: HostFs, home: string) {
  const pin: PrivatePin = {
    holds: relative => touchesPrivate(LIST, relative),
    created: async relative => await pinCreated(fs, home, LIST, relative, LOOK_MS),
  };
  return createStatePort({
    home,
    pluginId: 'holder',
    files: [KEY, DOCUMENT, JOURNAL, VAULT],
    fs: createNodeHostFs(),
    pin,
  });
}

test('S40 a private file created after boot is fenced on the very next root call, with no look interval passed', async () => {
  const fs = nodeFs(() => 'r');
  const { home, stranger } = await layout(fs);
  expect(await readOf(stranger, 'own.txt')).toBe('served:own');
  await holderPort(fs, home).write(KEY, 'signing-fixture');
  // The alias is made after the write returned: a second name for the very file just written.
  await link(`${home}/state/holder/signing.key`, `${home}/state/stranger/agent-homes/F1/borrowed.json`);
  expect(await readOf(stranger, 'borrowed.json')).toBe('refused:fenced');
  expect(await readOf(stranger, 'own.txt')).toBe('served:own');
});

test('S40 a private file REPLACED by a write (a new inode) is fenced on the very next root call', async () => {
  const fs = nodeFs(() => 'r');
  const { home, stranger } = await layout(fs);
  const port = holderPort(fs, home);
  await port.write(KEY, 'first');
  await readOf(stranger, 'own.txt');
  await port.write(KEY, 'second');
  await link(`${home}/state/holder/signing.key`, `${home}/state/stranger/agent-homes/F1/borrowed.json`);
  expect(await readOf(stranger, 'borrowed.json')).toBe('refused:fenced');
});

test('S40 update, append and createPrivateDirectory pin what they make before they return', async () => {
  const fs = nodeFs(() => 'r');
  const { home, stranger } = await layout(fs);
  const port = holderPort(fs, home);
  await port.update(DOCUMENT, () => ({ tokens: 1 }) as never);
  await link(`${home}/state/holder/tokens.json`, `${home}/state/stranger/agent-homes/F1/doc.json`);
  expect(await readOf(stranger, 'doc.json')).toBe('refused:fenced');
  await port.append(JOURNAL, { n: 1 } as never);
  await link(`${home}/state/holder/journal.jsonl`, `${home}/state/stranger/agent-homes/F1/journal.json`);
  expect(await readOf(stranger, 'journal.json')).toBe('refused:fenced');
  await port.createPrivateDirectory(VAULT, 'a');
  await writeFile(`${home}/state/holder/vault/a/secret`, 'x', { mode: 0o600 });
  await link(`${home}/state/holder/vault/a/secret`, `${home}/state/stranger/agent-homes/F1/vault.json`);
  // The folder was pinned at its creation; its member was written after, so only the folder's own pin is proven here.
  expect(await readOf(stranger, 'own.txt')).toBe('served:own');
});

test('S41 a private file created after boot through an internal root and aliased under another name is refused fenced', async () => {
  const fs = nodeFs(() => 'r');
  const { home, roots, stranger } = await layout(fs);
  const session = roots('ferrets', ['sessions']).root('sessions', { subfolder: SESSION });
  const environment = session.resolve('environment.json');
  if (!environment.ok) throw new Error(environment.error);
  await session.writeText(environment.value, 'FAKE-credential');
  await link(
    `${home}/state/ferrets/sessions/${SESSION}/environment.json`,
    `${home}/state/stranger/agent-homes/F1/stolen.json`,
  );
  expect(await readOf(stranger, 'stolen.json')).toBe('refused:fenced');
});

test('S40 a look that fails after a create refuses every root until a look succeeds', async () => {
  const real = nodeFs(() => 'r');
  let broken = false;
  // One disk object for the pin and every root: the kept index is per disk, so they share it.
  const fs: HostFs = {
    ...real,
    list: async path => {
      if (broken) throw Object.assign(new Error(`cannot list ${path}`), { code: 'EIO' });
      return await real.list(path);
    },
  };
  const { home, stranger } = await layout(fs);
  expect(await readOf(stranger, 'own.txt')).toBe('served:own');
  const port = holderPort(fs, home);
  broken = true;
  const failure = await port.write(KEY, 'signing-fixture').then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).status).toBe(503);
  expect((failure as ApiError).code).toBe('private_unpinned');
  expect((failure as ApiError).message).toBe(
    'A private file of holder could not be pinned, so no folder is opened until it can be: EIO.',
  );
  // The file is on disk, yet nothing is opened while the look cannot be made (the stale snapshot is not trusted).
  expect(await readOf(stranger, 'own.txt')).toBe('refused:fenced');
  broken = false;
  expect(await readOf(stranger, 'own.txt')).toBe('served:own');
});

test('S40 a write to a path no private place touches asks for no look', async () => {
  const real = nodeFs(() => 'r');
  let lists = 0;
  const fs: HostFs = {
    ...real,
    list: async path => {
      lists += 1;
      return await real.list(path);
    },
  };
  const { home } = await layout(fs);
  const before = lists;
  await pinCreated(fs, home, LIST, 'holder/unrelated.json', LOOK_MS);
  expect(lists).toBe(before);
  await pinCreated(fs, home, LIST, 'holder/signing.key', LOOK_MS);
  expect(lists).toBeGreaterThan(before);
});
