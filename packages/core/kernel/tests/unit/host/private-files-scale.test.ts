import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import type { FencedPath } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { fencedReal, fenceOf } from '../../../host/fence-guard.ts';
import { privateIndexOf, recheckIntervalOf } from '../../../host/fence-index.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { SharedTreeError } from '../../../host/shared-trees.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * The private-files index at the size of a long-lived machine and under the clock (§7.7): a few thousand ferret
 * sessions must not starve a login's credential of its place (each declared place has its own budget); a place that
 * does fill its budget FAILS CLOSED (the guard refuses every entry on its device); the index re-reads only the folder
 * that changed; a change is told by the folder's times to the nanosecond, and a change too recent to trust is read
 * again. A bind mount cannot be made without privilege in a unit test, so it is simulated at the disk seam exactly as
 * `private-files-deep.test.ts` does.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const REAL = nodeFs(() => 'r');
const DECOY = 'Innocent.txt';
/** A wall clock an hour past now: no folder the disk stamped in a test is too recent to trust. */
const LATER = (): bigint => BigInt(Date.now() + 3_600_000) * 1_000_000n;

/** The composed list of the plugins whose real layouts these fixtures copy (ferrets sorts before logins). */
const LIST = composePrivateFiles([
  { id: 'logins', privacy: { private: ['credentials'] } },
  { id: 'browsers', privacy: { private: ['data', 'x11'] } },
  { id: 'ferrets', privacy: { private: ['tokens.json', 'sessions/*/environment.json'] } },
]);

async function home() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-scale-`));
  parents.push(parent);
  const root = `${parent}/home`;
  const agentHome = `${root}/state/codex/agent-homes/F1`;
  await mkdir(agentHome, { recursive: true });
  await writeFile(`${agentHome}/own.txt`, 'mine');
  return { parent, home: root, agentHome };
}

/** Writes `count` files named `<prefix><n><suffix>` below `folder`, a few hundred at a time. */
async function fill(folder: string, count: number, name: (n: number) => string, content = 'x'): Promise<void> {
  for (let from = 0; from < count; from += 200)
    await Promise.all(
      Array.from({ length: Math.min(200, count - from) }, async (_, offset) => {
        const path = `${folder}/${name(from + offset)}`;
        await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
        await writeFile(path, content);
      }),
    );
}

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

const agentHomeRoot = (fs: HostFs, home: string, list: readonly string[], recheckMs?: number): RootHandle =>
  rootsPortFor(fs, { home, plugin: 'codex', worktrees: `${home}-worktrees` }, ['agent-homes'], () => undefined, {
    random: () => 'r',
    privateFiles: list,
    ...(recheckMs === undefined ? {} : { privateRecheckMs: recheckMs }),
  }).root('agent-homes', { subfolder: 'F1' });

const named = (root: RootHandle, relative: string): FencedPath => {
  const path = root.resolve(relative);
  if (!path.ok) throw new Error(`resolve ${relative}: ${path.error}`);
  return path.value;
};

const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
};

describe('PF-budget every declared place has its own budget, so thousands of sessions cannot starve a credential', () => {
  test('PF-budget 4200 ferret sessions and one login: the login’s sign-in file is pinned, not truncated, and a bound alias of it is fenced', async () => {
    const l = await home();
    await fill(`${l.home}/state/ferrets/sessions`, 4200, n => `s${n}/environment.json`);
    await mkdir(`${l.home}/state/logins/credentials/L1`, { recursive: true });
    const auth = `${l.home}/state/logins/credentials/L1/auth.json`;
    await writeFile(auth, 'private-auth');
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(REAL, real, { pins: () => [], private: LIST }, { wall: LATER }).snapshot();
    const paths = new Set(snapshot.places.map(place => place.path));
    expect(snapshot.truncated).toEqual([]);
    expect(paths.has(`${real}/state/logins/credentials/L1/auth.json`)).toBe(true);
    expect(paths.has(`${real}/state/ferrets/sessions/s4199/environment.json`)).toBe(true);
    const decoy = `${l.agentHome}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const root = agentHomeRoot(bound(REAL, decoy, auth), l.home, LIST, 0);
    expect(await refusal(() => root.readText(named(root, DECOY)))).toBe('refused:fenced');
    expect(await root.readText(named(root, 'own.txt'))).toBe('mine');
  });

  test('PF-budget a place that fills its budget does not take the next place’s: each is counted on its own', async () => {
    const l = await home();
    await fill(`${l.home}/state/aaa/data`, 100, n => `f${n}`);
    await fill(`${l.home}/state/zzz/cred/L1`, 1, () => 'auth.json');
    const real = await realpath(l.home);
    const input = { pins: () => [], private: ['state/aaa/data', 'state/zzz/cred'] };
    const snapshot = await privateIndexOf(REAL, real, input, {
      bounds: { depth: 3, limit: 50 },
      wall: LATER,
    }).snapshot();
    expect(snapshot.truncated).toEqual([`${real}/state/aaa/data`]);
    expect(snapshot.places.some(place => place.path.endsWith('zzz/cred/L1/auth.json'))).toBe(true);
  });
});

