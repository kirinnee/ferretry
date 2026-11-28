import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { privateGuardOf, privatelyHeld } from '../../../host/fence-guard.ts';
import { identityKey } from '../../../host/fence-index.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
// Hold both the clear-folder window and the index interval open throughout each attack.
beforeEach(() => {
  spyOn(performance, 'now').mockReturnValue(1_000);
});
afterEach(async () => {
  mock.restore();
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const REAL = nodeFs(() => 'r');
const PRIVATE = ['state/ferrets/sessions/*/environment.json'];
const RECHECK_MS = 5_000;
const OLD_NS = 7_200_000_000_000n;

const keyAt = async (path: string): Promise<string> => {
  const identity = await REAL.identity(path);
  if (identity === undefined) throw new Error('the synthetic entry is missing');
  return identityKey(identity);
};

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-clear-window-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const base = `${home}/state/codex/agent-homes/F1`;
  const session = `${home}/state/ferrets/sessions/S1`;
  const alias = `${base}/alias`;
  for (const folder of [alias, session]) await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(`${alias}/environment.json`, 'FAKE-public-control');
  await writeFile(`${base}/own.txt`, 'FAKE-own');
  return { home, base, session, alias };
}

/** The same disk seam as private-files-alias.test.ts: a bind keeps device:inode and its visible path. */
function bind(base: HostFs, target: () => { alias: string; source: string } | undefined): HostFs {
  return new Proxy(base, {
    get(disk, key) {
      const member = (disk as never)[key] as unknown;
      if (typeof member !== 'function' || key === 'symlink') return member;
      return async (...args: unknown[]) => {
        const mount = target();
        const mapped = args.map(arg =>
          mount !== undefined && typeof arg === 'string' && (arg === mount.alias || arg.startsWith(`${mount.alias}/`))
            ? `${mount.source}${arg.slice(mount.alias.length)}`
            : arg,
        );
        const answer = await (member as (...values: unknown[]) => Promise<unknown>).apply(disk, mapped);
        return mount !== undefined &&
          mapped[0] !== args[0] &&
          key === 'realpath' &&
          typeof answer === 'string' &&
          (answer === mount.source || answer.startsWith(`${mount.source}/`))
          ? `${mount.alias}${answer.slice(mount.source.length)}`
          : answer;
      };
    },
  });
}

const readOf = async (root: RootHandle, relative: string): Promise<string> => {
  const path = root.resolve(relative);
  if (!path.ok) throw new Error(path.error);
  try {
    return `served:${await root.readText(path.value)}`;
  } catch (error) {
    if (!(error instanceof RootError)) throw error;
    return `refused:${error.refusal}`;
  }
};

for (const way of ['rename with source bind', 'bind over clear path', 'rename out of collection'] as const)
  test(`SEC-PF1 ${way}: a resting folder replaces a warm clear folder and its new credential is refused`, async () => {
    const l = await layout();
    let mount: { alias: string; source: string } | undefined;
    const resting: HostFs = {
      ...REAL,
      identity: async path => {
        const found = await REAL.identity(path);
        return found !== undefined && path === l.session
          ? { ...found, mtimeNs: found.mtimeNs - OLD_NS, ctimeNs: found.ctimeNs - OLD_NS }
          : found;
      },
    };
    const fs = bind(resting, () => mount);
    const root = rootsPortFor(
      fs,
      { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
      ['agent-homes'],
      () => undefined,
      { privateFiles: PRIVATE, privateRecheckMs: RECHECK_MS },
    ).root('agent-homes', { subfolder: 'F1' });
    // The session folder rests empty. Its folder is pinned; this credential has never been in a snapshot.
    const guard = await privateGuardOf(fs, l.home, l.base, PRIVATE, RECHECK_MS);
    expect(guard.keys.has(await keyAt(l.session))).toBe(true);
    expect(await readOf(root, 'alias/environment.json')).toBe('served:FAKE-public-control');
    await writeFile(`${l.session}/environment.json`, 'FAKE-new-session-credential', { mode: 0o600 });
    expect(guard.keys.has(await keyAt(`${l.session}/environment.json`))).toBe(false);
    if (way === 'bind over clear path') mount = { alias: l.alias, source: l.session };
    else {
      await rename(l.alias, `${l.alias}.old`);
      await rename(l.session, l.alias);
      // Retain the private source through a synthetic bind, as the alias harness supports without root.
      if (way === 'rename with source bind') mount = { alias: l.session, source: l.alias };
    }
    const result = await readOf(root, 'alias/environment.json');
    expect(result).toBe('refused:fenced');
    expect(await readOf(root, 'own.txt')).toBe('served:FAKE-own');
  });

test('SEC-PF1 a changed clear folder forces a look even when the kept guard does not know its identity', async () => {
  const l = await layout();
  let mount: { alias: string; source: string } | undefined;
  const fs = bind(REAL, () => mount);
  const root = rootsPortFor(
    fs,
    { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
    ['agent-homes'],
    () => undefined,
    { privateFiles: PRIVATE, privateRecheckMs: RECHECK_MS },
  ).root('agent-homes', { subfolder: 'F1' });
  expect(await readOf(root, 'alias/environment.json')).toBe('served:FAKE-public-control');
  const added = `${l.session}-new`;
  await mkdir(added, { mode: 0o700 });
  await writeFile(`${added}/environment.json`, 'FAKE-new-private-folder', { mode: 0o600 });
  mount = { alias: l.alias, source: added };
  const result = await readOf(root, 'alias/environment.json');
  expect(result).toBe('refused:fenced');
});

test('SEC-PF1 replacing a clear folder with another public folder still permits its read', async () => {
  const l = await layout();
  const root = rootsPortFor(
    REAL,
    { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
    ['agent-homes'],
    () => undefined,
    { privateFiles: PRIVATE, privateRecheckMs: RECHECK_MS },
  ).root('agent-homes', { subfolder: 'F1' });
  expect(await readOf(root, 'alias/environment.json')).toBe('served:FAKE-public-control');
  await rename(l.alias, `${l.alias}.old`);
  await mkdir(l.alias, { mode: 0o700 });
  await writeFile(`${l.alias}/environment.json`, 'FAKE-public-replacement');
  expect(await readOf(root, 'alias/environment.json')).toBe('served:FAKE-public-replacement');
});

test('SEC-PF1 two concurrent reads both refresh a changed folder before either can reuse its memory', async () => {
  const l = await layout();
  const operation = new AsyncLocalStorage<'first' | 'second'>();
  const homeLooks = { first: 0, second: 0 };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let mount: { alias: string; source: string } | undefined;
  const fs = bind(
    {
      ...REAL,
      realpath: async path => {
        const name = operation.getStore();
        // Home resolutions: anchor, kept guard, then mandatory fresh look. Pause after the kept walk finishes.
        if (path === l.home && name !== undefined && ++homeLooks[name] === 3 && name === 'first') {
          entered.resolve();
          await release.promise;
        }
        return await REAL.realpath(path);
      },
    },
    () => mount,
  );
  const root = rootsPortFor(
    fs,
    { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
    ['agent-homes'],
    () => undefined,
    { privateFiles: PRIVATE, privateRecheckMs: RECHECK_MS },
  ).root('agent-homes', { subfolder: 'F1' });
  expect(await readOf(root, 'alias/environment.json')).toBe('served:FAKE-public-control');
  const added = `${l.session}-new`;
  await mkdir(added, { mode: 0o700 });
  await writeFile(`${added}/environment.json`, 'FAKE-concurrent-private', { mode: 0o600 });
  mount = { alias: l.alias, source: added };
  const first = operation.run('first', async () => await readOf(root, 'alias/environment.json'));
  try {
    await entered.promise;
    expect(await operation.run('second', async () => await readOf(root, 'alias/environment.json'))).toBe(
      'refused:fenced',
    );
    expect(homeLooks.second).toBeGreaterThanOrEqual(3);
  } finally {
    release.resolve();
    expect(await first).toBe('refused:fenced');
  }
});

for (const failure of ['throw', 'held'] as const)
  test(`SEC-PF1 a ${failure} fresh check leaves replacement memory provisional and the next read refreshes`, async () => {
    const l = await layout();
    const operation = new AsyncLocalStorage<{ homeLooks: number; fresh: boolean }>();
    let fail = true;
    let refreshes = 0;
    const fs: HostFs = {
      ...REAL,
      realpath: async path => {
        const current = operation.getStore();
        if (path === l.home && current !== undefined && ++current.homeLooks === 3) {
          refreshes += 1;
          if (fail && failure === 'throw') throw new Error('FAKE-refresh-failure');
          current.fresh = true;
        }
        return await REAL.realpath(path);
      },
      identity: async path =>
        fail && failure === 'held' && operation.getStore()?.fresh && path === l.alias
          ? undefined
          : await REAL.identity(path),
    };
    const root = rootsPortFor(
      fs,
      { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
      ['agent-homes'],
      () => undefined,
      { privateFiles: PRIVATE, privateRecheckMs: RECHECK_MS },
    ).root('agent-homes', { subfolder: 'F1' });
    expect(await readOf(root, 'alias/environment.json')).toBe('served:FAKE-public-control');
    await rename(l.alias, `${l.alias}.old`);
    await mkdir(l.alias, { mode: 0o700 });
    await writeFile(`${l.alias}/environment.json`, 'FAKE-public-replacement');
    const read = async () =>
      await operation.run({ homeLooks: 0, fresh: false }, async () => await readOf(root, 'alias/environment.json'));
    expect(await read()).toBe('refused:fenced');
    expect(refreshes).toBe(1);
    fail = false;
    expect(await read()).toBe('served:FAKE-public-replacement');
    expect(refreshes).toBe(2);
    // Success commits the provisional memory: a subsequent unchanged read needs no forced look.
    expect(await read()).toBe('served:FAKE-public-replacement');
    expect(refreshes).toBe(2);
  });

test('SEC-PF1 public-folder probe: an unconfirmed second walk still reports changed-folder', async () => {
  const l = await layout();
  const guard = await privateGuardOf(REAL, l.home, l.base, PRIVATE, RECHECK_MS);
  expect(await privatelyHeld(REAL, guard, `${l.alias}/environment.json`, l.base)).toBe(false);
  await rename(l.alias, `${l.alias}.old`);
  await mkdir(l.alias, { mode: 0o700 });
  await writeFile(`${l.alias}/environment.json`, 'FAKE-public-replacement');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const notices: string[] = [];
    expect(
      await privatelyHeld(REAL, guard, `${l.alias}/environment.json`, l.base, undefined, reason =>
        notices.push(reason),
      ),
    ).toBe(false);
    expect(notices).toContain('changed-folder');
  }
});
