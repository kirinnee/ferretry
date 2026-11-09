import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../host/adapters/pinned/index.ts';
import { privateGuardOf, privatelyHeld } from '../../../host/fence-guard.ts';
import { identityKey, privateIndexOf } from '../../../host/fence-index.ts';
import { PinRegistry } from '../../../host/pins.ts';
import { RootError, resolveInRoot, rootsPortFor } from '../../../host/roots.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * The private-files fence reaches the files that matter, not only the folders around them (§7.7): a login's sign-in
 * files, a browser profile's cookies and a ferret's plaintext session credential are pinned by identity, so a bind
 * mount or alias of one under an innocent name is refused through EVERY root. A bind mount cannot be made without
 * privilege in a unit test, so it is simulated at the disk seam (`bound`: one name answers with another file's device and
 * inode and ONE link), exactly as `private-files-fence.test.ts` does. These fixtures use the REAL layouts.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const REAL = nodeFs(() => 'r');
const DECOY = 'Innocent.txt';
/** A wall clock an hour past now: no folder the disk stamped in a test is too recent to trust. */
const LATER = (): bigint => BigInt(Date.now() + 3_600_000) * 1_000_000n;

/** The composed list of the plugins whose real layouts these fixtures copy. */
const LIST = composePrivateFiles([
  { id: 'logins', privacy: { private: ['credentials'] } },
  { id: 'browsers', privacy: { private: ['data', 'x11'] } },
  { id: 'ferrets', privacy: { private: ['tokens.json', 'sessions/*/environment.json'] } },
]);

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-deep-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const agentHome = `${home}/state/codex/agent-homes/F1`;
  const files = {
    auth: `${home}/state/logins/credentials/L1/auth.json`,
    claude: `${home}/state/logins/credentials/L1/.credentials.json`,
    cookies: `${home}/state/browsers/data/P1/Default/Cookies`,
    cacheEntry: `${home}/state/browsers/data/P1/Default/Cache/Cache_Data/f_000001`,
    environment: `${home}/state/ferrets/sessions/s2/environment.json`,
    ownEnvironment: `${home}/state/ferrets/sessions/s1/environment.json`,
  };
  for (const [name, path] of Object.entries(files)) {
    await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await writeFile(path, `private-${name}`);
  }
  await mkdir(agentHome, { recursive: true });
  await writeFile(`${agentHome}/own.txt`, 'mine');
  await mkdir(work, { recursive: true });
  await writeFile(`${work}/notes.md`, 'hello');
  return { parent, home, work, agentHome, files };
}

type Layout = Awaited<ReturnType<typeof layout>>;

/** A name that answers as another file does, with ONE link: what a bind mount of that file shows. */
function bound(base: HostFs, decoy: string, source: string): HostFs {
  const lie = (identity: FileIdentity): FileIdentity => ({ ...identity, links: 1 });
  const isDecoy = (path: string): boolean =>
    path === decoy || (path.startsWith('/proc/self/fd/') && path.endsWith(`/${basename(decoy)}`));
  return {
    ...base,
    identity: async path => {
      if (!isDecoy(path)) return await base.identity(path);
      const found = await base.identity(source);
      return found === undefined ? undefined : lie(found);
    },
    openRead: async path => {
      if (!isDecoy(path)) return await base.openRead(path);
      const opened = await base.openRead(source);
      return { ...opened, identity: lie(opened.identity) };
    },
  };
}

/** A folder that answers as another folder does: a bind mount of that folder. What is inside it stays its own. */
function boundFolder(base: HostFs, decoy: string, source: string): HostFs {
  const lie = (identity: FileIdentity): FileIdentity => ({ ...identity, links: 1 });
  return {
    ...base,
    identity: async path => {
      if (path !== decoy) return await base.identity(path);
      const found = await base.identity(source);
      return found === undefined ? undefined : lie(found);
    },
    openDirectory: async path => {
      const opened = await base.openDirectory(path);
      return path === decoy
        ? { ...opened, identity: lie(await base.identity(source).then(found => found as FileIdentity)) }
        : opened;
    },
  };
}

