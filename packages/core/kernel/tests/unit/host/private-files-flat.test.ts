import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ok } from '@ferretry/std';
import type { FencedPath } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { fencedReal, fenceOf } from '../../../host/fence-guard.ts';
import { type PlaceBudget, privateIndexOf } from '../../../host/fence-index.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';
import { overlayDisk } from './private-files-overlay.ts';

/**
 * The private-files index stays flat as ferret sessions pile up, never fails open, and is never silent (§7.7): a look
 * costs the folders that changed lately plus one slice of the resting ones, never every session ever made; a `*`
 * collection spends its budget only on a member that HOLDS the file; a place past its budget is announced; a filesystem
 * with a coarse clock, or none, is never trusted. A machine with 65,000 sessions is simulated at the disk seam (a few
 * thousand real folders would say nothing about the real bound), exactly as the other private-files tests simulate a
 * bind mount.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const REAL = nodeFs(() => 'r');
/** A wall clock an hour past now: every folder the disk stamped in a test is old enough to rest. */
const LATER = (): bigint => BigInt(Date.now() + 3_600_000) * 1_000_000n;
const ENV = 'environment.json';

const LIST = composePrivateFiles([
  { id: 'logins', privacy: { private: ['credentials'] } },
  { id: 'ferrets', privacy: { private: ['tokens.json', 'sessions/*/environment.json'] } },
]);
const INPUT = { pins: () => [], private: LIST };