describe('PF-budget the real bound fails closed: a place past its budget is truncated, and what is not proven public is refused', () => {
  test('PF-budget past the real 4096 places the tree is truncated and the guard refuses an entry on its device, owner roots included', async () => {
    const l = await home();
    await fill(`${l.home}/state/browsers/data/P1`, 4100, n => `f${n}`);
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(REAL, real, { pins: () => [], private: LIST }, { wall: LATER }).snapshot();
    expect(snapshot.truncated).toEqual([`${real}/state/browsers/data`]);
    expect(snapshot.closed.map(tree => tree.path)).toEqual([`${real}/state/browsers/data`]);
    const root = agentHomeRoot(REAL, l.home, LIST, 0);
    expect(await refusal(() => root.readText(named(root, 'own.txt')))).toBe('refused:fenced');
    // `entries` shows no entry that is held (its size and times are facts about it): nothing of the agent home is left.
    expect(await root.entries(named(root, '.'))).toEqual([]);
    // An owner's root is judged by the fence: an entry on the closed tree's device is refused there too.
    const fence = await fenceOf(REAL, l.home, LIST);
    expect(fence.closed.size).toBe(1);
    await mkdir(`${l.parent}/work`, { recursive: true });
    await writeFile(`${l.parent}/work/notes.md`, 'hello');
    expect(await fencedReal(REAL, fence, `${l.parent}/work/notes.md`)).toBe(true);
  });

  test('PF-budget under the real budget nothing is truncated: the last of 3000 members is pinned and an ordinary file is read', async () => {
    const l = await home();
    await fill(`${l.home}/state/browsers/data/P1`, 3000, n => `f${n}`);
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(REAL, real, { pins: () => [], private: LIST }, { wall: LATER }).snapshot();
    expect(snapshot.truncated).toEqual([]);
    expect(snapshot.closed).toEqual([]);
    expect(snapshot.places.some(place => place.path.endsWith('P1/f2999'))).toBe(true);
    const root = agentHomeRoot(REAL, l.home, LIST, 0);
    expect(await root.readText(named(root, 'own.txt'))).toBe('mine');
    const fence = await fenceOf(REAL, l.home, LIST);
    await mkdir(`${l.parent}/work`, { recursive: true });
    await writeFile(`${l.parent}/work/notes.md`, 'hello');
    expect(await fencedReal(REAL, fence, `${l.parent}/work/notes.md`)).toBe(false);
  });

  // The root's own truncated tree is tested where the root and the index share the real bound (private-files-flat.test.ts).
});