/** A disk that cannot be looked at in one place (a permission error, not an absent name). */
function unreadable(base: HostFs, broken: (path: string) => boolean): HostFs {
  return {
    ...base,
    identity: async path => {
      if (broken(path)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return await base.identity(path);
    },
  };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

function makeRoot(
  l: Layout,
  fs: HostFs,
  plugin: string,
  name: RootName,
  scope: { readonly ferret?: FerretId; readonly subfolder?: string },
  privateFiles: readonly string[],
  extra: { readonly pins?: PinRegistry; readonly recheckMs?: number } = {},
): RootHandle {
  const roots = rootsPortFor(
    fs,
    { home: l.home, plugin, worktrees: `${l.home}-worktrees` },
    [name],
    () => workFolders(l.work),
    {
      random: () => 'r',
      privateFiles,
      ...(extra.pins === undefined ? {} : { pins: extra.pins }),
      ...(extra.recheckMs === undefined ? {} : { privateRecheckMs: extra.recheckMs }),
    },
  );
  return roots.root(name, scope);
}

const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
};

const named = (root: RootHandle, relative: string): FencedPath => {
  const path = root.resolve(relative);
  if (!path.ok) throw new Error(`resolve ${relative}: ${path.error}`);
  return path.value;
};

interface Door {
  readonly label: string;
  readonly folder: (l: Layout) => string;
  readonly make: (l: Layout, fs: HostFs, list: readonly string[]) => RootHandle;
}

const DOORS: readonly Door[] = [
  {
    label: 'work',
    folder: l => l.work,
    make: (l, fs, list) => makeRoot(l, fs, 'codex', 'work', { ferret: 'F1' as FerretId }, list),
  },
  {
    label: 'imports',
    folder: l => l.work,
    make: (l, fs, list) => makeRoot(l, fs, 'codex', 'imports', { subfolder: l.work }, list),
  },
  {
    label: 'agent-homes',
    folder: l => l.agentHome,
    make: (l, fs, list) => makeRoot(l, fs, 'codex', 'agent-homes', { subfolder: 'F1' }, list),
  },
];

const DEEP: readonly (readonly [string, (l: Layout) => string])[] = [
  ["logins' Codex sign-in (credentials/<id>/auth.json)", l => l.files.auth],
  ["logins' Claude sign-in (credentials/<id>/.credentials.json)", l => l.files.claude],
  ["a browser profile's cookies (data/<profile>/Default/Cookies)", l => l.files.cookies],
  ["a ferret's plaintext session credential (sessions/<id>/environment.json)", l => l.files.environment],
];

describe('PF-deep the files inside a private folder are pinned by identity, through every root', () => {
  for (const [label, source] of DEEP)
    for (const door of DOORS)
      test(`PF-deep ${label}: bound as an innocent name in the ${door.label} root it is fenced, and read once undeclared`, async () => {
        const l = await layout();
        const decoy = `${door.folder(l)}/${DECOY}`;
        await writeFile(decoy, 'decoy');
        const fs = bound(REAL, decoy, source(l));
        const root = door.make(l, fs, LIST);
        const path = named(root, DECOY);
        expect(await refusal(() => root.readText(path))).toBe('refused:fenced');
        expect(await refusal(() => root.readBytes(path))).toBe('refused:fenced');
        expect(await refusal(() => root.readDurable(path))).toBe('refused:fenced');
        expect(await refusal(() => root.stat(path))).toBe('refused:fenced');
        expect(await refusal(() => root.fileIdentity(path))).toBe('refused:fenced');
        // The control: the same name, the same disk, nothing declared — the declaration alone stood in the way.
        const open = door.make(l, fs, []);
        expect(await refusal(() => open.readText(named(open, DECOY)))).toBe('allowed');
      });

  test("PF-deep another ferret's session credential bound into a ferret's own session folder is fenced; its own is read", async () => {
    const l = await layout();
    const own = `${l.home}/state/ferrets/sessions/s1`;
    const decoy = `${own}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const fs = bound(REAL, decoy, l.files.environment);
    const root = makeRoot(l, fs, 'ferrets', 'sessions', { subfolder: 's1' }, LIST);
    expect(await refusal(() => root.readText(named(root, DECOY)))).toBe('refused:fenced');
    // Its own credential is the root's own place, as before: declaring it private does not lock the ferret out.
    expect(await root.readText(named(root, 'environment.json'))).toBe('private-ownEnvironment');
  });

  test('PF-deep a credential file bound into the Logins credentials root of ANOTHER login is not the root’s own', async () => {
    const l = await layout();
    const decoy = `${l.home}/state/logins/credentials/L1/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const root = makeRoot(l, bound(REAL, decoy, l.files.environment), 'logins', 'credentials', {}, LIST);
    // Logins reads its OWN sign-in files; a ferret's session credential under a login's name is not its own.
    expect(await root.readText(named(root, 'L1/auth.json'))).toBe('private-auth');
    expect(await refusal(() => root.readText(named(root, `L1/${DECOY}`)))).toBe('refused:fenced');
  });
});

describe('PF-bound the index looks to a bounded depth, pins every folder it reaches, and says when it stopped', () => {
  test('PF-bound a folder at the depth limit is pinned: a bind mount of it holds what is inside, though that is not indexed', async () => {
    const l = await layout();
    const cache = `${l.home}/state/browsers/data/P1/Default/Cache`;
    await mkdir(`${l.agentHome}/mnt`, { recursive: true });
    await writeFile(`${l.agentHome}/mnt/f_000001`, 'a copy that is its own file');
    const fs = boundFolder(REAL, `${l.agentHome}/mnt`, cache);
    const root = makeRoot(l, fs, 'codex', 'agent-homes', { subfolder: 'F1' }, LIST);
    // The file itself is beyond the bound (its identity is not indexed), so only the walk up through its folder holds it.
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(REAL, real, {
      pins: () => [],
      private: LIST,
    }).snapshot();
    expect(snapshot.places.some(place => place.path.endsWith('Cache/Cache_Data/f_000001'))).toBe(false);
    expect(snapshot.places.some(place => place.path.endsWith('Default/Cache'))).toBe(true);
    expect(await refusal(() => root.readText(named(root, 'mnt/f_000001')))).toBe('refused:fenced');
    expect(await refusal(() => root.writeText(named(root, 'mnt/new.txt'), 'x'))).toBe('refused:fenced');
    // The control: an ordinary folder of the agent home is read.
    expect(await root.readText(named(root, 'own.txt'))).toBe('mine');
  });

  test('PF-bound the resolver itself refuses a name under a bound private folder, whatever the later layers would say', async () => {
    const l = await layout();
    const cache = `${l.home}/state/browsers/data/P1/Default/Cache`;
    await mkdir(`${l.agentHome}/mnt`, { recursive: true });
    const fs = boundFolder(REAL, `${l.agentHome}/mnt`, cache);
    const list = { files: LIST, recheckMs: 0 };
    expect(list.files.length).toBeGreaterThan(0);
    const result = await resolveInRoot(fs, l.home, l.agentHome, false, 'mnt/anything', l.home, {
      files: LIST,
      recheckMs: 0,
    });
    expect(result).toEqual({ ok: false, error: 'fenced' });
    const open = await resolveInRoot(fs, l.home, l.agentHome, false, 'mnt/anything', l.home, {
      files: [],
      recheckMs: 0,
    });
    expect(open.ok).toBe(true);
  });

  test('PF-bound past the place limit the rest are not indexed and the snapshot names the folder it stopped in', async () => {
    const l = await layout();
    const many = `${l.home}/state/browsers/data/P2`;
    await mkdir(many, { recursive: true });
    for (let index = 0; index < 12; index += 1) await writeFile(`${many}/f${index}`, 'x');
    const real = await realpath(l.home);
    const input = { pins: () => [], private: ['state/browsers/data'] } as const;
    const small = await privateIndexOf(REAL, real, input, { bounds: { depth: 3, limit: 8 } }).snapshot();
    expect(small.truncated).toEqual([`${real}/state/browsers/data`]);
    expect(small.places.length).toBeLessThanOrEqual(8);
    const roomy = await privateIndexOf(REAL, real, input, { bounds: { depth: 3, limit: 4096 } }).snapshot();
    expect(roomy.truncated).toEqual([]);
    expect(roomy.places.some(place => place.path.endsWith('P2/f11'))).toBe(true);
  });

  test('PF-bound the depth limit is a limit: a member one level deeper is not indexed, one inside it is', async () => {
    const l = await layout();
    const real = await realpath(l.home);
    const input = { pins: () => [], private: ['state/browsers/data'] } as const;
    const shallow = await privateIndexOf(REAL, real, input, { bounds: { depth: 2, limit: 4096 } }).snapshot();
    expect(shallow.places.some(place => place.path.endsWith('P1/Default'))).toBe(true);
    expect(shallow.places.some(place => place.path.endsWith('Default/Cookies'))).toBe(false);
    const deeper = await privateIndexOf(REAL, real, input, { bounds: { depth: 3, limit: 4096 } }).snapshot();
    expect(deeper.places.some(place => place.path.endsWith('Default/Cookies'))).toBe(true);
  });
});

describe('PF-index the index is kept, looks again only at the folders it was built from, and sees what changed', () => {
  const counted = (base: HostFs): { readonly fs: HostFs; readonly calls: () => number } => {
    let calls = 0;
    const fs = new Proxy(base, {
      get(target, key) {
        const value = (target as never)[key];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { fs, calls: () => calls };
  };

  test('PF-index an unchanged home is not scanned again: the second answer is the same snapshot for a few looks at folders', async () => {
    const l = await layout();
    const real = await realpath(l.home);
    const meter = counted(REAL);
    // A clock far past every time the disk stamped: nothing is "too recent to trust", so only a real change shows.
    const index = privateIndexOf(meter.fs, real, { pins: () => [], private: LIST }, { wall: LATER });
    const first = await index.snapshot();
    const scanned = meter.calls();
    const second = await index.snapshot();
    expect(second).toBe(first);
    expect(meter.calls() - scanned).toBe(first.watched.size);
    expect(first.watched.size).toBeLessThan(scanned);
  });

  test('PF-index a member replaced by a rename (a new inode) is indexed at the next answer', async () => {
    const l = await layout();
    const real = await realpath(l.home);
    const index = privateIndexOf(REAL, real, { pins: () => [], private: LIST });
    const before = await index.snapshot();
    await writeFile(`${l.files.auth}.new`, 'rotated');
    await rename(`${l.files.auth}.new`, l.files.auth);
    const after = await index.snapshot();
    expect(after).not.toBe(before);
    const keyOf = (path: string, from: typeof before): string | undefined =>
      from.places.find(place => place.path === path)?.key;
    expect(keyOf(l.files.auth, after)).toBeDefined();
    expect(keyOf(l.files.auth, after)).not.toBe(keyOf(l.files.auth, before));
  });

  test('PF-index a rotated credential is held through a root with no restart: the new inode, bound, is fenced', async () => {
    const l = await layout();
    const decoy = `${l.agentHome}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const root = makeRoot(l, bound(REAL, decoy, l.files.auth), 'codex', 'agent-homes', { subfolder: 'F1' }, LIST);
    expect(await refusal(() => root.readText(named(root, DECOY)))).toBe('refused:fenced');
    await writeFile(`${l.files.auth}.new`, 'rotated');
    await rename(`${l.files.auth}.new`, l.files.auth);
    expect(await refusal(() => root.readText(named(root, DECOY)))).toBe('refused:fenced');
  });

  test('PF-index with a look interval the folders are looked at once per interval, and a change waits at most that long', async () => {
    const l = await layout();
    const real = await realpath(l.home);
    let clock = 0;
    const meter = counted(REAL);
    const index = privateIndexOf(
      meter.fs,
      real,
      { pins: () => [], private: LIST },
      { recheckMs: 1000, now: () => clock },
    );
    const first = await index.snapshot();
    await writeFile(`${l.files.auth}.new`, 'rotated');
    await rename(`${l.files.auth}.new`, l.files.auth);
    const before = meter.calls();
    clock = 999;
    expect(await index.snapshot()).toBe(first);
    expect(meter.calls()).toBe(before);
    clock = 1000;
    const after = await index.snapshot();
    expect(after).not.toBe(first);
  });

  test('PF-index answers that arrive together share one scan', async () => {
    const l = await layout();
    const real = await realpath(l.home);
    const meter = counted(REAL);
    const index = privateIndexOf(meter.fs, real, { pins: () => [], private: LIST }, { wall: LATER });
    const [a, b, c] = await Promise.all([index.snapshot(), index.snapshot(), index.snapshot()]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test('PF-index a pattern with a tail pins that one file in each member, and the members are not recursed into', async () => {
    const l = await layout();
    const real = await realpath(l.home);
    await writeFile(`${l.home}/state/ferrets/sessions/s2/turn-001.md`, 'task text');
    const snapshot = await privateIndexOf(REAL, real, { pins: () => [], private: LIST }).snapshot();
    const paths = snapshot.places.map(place => place.path);
    expect(paths).toContain(l.files.environment);
    expect(paths).toContain(l.files.ownEnvironment);
    expect(paths.some(path => path.endsWith('turn-001.md'))).toBe(false);
  });
});

describe('PF-closed an error while checking refuses; it never allows', () => {
  test('PF-closed a private place that cannot be looked at refuses every read of an internal root', async () => {
    const l = await layout();
    const fs = unreadable(REAL, path => path.endsWith('credentials/L1/auth.json'));
    const root = makeRoot(l, fs, 'codex', 'agent-homes', { subfolder: 'F1' }, LIST);
    expect(await refusal(() => root.readText(named(root, 'own.txt')))).toBe('refused:fenced');
    expect(await refusal(() => root.list(named(root, '.')).then(() => 'listed'))).toBe('refused:fenced');
  });

  test('PF-closed the same disk with nothing declared is read: the refusal is the guard failing closed, not the disk', async () => {
    const l = await layout();
    const fs = unreadable(REAL, path => path.endsWith('credentials/L1/auth.json'));
    const root = makeRoot(l, fs, 'codex', 'agent-homes', { subfolder: 'F1' }, []);
    expect(await root.readText(named(root, 'own.txt'))).toBe('mine');
  });

  test('PF-closed a recursive remove stops when the guard cannot be built, and nothing is removed', async () => {
    const l = await layout();
    await mkdir(`${l.agentHome}/tree/inner`, { recursive: true });
    await writeFile(`${l.agentHome}/tree/inner/a.txt`, 'a');
    const fs = unreadable(REAL, path => path.endsWith('credentials/L1/auth.json'));
    const root = makeRoot(l, fs, 'codex', 'agent-homes', { subfolder: 'F1' }, LIST);
    expect(await refusal(() => root.remove(named(root, 'tree')))).toBe('refused:fenced');
    expect(await readdir(`${l.agentHome}/tree`)).toEqual(['inner']);
  });

  test('PF-closed a path component that cannot be looked at is held, and one that is not there is held', async () => {
    const l = await layout();
    const real = await realpath(l.home);
    const guard = await privateGuardOf(REAL, l.home, l.agentHome, LIST);
    const fs = unreadable(REAL, path => path === `${real}/state/codex/agent-homes/F1/sub`);
    await mkdir(`${l.agentHome}/sub`, { recursive: true });
    await writeFile(`${l.agentHome}/sub/file.txt`, 'x');
    expect(await privatelyHeld(fs, guard, `${l.agentHome}/sub/file.txt`, l.agentHome)).toBe(true);
    expect(await privatelyHeld(REAL, guard, `${l.agentHome}/sub/file.txt`, l.agentHome)).toBe(false);
    expect(await privatelyHeld(REAL, guard, `${l.agentHome}/missing/file.txt`, l.agentHome)).toBe(true);
  });

  test('PF-closed a folder the kept index was built from that can no longer be looked at is a change: it looks again and refuses', async () => {
    const l = await layout();
    const real = await realpath(l.home);
    let broken = false;
    const fs = unreadable(REAL, path => broken && path.endsWith('state/logins/credentials/L1'));
    const index = privateIndexOf(fs, real, { pins: () => [], private: LIST });
    await index.snapshot();
    broken = true;
    await expect(index.snapshot()).rejects.toThrow('denied');
    broken = false;
    expect((await index.snapshot()).places.length).toBeGreaterThan(0);
  });

  test('PF-closed a guard that cannot be built rejects, it never answers an empty list', async () => {
    const l = await layout();
    const fs = unreadable(REAL, path => path.endsWith('credentials/L1/auth.json'));
    await expect(privateGuardOf(fs, l.home, l.agentHome, LIST)).rejects.toThrow('denied');
  });
});

/** A disk whose name answers as another file does only while `on()` says so: a bind mount made or removed at a chosen moment. */
function switched(base: HostFs, name: string, source: string, on: () => boolean): HostFs {
  const lie = (identity: FileIdentity): FileIdentity => ({ ...identity, links: 1 });
  return {
    ...base,
    identity: async path => {
      if (path !== name || !on()) return await base.identity(path);
      const found = await base.identity(source);
      return found === undefined ? undefined : lie(found);
    },
  };
}

describe('PF-pin the pins judge what they open, before the open and after it, by identity', () => {
  const pinner = platformRootPinner();

  /** The native pinner, telling `afterOpen` when each walk has opened its target (the native walk never touches the disk seam). */
  const watched = (afterOpen: () => void): (() => typeof pinner) => {
    const spy: typeof pinner = {
      pin: async (cwd, options) => {
        const held = await pinner.pin(cwd, options);
        return {
          rootReal: held.rootReal,
          policyCwd: held.policyCwd,
          open: async (rel, opened) => {
            const target = await held.open(rel, opened);
            afterOpen();
            return target;
          },
          probe: () => held.probe(),
          close: () => held.close(),
        };
      },
    };
    return () => spy;
  };

  async function attempt(state: { on: boolean; afterOpen: () => void }, rel: string) {
    const l = await layout();
    await writeFile(`${l.agentHome}/landing.txt`, 'innocent bytes');
    const fs = switched(REAL, `${l.agentHome}/landing.txt`, l.files.auth, () => state.on);
    const root = makeRoot(l, fs, 'codex', 'agent-homes', { subfolder: 'F1' }, LIST, {
      pins: new PinRegistry(watched(() => state.afterOpen())),
    });
    const pinned = await root.pin(named(root, '.'));
    try {
      return await refusal(async () => {
        const target = await pinned.open(rel);
        await target.close();
      });
    } finally {
      await pinned.close();
    }
  }

  test('PF-pin a name that is a private place is refused BEFORE the open (the open alone would have served it)', async () => {
    const state = { on: true, afterOpen: () => undefined as void };
    // The bind mount is gone by the time the open has happened: only the check made before it can refuse.
    state.afterOpen = () => {
      state.on = false;
    };
    expect(await attempt(state, 'landing.txt')).toBe('refused:fenced');
  });

  test('PF-pin a name swapped for a private place during the open is refused AFTER it', async () => {
    const state = { on: false, afterOpen: () => undefined as void };
    // Innocent until the open has happened: only the check made after it can refuse.
    state.afterOpen = () => {
      state.on = true;
    };
    expect(await attempt(state, 'landing.txt')).toBe('refused:fenced');
  });

  test('PF-pin the same open with no bind mount at any moment is served', async () => {
    expect(await attempt({ on: false, afterOpen: () => undefined }, 'landing.txt')).toBe('allowed');
  });
});

describe('PF-shared a shared tree is judged with the private list too', () => {
  test('PF-shared a copy of a shared tree that holds a credential under another name is refused', async () => {
    const l = await layout();
    const INSTALLED = defineState({ name: 'installed', path: 'installed/*', store: 'opaque', format: 1 });
    await mkdir(`${l.home}/state/skills/installed/abc`, { recursive: true });
    await writeFile(`${l.home}/state/skills/installed/abc/SKILL.md`, 'a skill');
    const decoy = `${l.home}/state/skills/installed/abc/${DECOY}`;
    await writeFile(decoy, 'decoy');
    await mkdir(`${l.home}/state/codex/agent-homes/F2`, { recursive: true });
    const fs = bound(REAL, decoy, l.files.auth);
    const port = (plugin: string, declared: readonly RootName[], share: boolean, list: readonly string[]) =>
      rootsPortFor(fs, { home: l.home, plugin, worktrees: `${l.home}-worktrees` }, declared, () => undefined, {
        random: () => 'r',
        privateFiles: list,
        shareTrees: share,
        stateFiles: [INSTALLED],
      });
    for (const [list, expected] of [
      [LIST, 'refused:fenced'],
      [[], 'allowed'],
    ] as const) {
      const skills = port('skills', ['imports'], true, list);
      const tree = await skills.share({ state: INSTALLED, name: 'abc' });
      const receiver = port('codex', ['agent-homes'], false, list).root('agent-homes', { subfolder: 'F2' });
      expect(await refusal(() => receiver.copyShared(tree, named(receiver, `copy-${expected.length}`)))).toBe(expected);
    }
  });
});

describe('PF-entries a listing with sizes and times tells nothing about a private place', () => {
  test('PF-entries a private file under another name is left out of entries(); its neighbours are listed', async () => {
    const l = await layout();
    const decoy = `${l.agentHome}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const root = makeRoot(l, bound(REAL, decoy, l.files.auth), 'codex', 'agent-homes', { subfolder: 'F1' }, LIST);
    const names = (await root.entries(named(root, '.'))).map(entry => entry.name);
    expect(names).toContain('own.txt');
    expect(names).not.toContain(DECOY);
    const open = makeRoot(l, bound(REAL, decoy, l.files.auth), 'codex', 'agent-homes', { subfolder: 'F1' }, []);
    expect((await open.entries(named(open, '.'))).map(entry => entry.name)).toContain(DECOY);
  });

  test('PF-entries the identity key is the device and the inode, the same on both sides of a bind mount', () => {
    expect(identityKey({ device: 7n, inode: 9n })).toBe('7:9');
  });
});