async function home() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-flat-`));
  parents.push(parent);
  const root = `${parent}/home`;
  const agentHome = `${root}/state/codex/agent-homes/F1`;
  await mkdir(agentHome, { recursive: true });
  await writeFile(`${agentHome}/own.txt`, 'mine');
  const sessions = `${root}/state/ferrets/sessions`;
  await mkdir(sessions, { recursive: true });
  return { parent, home: root, sessions, agentHome };
}

async function fill(folder: string, count: number, name: (n: number) => string): Promise<void> {
  for (let from = 0; from < count; from += 200)
    await Promise.all(
      Array.from({ length: Math.min(200, count - from) }, async (_, offset) => {
        const path = `${folder}/${name(from + offset)}`;
        await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
        await writeFile(path, 'x');
      }),
    );
}

const counted = (base: HostFs): { readonly fs: HostFs; readonly calls: () => number; readonly lists: () => number } => {
  let calls = 0;
  let lists = 0;
  const fs = new Proxy(base, {
    get(target, key) {
      const value = (target as never)[key];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls += 1;
        if (key === 'list') lists += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fs, calls: () => calls, lists: () => lists };
};

const keyOf = (
  places: readonly { readonly path: string; readonly key: string }[],
  suffix: string,
): string | undefined => places.find(place => place.path.endsWith(suffix))?.key;

describe('PF-flat a look costs what changed, not every session ever made', () => {
  test('PF-flat a quiet look at 600 resting sessions reads one slice of them, never all', async () => {
    const l = await home();
    await fill(l.sessions, 600, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const meter = counted(REAL);
    const index = privateIndexOf(meter.fs, real, INPUT, { wall: LATER, bounds: { depth: 3, limit: 4096, slice: 50 } });
    const first = await index.snapshot();
    expect(meter.calls()).toBeGreaterThan(1200);
    const before = meter.calls();
    expect(await index.snapshot()).toBe(first);
    const spent = meter.calls() - before;
    // The slice, and the handful of folders that are not session folders: nowhere near the 600.
    expect(spent).toBeGreaterThanOrEqual(50);
    expect(spent).toBeLessThan(50 + 40);
  });

  test('PF-flat a resting session whose file was replaced is found when its slice comes round, within one cycle', async () => {
    const l = await home();
    await fill(l.sessions, 600, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const index = privateIndexOf(REAL, real, INPUT, { wall: LATER, bounds: { depth: 3, limit: 4096, slice: 50 } });
    const first = await index.snapshot();
    const was = keyOf(first.places, `s333/${ENV}`);
    await writeFile(`${l.sessions}/s333/${ENV}.new`, 'rotated');
    await rename(`${l.sessions}/s333/${ENV}.new`, `${l.sessions}/s333/${ENV}`);
    let looks = 0;
    let now = was;
    while (now === was && looks < 40) {
      looks += 1;
      now = keyOf((await index.snapshot()).places, `s333/${ENV}`);
    }
    expect(now).not.toBe(was);
    // 600 sessions in slices of 50 are all looked at in 12 looks (one more for the look that built nothing new).
    expect(looks).toBeLessThanOrEqual(13);
  });

  test('PF-flat a new session is pinned at the very next look, however many rest', async () => {
    const l = await home();
    await fill(l.sessions, 600, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const index = privateIndexOf(REAL, real, INPUT, { wall: LATER, bounds: { depth: 3, limit: 4096, slice: 5 } });
    await index.snapshot();
    await fill(l.sessions, 1, () => `s9999/${ENV}`);
    expect(keyOf((await index.snapshot()).places, `s9999/${ENV}`)).toBeDefined();
  });

  test('PF-flat a file written into a session folder changes no place: the same snapshot, and no folder is listed', async () => {
    const l = await home();
    await fill(l.sessions, 40, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const meter = counted(REAL);
    // The real clock: these folders were made a moment ago, so none rests (every look looks at all of them).
    const index = privateIndexOf(meter.fs, real, INPUT);
    const first = await index.snapshot();
    await new Promise(done => setTimeout(done, 60));
    await index.snapshot();
    const lists = meter.lists();
    for (let round = 0; round < 5; round += 1) {
      await writeFile(`${l.sessions}/s7/turn${round}.md`, 'x');
      expect(await index.snapshot()).toBe(first);
    }
    expect(meter.lists()).toBe(lists);
  });

  test('PF-flat a new login folder re-reads the folder it landed in and the new one, never its 30 unchanged siblings', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 30, n => `L${n}/auth.json`);
    const real = await realpath(l.home);
    const meter = counted(REAL);
    const index = privateIndexOf(meter.fs, real, INPUT, { wall: LATER });
    const first = await index.snapshot();
    expect(meter.lists()).toBeGreaterThan(30);
    const lists = meter.lists();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L99/auth.json');
    const after = await index.snapshot();
    expect(after.places.some(place => place.path.endsWith('L99/auth.json'))).toBe(true);
    expect(after).not.toBe(first);
    // The changed folder (`credentials`) and the new one (`L99`): two listings, not 32.
    expect(meter.lists() - lists).toBeLessThanOrEqual(3);
  });

  test('PF-flat a scan that failed halfway is redone at the next look, never answered from the snapshot before it', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    let broken = false;
    const flaky: HostFs = {
      ...REAL,
      list: async path => {
        if (broken && path.endsWith('credentials/L2')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return await REAL.list(path);
      },
    };
    const index = privateIndexOf(flaky, real, INPUT, { wall: LATER });
    await index.snapshot();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L2/auth.json');
    broken = true;
    await expect(index.snapshot()).rejects.toThrow('denied');
    broken = false;
    // The folders it learned of before it failed are as they are now; the failure must not make the look "unchanged".
    const after = await index.snapshot();
    expect(after.places.some(place => place.path.endsWith('L2/auth.json'))).toBe(true);
  });

  test('PF-flat a file replaced in a session folder that changed lately is found at the very next look', async () => {
    const l = await home();
    await fill(l.sessions, 40, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const index = privateIndexOf(REAL, real, INPUT);
    const first = await index.snapshot();
    await writeFile(`${l.sessions}/s7/${ENV}.new`, 'rotated');
    await rename(`${l.sessions}/s7/${ENV}.new`, `${l.sessions}/s7/${ENV}`);
    expect(keyOf((await index.snapshot()).places, `s7/${ENV}`)).not.toBe(keyOf(first.places, `s7/${ENV}`));
  });
});

describe('PF-budget a `*` collection spends its budget only on a member that holds the file', () => {
  // The folder itself is one of the collection's places, so a budget of 3 holds the folder and two members.
  const small = { depth: 3, limit: 4096, patternLimit: 3 } as const;

  test('PF-budget empty session folders cost nothing: 10 without the file and 2 with it fit a budget of 3', async () => {
    const l = await home();
    await fill(l.sessions, 10, n => `empty${n}/notes.md`);
    await fill(l.sessions, 2, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(REAL, real, INPUT, { wall: LATER, bounds: small }).snapshot();
    expect(snapshot.truncated).toEqual([]);
    expect(snapshot.closed).toEqual([]);
    expect(snapshot.places.filter(place => place.path.endsWith(ENV)).length).toBe(2);
  });

  test('PF-budget a third member that holds the file is past the budget: the collection is truncated AND closed, with the counts', async () => {
    const l = await home();
    await fill(l.sessions, 3, n => `s${n}/${ENV}`);
    await fill(l.sessions, 5, n => `empty${n}/notes.md`);
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(REAL, real, INPUT, { wall: LATER, bounds: small }).snapshot();
    expect(snapshot.truncated).toEqual([`${real}/state/ferrets/sessions`]);
    expect(snapshot.closed.map(tree => tree.path)).toEqual([`${real}/state/ferrets/sessions`]);
    const folder = (await REAL.identity(l.sessions))?.device as bigint;
    const file = (await REAL.identity(`${l.sessions}/s0/${ENV}`))?.device as bigint;
    expect(snapshot.closed[0]?.devices).toEqual(new Set([folder, file]));
    expect(snapshot.budgets).toEqual([{ path: `${real}/state/ferrets/sessions`, limit: 3, indexed: 3 }]);
  });

  test('PF-budget the first holder past the budget moves to a device of its own while every indexed place stays: the tree is closed on the new device at the next look, never answered from the snapshot before', async () => {
    const l = await home();
    await fill(l.sessions, 3, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const folder = (await REAL.identity(l.sessions))?.device as bigint;
    const file = (await REAL.identity(`${l.sessions}/s0/${ENV}`))?.device as bigint;
    // A device that is neither the folder's nor the file's, whatever disk the test runs on.
    const mounted = (folder > file ? folder : file) + 9n;
    // The third holder (s2) is the first one past the budget; a mount appears on its file after the first look.
    let moved = false;
    const disk: HostFs = {
      ...REAL,
      identity: async path => {
        const found = await REAL.identity(path);
        return moved && found !== undefined && path === `${l.sessions}/s2/${ENV}`
          ? { ...found, device: mounted }
          : found;
      },
    };
    const index = privateIndexOf(disk, real, INPUT, { bounds: small });
    const first = await index.snapshot();
    expect(first.closed[0]?.devices).toEqual(new Set([folder, file]));
    moved = true;
    // Writing into the folder stands in for the folder being looked at again; no indexed place, key or count differs.
    await writeFile(`${l.sessions}/s2/touched.md`, 'x');
    const after = await index.snapshot();
    expect(after.places.map(place => place.key)).toEqual(first.places.map(place => place.key));
    expect(after.closed[0]?.devices).toEqual(new Set([folder, file, mounted]));
    expect(after).not.toBe(first);
  });
});

/** An identity the test makes up for a place the disk does not hold. */
const made = (kind: 'directory' | 'file', inode: bigint, device: bigint): FileIdentity => ({
  kind,
  device,
  inode,
  links: kind === 'directory' ? 2 : 1,
  size: 0,
  mtimeMs: 0,
  mtimeNs: 1n,
  ctimeNs: 1n,
  mode: 0o600,
  owner: 0,
  group: 0,
});

/**
 * A disk where `sessions` also holds `holders` session folders that each hold an `environment.json`, and `empties` that
 * hold nothing: what a machine that has run for a long time looks like. `device` is the device the folder `sessions`
 * answers with (absent: its own).
 */
function longLived(
  base: HostFs,
  layout: { readonly sessions: string; readonly agentHome: string },
  counts: { readonly holders: number; readonly empties?: number },
  device?: bigint,
): HostFs {
  const { sessions } = layout;
  const names = [
    ...Array.from({ length: counts.holders }, (_, n) => `h${n}`),
    ...Array.from({ length: counts.empties ?? 0 }, (_, n) => `e${n}`),
  ];
  // The device the made-up places answer with, asked once: a made-up answer must not cost a real look at the disk.
  const own = base.identity(sessions).then(found => device ?? (found?.device as bigint));
  // A made-up FILE answers with the device a real file of this disk has (the agent home's), not its folder's: a disk
  // may give the two different devices, and a simulation that assumed one would pass only where they are the same.
  const fileOwn = Promise.all([own, base.identity(`${layout.agentHome}/own.txt`)]).then(
    ([folder, found]) => device ?? found?.device ?? folder,
  );
  return {
    ...base,
    list: async path => (path === sessions ? [...(await base.list(path)), ...names] : await base.list(path)),
    identity: async path => {
      if (path === sessions && device !== undefined) {
        const found = await base.identity(path);
        return found === undefined ? undefined : { ...found, device };
      }
      if (!path.startsWith(`${sessions}/`)) return await base.identity(path);
      const [name, file] = path.slice(sessions.length + 1).split('/') as [string, string | undefined];
      if (!/^[he]\d+$/.test(name)) return await base.identity(path);
      const number = BigInt(name.slice(1));
      if (file === undefined) return made('directory', 1_000_000_000n + number, await own);
      return name.startsWith('h') && file === ENV ? made('file', 2_000_000_000n + number, await fileOwn) : undefined;
    },
  };
}

const agentHomeRoot = (fs: HostFs, home: string): RootHandle =>
  rootsPortFor(fs, { home, plugin: 'codex', worktrees: `${home}-worktrees` }, ['agent-homes'], () => undefined, {
    random: () => 'r',
    privateFiles: LIST,
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

describe('PF-budget the real bound of a `*` collection (65,536 places: the folder and 65,535 members that hold the file) fails closed', () => {
  test('PF-budget 65,535 sessions that hold the file fit: nothing is truncated and an ordinary read is allowed', async () => {
    const l = await home();
    const fs = longLived(REAL, l, { holders: 65_535 });
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(fs, real, INPUT, { wall: LATER }).snapshot();
    expect(snapshot.truncated).toEqual([]);
    expect(snapshot.places.some(place => place.path.endsWith(`h65534/${ENV}`))).toBe(true);
    const root = agentHomeRoot(fs, l.home);
    expect(await root.readText(named(root, 'own.txt'))).toBe('mine');
  }, 60_000);

  test('PF-budget the 65,536th session that holds the file is past it: truncated, closed, and every other root on that device refuses', async () => {
    const l = await home();
    const fs = longLived(REAL, l, { holders: 65_536 });
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(fs, real, INPUT, { wall: LATER }).snapshot();
    expect(snapshot.truncated).toEqual([`${real}/state/ferrets/sessions`]);
    expect(snapshot.closed.length).toBe(1);
    expect(snapshot.budgets).toEqual([{ path: `${real}/state/ferrets/sessions`, limit: 65_536, indexed: 65_536 }]);
    const root = agentHomeRoot(fs, l.home);
    expect(await refusal(() => root.readText(named(root, 'own.txt')))).toBe('refused:fenced');
  }, 60_000);

  test('PF-budget 70,000 session folders that hold nothing and 5 that hold the file are not truncated: only holders count', async () => {
    const l = await home();
    const fs = longLived(REAL, l, { holders: 5, empties: 70_000 });
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(fs, real, INPUT, { wall: LATER }).snapshot();
    expect(snapshot.truncated).toEqual([]);
    expect(snapshot.places.filter(place => place.path.endsWith(ENV)).length).toBe(5);
    const root = agentHomeRoot(fs, l.home);
    expect(await root.readText(named(root, 'own.txt'))).toBe('mine');
  }, 60_000);

  test('PF-budget an owner’s root refuses a member that sits on a closed device (a bind mount from it), and lists the others', async () => {
    const l = await home();
    await mkdir(`${l.parent}/work`, { recursive: true });
    await writeFile(`${l.parent}/work/plain.txt`, 'hello');
    await writeFile(`${l.parent}/work/mounted.txt`, 'from the closed device');
    const real = await realpath(l.home);
    const here = (await REAL.identity(real))?.device as bigint;
    // The closed device is a different one from the work folder's, so the work folder itself is not refused whole.
    const closedDevice = here + 4242n;
    const sessionsFs = longLived(REAL, l, { holders: 65_536 }, closedDevice);
    const bindMount = `${l.parent}/work/mounted.txt`;
    const fs: HostFs = {
      ...sessionsFs,
      identity: async path => {
        const found = await sessionsFs.identity(path);
        return found !== undefined && (path === bindMount || path.endsWith('/mounted.txt'))
          ? { ...found, device: closedDevice, inode: 7_000_000_000n, links: 1 }
          : found;
      },
    };
    const fence = await fenceOf(fs, l.home, LIST);
    expect(fence.closed.has(closedDevice)).toBe(true);
    expect(await fencedReal(fs, fence, `${l.parent}/work/plain.txt`)).toBe(false);
    const work = rootsPortFor(
      fs,
      { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
      ['work'],
      () => ({
        folderOf: () => `${l.parent}/work` as FencedPath,
        check: (_ferret, path) => ok(path as FencedPath),
      }),
      { random: () => 'r', privateFiles: LIST },
    ).root('work', { ferret: 'F1' as FerretId });
    const listed = (await work.entries(named(work, '.'))).map(entry => entry.name);
    expect(listed).toContain('plain.txt');
    expect(listed).not.toContain('mounted.txt');
  }, 60_000);

  /** A login's own root reads while its 4,100 login folders are truncated, on the disk `wrap` makes of the real one. */
  const ownRootStaysOpen = async (wrap: (disk: HostFs) => HostFs): Promise<void> => {
    const l = await home();
    const credentials = `${l.home}/state/logins/credentials`;
    await mkdir(credentials, { recursive: true });
    await writeFile(`${credentials}/own.txt`, 'sealed');
    const fake = Array.from({ length: 4100 }, (_, n) => `L${n}`);
    const real = await realpath(l.home);
    const dev = (await REAL.identity(real))?.device as bigint;
    const fs: HostFs = wrap({
      ...REAL,
      list: async path =>
        path === `${real}/state/logins/credentials` || path === credentials
          ? [...(await REAL.list(path)), ...fake]
          : path.startsWith(`${credentials}/L`) || path.startsWith(`${real}/state/logins/credentials/L`)
            ? []
            : await REAL.list(path),
      identity: async path => {
        const at = path.lastIndexOf('/credentials/L');
        return at === -1
          ? await REAL.identity(path)
          : made('directory', 3_000_000_000n + BigInt(path.slice(at + 14)), dev);
      },
    });
    const snapshot = await privateIndexOf(fs, real, INPUT, { wall: LATER }).snapshot();
    expect(snapshot.truncated).toEqual([`${real}/state/logins/credentials`]);
    const own = rootsPortFor(
      fs,
      { home: l.home, plugin: 'logins', worktrees: `${l.home}-worktrees` },
      ['credentials'],
      () => undefined,
      {
        random: () => 'r',
        privateFiles: LIST,
      },
    ).root('credentials', {});
    expect(await own.readText(named(own, 'own.txt'))).toBe('sealed');
    // Every other root on that device is refused: the control for the read above.
    const stranger = agentHomeRoot(fs, l.home);
    expect(await refusal(() => stranger.readText(named(stranger, 'own.txt')))).toBe('refused:fenced');
  };

  test('PF-budget the tree that is the root’s own is never closed against it: a login’s own root reads while 4,100 login folders are truncated', async () => {
    await ownRootStaysOpen(disk => disk);
  });

  test('PF-budget the same on a disk that gives a file a device of its own (an overlay): the tree is closed on every device it holds', async () => {
    await ownRootStaysOpen(overlayDisk);
  });

  test('PF-budget on a disk that gives a file a device of its own the 65,536th holder closes the file device too, not only its folder’s', async () => {
    const l = await home();
    const fs = overlayDisk(longLived(REAL, l, { holders: 65_536 }));
    const real = await realpath(l.home);
    const snapshot = await privateIndexOf(fs, real, INPUT, { wall: LATER }).snapshot();
    expect(snapshot.truncated).toEqual([`${real}/state/ferrets/sessions`]);
    const folder = (await fs.identity(l.sessions))?.device as bigint;
    const file = (await fs.identity(`${l.agentHome}/own.txt`))?.device as bigint;
    expect(file).not.toBe(folder);
    expect(snapshot.closed[0]?.devices).toEqual(new Set([folder, file]));
    const root = agentHomeRoot(fs, l.home);
    expect(await refusal(() => root.readText(named(root, 'own.txt')))).toBe('refused:fenced');
    const fence = await fenceOf(fs, l.home, LIST);
    expect(fence.closed.has(file)).toBe(true);
  }, 60_000);

  test('PF-budget on a disk that gives a file a device of its own a bind alias of the unindexed 65,536th holder, on a device that is not its root’s, is refused', async () => {
    const l = await home();
    const decoy = `${l.agentHome}/${ENV}`;
    await writeFile(decoy, 'rotated-secret-alias');
    const sessions = overlayDisk(longLived(REAL, l, { holders: 65_536 }));
    const file = (await sessions.identity(`${l.agentHome}/own.txt`))?.device as bigint;
    const folder = (await sessions.identity(l.agentHome))?.device as bigint;
    // The device of the root's own folder is not the device of the file: the alias keeps the source FILE's device.
    expect(file).not.toBe(folder);
    const unindexed = (await sessions.identity(`${l.sessions}/h65535/${ENV}`)) as FileIdentity;
    const fs: HostFs = {
      ...sessions,
      identity: async path =>
        path === decoy ? { ...unindexed, links: 1, inode: 9_000_000_000n } : await sessions.identity(path),
    };
    const root = agentHomeRoot(fs, l.home);
    expect(await refusal(() => root.readText(named(root, ENV)))).toBe('refused:fenced');
    expect(await refusal(() => root.readText(named(root, 'own.txt')))).toBe('refused:fenced');
  }, 60_000);
});

describe('PF-loud a place past its budget is announced once per change, never silent', () => {
  const small = { depth: 3, limit: 4096, patternLimit: 2 } as const;

  test('PF-loud the watcher is told once when a collection passes its budget, and once when it fits again', async () => {
    const l = await home();
    // A budget of 2 holds the folder and one member.
    await fill(l.sessions, 1, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const told: (readonly PlaceBudget[])[] = [];
    const index = privateIndexOf(REAL, real, INPUT, { wall: LATER, bounds: small });
    const watcher = (budgets: readonly PlaceBudget[]): number => told.push(budgets);
    index.watch(watcher);
    index.watch(watcher);
    await index.snapshot();
    expect(told).toEqual([]);
    await fill(l.sessions, 1, () => `s2/${ENV}`);
    await index.snapshot();
    expect(told).toEqual([[{ path: `${real}/state/ferrets/sessions`, limit: 2, indexed: 2 }]]);
    // Still past it: said once, not at every look.
    await index.snapshot();
    await index.snapshot();
    expect(told.length).toBe(1);
    await rm(`${l.sessions}/s2/${ENV}`);
    await index.snapshot();
    expect(told.length).toBe(2);
    expect(told[1]).toEqual([]);
  });

  test('PF-loud a watcher added after the place passed its budget is told at once, and one that throws changes no answer', async () => {
    const l = await home();
    await fill(l.sessions, 3, n => `s${n}/${ENV}`);
    const real = await realpath(l.home);
    const index = privateIndexOf(REAL, real, INPUT, { wall: LATER, bounds: small });
    const first = await index.snapshot();
    const told: (readonly PlaceBudget[])[] = [];
    index.watch(budgets => told.push(budgets));
    expect(told.length).toBe(1);
    index.watch(() => {
      throw new Error('a watcher that fails');
    });
    expect(await index.snapshot()).toBe(first);
  });
});

/** A disk whose directories carry the times a test chooses: one instant for all of them. */
const stamped = (base: HostFs, mtimeNs: bigint, ctimeNs: bigint): HostFs => ({
  ...base,
  identity: async path => {
    const found = await base.identity(path);
    return found?.kind === 'directory' ? { ...found, mtimeNs, ctimeNs } : found;
  },
});

describe('PF-time a clock that cannot tell two changes apart is never trusted', () => {
  test('PF-time the real disk gives every folder a status-change time that is a real time, not zero', async () => {
    const l = await home();
    const found = await REAL.identity(l.agentHome);
    expect(found?.ctimeNs).toBeGreaterThan(0n);
    const now = BigInt(Date.now()) * 1_000_000n;
    const away = (found?.ctimeNs as bigint) > now ? (found?.ctimeNs as bigint) - now : now - (found?.ctimeNs as bigint);
    expect(away).toBeLessThan(60_000_000_000n);
    expect(found?.mtimeNs).toBeGreaterThan(0n);
  });

  test('PF-time a disk with no status-change time (zero) is read again at every look, so a replaced member is still found', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    const quiet: HostFs = {
      ...REAL,
      identity: async path => {
        const found = await REAL.identity(path);
        return found === undefined ? undefined : { ...found, ctimeNs: 0n };
      },
    };
    const meter = counted(quiet);
    const index = privateIndexOf(meter.fs, real, INPUT, { wall: LATER });
    await index.snapshot();
    const lists = meter.lists();
    await index.snapshot();
    await index.snapshot();
    // Nothing changed, and every look still reads the folders again: its clock is not trusted.
    expect(meter.lists()).toBeGreaterThan(lists);
    const first = await index.snapshot();
    await writeFile(`${l.home}/state/logins/credentials/L1/auth.json.new`, 'rotated');
    await rename(
      `${l.home}/state/logins/credentials/L1/auth.json.new`,
      `${l.home}/state/logins/credentials/L1/auth.json`,
    );
    expect(keyOf((await index.snapshot()).places, 'L1/auth.json')).not.toBe(keyOf(first.places, 'L1/auth.json'));
  });

  test('PF-time a filesystem that stamps whole seconds does not miss a member that lands after the look in the same second', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    // Every folder is stamped 7 s exactly, and the clock stands half a second later: the member made next lands in the
    // same second, so nothing the disk reports about the folder changes.
    const stamp = 7_000_000_000n;
    const index = privateIndexOf(stamped(REAL, stamp, stamp), real, INPUT, { wall: () => stamp + 500_000_000n });
    const first = await index.snapshot();
    await writeFile(`${l.home}/state/logins/credentials/L1/.credentials.json`, 'late');
    const after = await index.snapshot();
    expect(after).not.toBe(first);
    expect(after.places.some(place => place.path.endsWith('L1/.credentials.json'))).toBe(true);
  });

  test('PF-time a filesystem that stamps at the millisecond is trusted after the usual 20 ms, not left racy for two seconds', async () => {
    const l = await home();
    await fill(`${l.home}/state/logins/credentials`, 1, () => 'L1/auth.json');
    const real = await realpath(l.home);
    const stamp = 7_000_000_123n;
    const meter = counted(stamped(REAL, stamp, stamp));
    const index = privateIndexOf(meter.fs, real, INPUT, { wall: () => stamp + 500_000_000n });
    await index.snapshot();
    const lists = meter.lists();
    await index.snapshot();
    await index.snapshot();
    expect(meter.lists()).toBe(lists);
  });
});