describe('PF-index the index is kept incrementally: a change is read again where it happened, not everywhere', () => {
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

  test('PF-index with 300 sessions a new file in one session folder costs one look per folder and one folder read, not a rescan', async () => {
    const l = await home();
    const sessions = `${l.home}/state/ferrets/sessions`;
    await fill(sessions, 300, n => `s${n}/environment.json`);
    const real = await realpath(l.home);
    const meter = counted(REAL);
    const index = privateIndexOf(meter.fs, real, { pins: () => [], private: LIST }, { wall: LATER });
    const first = await index.snapshot();
    const built = meter.calls();
    expect(built).toBeGreaterThan(600);
    const quiet = meter.calls();
    expect(await index.snapshot()).toBe(first);
    expect(meter.calls() - quiet).toBe(first.watched.size);
    await writeFile(`${sessions}/s7/environment.json.new`, 'rotated');
    await rename(`${sessions}/s7/environment.json.new`, `${sessions}/s7/environment.json`);
    const before = meter.calls();
    const after = await index.snapshot();
    const spent = meter.calls() - before;
    expect(after).not.toBe(first);
    expect(after.places.find(place => place.path.endsWith('s7/environment.json'))?.key).not.toBe(
      first.places.find(place => place.path.endsWith('s7/environment.json'))?.key,
    );
    // One look at each watched folder, plus the one folder that changed (a listing and its members): never the 600+ of a rescan.
    expect(spent).toBeLessThan(first.watched.size + 12);
  });

  test('PF-index an environment.json written into an EXISTING session folder is pinned at the next look, and a bound alias of it is fenced', async () => {
    const l = await home();
    const sessions = `${l.home}/state/ferrets/sessions`;
    await mkdir(`${sessions}/s1`, { recursive: true });
    await fill(sessions, 1, () => 's2/environment.json', 'other');
    const real = await realpath(l.home);
    const index = privateIndexOf(REAL, real, { pins: () => [], private: LIST }, { wall: LATER });
    const first = await index.snapshot();
    expect(first.places.some(place => place.path.endsWith('s1/environment.json'))).toBe(false);
    await writeFile(`${sessions}/s1/environment.json`, 'private-token');
    const after = await index.snapshot();
    expect(after.places.some(place => place.path.endsWith('s1/environment.json'))).toBe(true);
    const decoy = `${l.agentHome}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const root = agentHomeRoot(bound(REAL, decoy, `${sessions}/s1/environment.json`), l.home, LIST, 0);
    expect(await refusal(() => root.readText(named(root, DECOY)))).toBe('refused:fenced');
  });
});

/** A disk whose directories carry the times a test chooses, plus an adjustable step on one folder's. */
function stamped(base: HostFs, at: { mtime: bigint; ctime: bigint }, only?: string): HostFs {
  return {
    ...base,
    identity: async path => {
      const found = await base.identity(path);
      if (found === undefined || found.kind !== 'directory' || (only !== undefined && !path.endsWith(only)))
        return found;
      return { ...found, mtimeNs: found.mtimeNs + at.mtime, ctimeNs: found.ctimeNs + at.ctime };
    },
  };
}

/** A disk that counts how many times the folder whose path ends with `suffix` is LISTED: a folder is read again only then. */
function listings(base: HostFs, suffix: string): { readonly fs: HostFs; readonly reads: () => number } {
  let reads = 0;
  return {
    fs: {
      ...base,
      list: async path => {
        if (path.endsWith(suffix)) reads += 1;
        return await base.list(path);
      },
    },
    reads: () => reads,
  };
}

describe('PF-time a change is told to the nanosecond, and one too recent to trust is read again', () => {
  const input = { pins: () => [], private: LIST };

  test('PF-time a folder that differs only in its modification time below the millisecond is a change', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    const step = { mtime: 0n, ctime: 0n };
    const meter = listings(stamped(REAL, step, 'credentials/L1'), 'credentials/L1');
    const index = privateIndexOf(meter.fs, real, input, { wall: LATER });
    const first = await index.snapshot();
    expect(meter.reads()).toBe(1);
    expect(await index.snapshot()).toBe(first);
    expect(meter.reads()).toBe(1);
    step.mtime = 1n;
    await index.snapshot();
    expect(meter.reads()).toBe(2);
  });

  test('PF-time a folder that differs only in its status-change time below the millisecond is a change', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    const step = { mtime: 0n, ctime: 0n };
    const meter = listings(stamped(REAL, step, 'credentials/L1'), 'credentials/L1');
    const index = privateIndexOf(meter.fs, real, input, { wall: LATER });
    await index.snapshot();
    expect(meter.reads()).toBe(1);
    step.ctime = 1n;
    await index.snapshot();
    expect(meter.reads()).toBe(2);
  });

  test('PF-time a folder changed within the racy window of the look is read again at the next look, until it is old enough to trust', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    // Every directory is stamped at one fixed instant; the clock then stands 1 ms after it (too recent), then 1 s.
    // (with a fraction of a millisecond, so this disk is not read as one that stamps whole seconds)
    const stamp = 5_000_000_123n;
    const fixed = (base: HostFs): HostFs => ({
      ...base,
      identity: async path => {
        const found = await base.identity(path);
        return found?.kind === 'directory' ? { ...found, mtimeNs: stamp, ctimeNs: stamp } : found;
      },
    });
    let clock = stamp + 1_000_000n;
    const meter = listings(fixed(REAL), 'credentials/L1');
    const index = privateIndexOf(meter.fs, real, input, { wall: () => clock });
    await index.snapshot();
    expect(meter.reads()).toBe(1);
    // Too recent to trust (1 ms after the stamp): read again at the next look.
    await index.snapshot();
    expect(meter.reads()).toBe(2);
    // The window is 20 ms: a look 19 ms after the stamp is still inside it, one 21 ms after is not.
    clock = stamp + 19_000_000n;
    await index.snapshot();
    expect(meter.reads()).toBe(3);
    clock = stamp + 21_000_000n;
    await index.snapshot();
    expect(meter.reads()).toBe(4);
    // The look that read it at 21 ms trusted it: nothing is read again.
    await index.snapshot();
    await index.snapshot();
    expect(meter.reads()).toBe(4);
  });

  test('PF-time a member that lands after the look in the same filesystem tick is indexed (the racy rule, on the real disk)', async () => {
    const l = await home();
    await mkdir(`${l.home}/state/logins/credentials/L1`, { recursive: true });
    const real = await realpath(l.home);
    const index = privateIndexOf(REAL, real, input);
    let missed = 0;
    for (let round = 0; round < 40; round += 1) {
      await index.snapshot();
      await writeFile(`${l.home}/state/logins/credentials/L1/f${round}.new`, 'x');
      await rename(
        `${l.home}/state/logins/credentials/L1/f${round}.new`,
        `${l.home}/state/logins/credentials/L1/auth${round}.json`,
      );
      const after = await index.snapshot();
      if (!after.places.some(place => place.path.endsWith(`L1/auth${round}.json`))) missed += 1;
    }
    expect(missed).toBe(0);
  });
});

describe('PF-closed an unlistable folder is never read as empty', () => {
  test('PF-closed a private folder that cannot be LISTED rejects the index and refuses every read of an internal root', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    const unlistable: HostFs = {
      ...REAL,
      list: async path => {
        if (path.endsWith('credentials/L1')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return await REAL.list(path);
      },
    };
    await expect(
      privateIndexOf(unlistable, real, { pins: () => [], private: LIST }, { wall: LATER }).snapshot(),
    ).rejects.toThrow('denied');
    const root = agentHomeRoot(unlistable, l.home, LIST, 0);
    expect(await refusal(() => root.readText(named(root, 'own.txt')))).toBe('refused:fenced');
    // The control: the same disk where the folder lists is read.
    const open = agentHomeRoot(REAL, l.home, LIST, 0);
    expect(await open.readText(named(open, 'own.txt'))).toBe('mine');
  });
});

describe('PF-recheck the look interval is validated: an interval that never ends is the default', () => {
  test('PF-recheck a value that is not a finite number from zero to five seconds is the default 250', () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -1, -0.5, 5001, 1e12, '250', undefined, null])
      expect(recheckIntervalOf(bad)).toBe(250);
    for (const good of [0, 1, 250, 5000]) expect(recheckIntervalOf(good)).toBe(good);
  });

  test('PF-recheck an index given an unending interval still looks again after the default one', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -10]) {
      let clock = 0;
      const index = privateIndexOf(
        REAL,
        real,
        { pins: () => [], private: LIST },
        { recheckMs: bad, now: () => clock, wall: LATER },
      );
      const first = await index.snapshot();
      await writeFile(`${l.home}/state/logins/credentials/L1/new${String(bad)}.json`, 'x');
      clock = 249;
      expect(await index.snapshot()).toBe(first);
      clock = 251;
      const after = await index.snapshot();
      expect(after.places.some(place => place.path.endsWith(`new${String(bad)}.json`))).toBe(true);
    }
  });
});

describe('PF-shared a tree the minter declared private is never minted', () => {
  const PROFILES = defineState({ name: 'profiles', path: 'data/*', store: 'opaque', format: 1 });

  const mint = async (privateFiles: readonly string[]): Promise<string> => {
    const l = await home();
    await mkdir(`${l.home}/state/browsers/data/agent`, { recursive: true });
    const port = rootsPortFor(
      REAL,
      { home: l.home, plugin: 'browsers', worktrees: `${l.home}-worktrees` },
      [],
      () => undefined,
      { random: () => 'r', shareTrees: true, stateFiles: [PROFILES], privateFiles },
    );
    try {
      await port.share({ state: PROFILES, name: 'agent' });
      return 'minted';
    } catch (error) {
      return error instanceof SharedTreeError ? `refused:${error.message}` : `error:${String(error)}`;
    }
  };

  test('PF-shared a state tree under a declared private folder is refused not_own, and the same tree undeclared is minted', async () => {
    expect(await mint(['state/browsers/data'])).toContain('refused');
    expect(await mint(['state/browsers/data/agent'])).toContain('refused');
    expect(await mint(['state/browsers/data/*/Cookies'])).toContain('refused');
    // A declared place that sits INSIDE the tree (a profile's cookies): the tree holds a private file, so it is not minted.
    expect(await mint(['state/browsers/data/agent/Default/Cookies'])).toContain('refused');
    expect(await mint([])).toBe('minted');
    expect(await mint(['state/browsers/other'])).toBe('minted');
  });
});
