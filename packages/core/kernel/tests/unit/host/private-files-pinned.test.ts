import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type {
  ComponentIdentity,
  HeldRoot,
  PinnedFileProbe,
  PinnedRoot,
  PinnedTarget,
  PinOptions,
  SessionRootPinner,
} from '../../../contract/pinned.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { platformRootPinner } from '../../../host/adapters/pinned/index.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { fenceOf } from '../../../host/fence-guard.ts';
import { PinRegistry } from '../../../host/pins.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

/**
 * A budget-closed private tree holds its whole device unproven (§7.7): everything not proven public on that device is
 * refused for EVERY root of an owner, the unpinned root and the pinned one (an agent's read through the held
 * descriptor) alike. The disk is faked at the two seams a bind mount shows through, the host's `identity` and the
 * pinner's component identities, because a runner has no second device to mount; the same case table drives both root
 * kinds and their answers must be equal.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const REAL = nodeFs(() => 'r');
const ENV = 'environment.json';
const LIST = composePrivateFiles([
  { id: 'logins', privacy: { private: ['credentials'] } },
  { id: 'ferrets', privacy: { private: ['tokens.json', 'sessions/*/environment.json'] } },
]);

/** The step an inode of an entry on the closed device is moved by, so it is never one the fence already holds. */
const INODE_STEP = 7_000_000_000n;

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-pinned-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const sessions = `${home}/state/ferrets/sessions`;
  const work = `${parent}/work`;
  await mkdir(sessions, { recursive: true });
  await mkdir(`${work}/sub`, { recursive: true });
  await mkdir(`${work}/mountdir`, { recursive: true });
  await writeFile(`${work}/plain.txt`, 'plain-bytes');
  await writeFile(`${work}/sub/other.txt`, 'other-bytes');
  await writeFile(`${work}/mounted.txt`, 'from the closed device');
  await writeFile(`${work}/mountdir/in.txt`, 'inside the closed device');
  return { parent, home, sessions, work };
}
type Layout = Awaited<ReturnType<typeof layout>>;

/** What the disk answers a folder and a file with: the same device, or (an overlay, a bind of a file) two. */
interface Devices {
  readonly folder: bigint;
  readonly file: bigint;
}

/** Whether a root-relative name of the work folder is on the closed device: a bind mount of it, and what is beneath. */
const onClosed = (rel: string): boolean => rel === 'mounted.txt' || rel === 'mountdir' || rel.startsWith('mountdir/');

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
 * The disk of a machine with 65,536 sessions that hold the file (so the sessions tree is closed on `devices`), where the
 * work folder's `mounted.txt` and `mountdir` are bind mounts that keep the closed device.
 */
function closedDisk(l: Layout, devices: Devices): HostFs {
  const holders = Array.from({ length: 65_536 }, (_, n) => `h${n}`);
  return {
    ...REAL,
    list: async path => (path === l.sessions ? [...(await REAL.list(path)), ...holders] : await REAL.list(path)),
    identity: async path => {
      if (path === l.sessions) {
        const found = await REAL.identity(path);
        return found === undefined ? undefined : { ...found, device: devices.folder };
      }
      if (path.startsWith(`${l.sessions}/`)) {
        const [name, file] = path.slice(l.sessions.length + 1).split('/') as [string, string | undefined];
        if (/^h\d+$/.test(name)) {
          const number = BigInt(name.slice(1));
          if (file === undefined) return made('directory', 1_000_000_000n + number, devices.folder);
          return file === ENV ? made('file', 2_000_000_000n + number, devices.file) : undefined;
        }
      }
      const found = await REAL.identity(path);
      if (found === undefined || !path.startsWith(`${l.work}/`) || !onClosed(path.slice(l.work.length + 1)))
        return found;
      return {
        ...found,
        device: found.kind === 'directory' ? devices.folder : devices.file,
        inode: found.inode + INODE_STEP,
        links: 1,
      };
    },
  };
}

/** `inner`, where every component a walk reports for a closed name carries the closed device, as the disk above does. */
function splitPinner(inner: SessionRootPinner, devices: Devices): SessionRootPinner {
  const shift = (target: PinnedTarget): PinnedTarget => {
    if (!onClosed(target.canonical)) return target;
    const last = target.identities.at(-1) as ComponentIdentity;
    const moved: ComponentIdentity = {
      ...last,
      dev: target.metadata.type === 'dir' ? devices.folder : devices.file,
      ino: last.ino + INODE_STEP,
    };
    return {
      metadata: target.metadata,
      canonical: target.canonical,
      identities: [...target.identities.slice(0, -1), moved],
      read: max => target.read(max),
      list: (max, budget) => target.list(max, budget),
      close: () => target.close(),
    };
  };
  return {
    pin: async (cwd: string, options?: PinOptions): Promise<PinnedRoot> => {
      const pinned = await inner.pin(cwd, options);
      return {
        rootReal: pinned.rootReal,
        policyCwd: pinned.policyCwd,
        open: async (rel, openOptions) => shift(await pinned.open(rel, openOptions)),
        probe: (): PinnedFileProbe => pinned.probe(),
        close: () => pinned.close(),
      };
    },
  };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

/** One owner's `work` root on the closed disk: the unpinned handle, and the registry its pins come from. */
function workRoot(l: Layout, fs: HostFs, devices: Devices): RootHandle {
  return rootsPortFor(
    fs,
    { home: l.home, plugin: 'ferrets', worktrees: `${l.home}-worktrees` },
    ['work'],
    () => workFolders(l.work),
    { random: () => 'r', privateFiles: LIST, pins: new PinRegistry(() => splitPinner(platformRootPinner(), devices)) },
  ).root('work', { ferret: 'F1' as FerretId });
}

const named = (root: RootHandle, relative: string): FencedPath => {
  const path = root.resolve(relative);
  if (!path.ok) throw new Error(`resolve ${relative}: ${path.error}`);
  return path.value;
};

/** What an op came to: `allowed`, or the refusal it threw. */
const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
};

type Operation = 'read' | 'stat' | 'list';
interface Door {
  readonly kind: 'unpinned' | 'pinned';
  readonly run: (op: Operation, rel: string) => Promise<string>;
  readonly pinned?: HeldRoot;
  readonly close: () => Promise<void>;
}

const unpinnedDoor = (root: RootHandle): Door => ({
  kind: 'unpinned',
  close: async () => {},
  run: (op, rel) =>
    outcome(async () => {
      const path = named(root, rel);
      if (op === 'read') await root.readText(path);
      else if (op === 'stat') await root.stat(path);
      else await root.entries(path);
    }),
});

const pinnedDoor = async (root: RootHandle): Promise<Door> => {
  const pinned = await root.pin(named(root, '.'));
  return {
    kind: 'pinned',
    pinned,
    close: () => pinned.close(),
    run: (op, rel) =>
      outcome(async () => {
        const target = await pinned.open(rel, op === 'list' ? { wantDirectory: true } : undefined);
        try {
          if (op === 'read') await target.read(1024);
          else if (op === 'list') await target.list(100);
        } finally {
          await target.close();
        }
      }),
  };
};

/**
 * Every case: the answer is the same for both roots. A refused name is on the closed device; the others are not.
 * `stat` of a pinned name is the open itself (the descriptor's metadata), so it shares the walk of `read`.
 */
const CASES: readonly { readonly rel: string; readonly op: Operation; readonly answer: string }[] = [
  { rel: 'plain.txt', op: 'read', answer: 'allowed' },
  { rel: 'plain.txt', op: 'stat', answer: 'allowed' },
  { rel: 'sub/other.txt', op: 'read', answer: 'allowed' },
  { rel: 'sub', op: 'list', answer: 'allowed' },
  { rel: '.', op: 'list', answer: 'allowed' },
  { rel: 'mounted.txt', op: 'read', answer: 'refused:fenced' },
  { rel: 'mounted.txt', op: 'stat', answer: 'refused:fenced' },
  { rel: 'mountdir', op: 'list', answer: 'refused:fenced' },
  { rel: 'mountdir', op: 'stat', answer: 'refused:fenced' },
  { rel: 'mountdir/in.txt', op: 'read', answer: 'refused:fenced' },
  { rel: 'mountdir/in.txt', op: 'stat', answer: 'refused:fenced' },
];

const DISKS: readonly { readonly name: string; readonly devices: (here: bigint) => Devices }[] = [
  { name: 'one device for folders and files', devices: here => ({ folder: here + 4242n, file: here + 4242n }) },
  {
    name: 'a device of its own for a file (an overlay, a bind mount of a file)',
    devices: here => ({ folder: here + 4242n, file: here + 4249n }),
  },
];

describe.each(DISKS)('PF-budget a closed tree is closed against every root of an owner: $name', ({ devices }) => {
  const setup = async () => {
    const l = await layout();
    const here = ((await REAL.identity(l.work)) as FileIdentity).device;
    const split = devices(here);
    const fs = closedDisk(l, split);
    const fence = await fenceOf(fs, l.home, LIST);
    expect(fence.closed.has(split.folder)).toBe(true);
    expect(fence.closed.has(split.file)).toBe(true);
    // The work folder is on the real disk, so it is not refused whole: the control for the table.
    expect(fence.closed.has(here)).toBe(false);
    return { l, split, root: workRoot(l, fs, split) };
  };

  test.each(CASES)(
    'PF-budget the unpinned root and the pinned root answer alike, and as the closed device demands: $op $rel is $answer',
    async ({ rel, op, answer }) => {
      const { root } = await setup();
      const doors = [unpinnedDoor(root), await pinnedDoor(root)];
      try {
        const answers = await Promise.all(doors.map(door => door.run(op, rel)));
        expect(answers).toEqual([answer, answer]);
      } finally {
        for (const door of doors) await door.close();
      }
    },
    120_000,
  );

  test('PF-budget the pinned root’s name verdict refuses an entry on the closed device, and the probe skips what sits inside it', async () => {
    const { root } = await setup();
    const door = await pinnedDoor(root);
    const pinned = door.pinned as HeldRoot;
    const probe = pinned.probe();
    try {
      expect(await pinned.fenced(['plain.txt', 'sub/other.txt', 'mounted.txt', 'mountdir', 'mountdir/in.txt'])).toEqual(
        [false, false, true, true, true],
      );
      // A folder that is on the closed device is not walked: what is beneath it is `unsupported`. A file's own kind is
      // a verdict about the name (the read re-walks and refuses), so it is answered as a key file's is.
      expect(await probe.classify(['plain.txt', 'sub/other.txt', 'mountdir/in.txt'])).toEqual([
        'file',
        'file',
        'unsupported',
      ]);
    } finally {
      await probe.close();
      await door.close();
    }
  }, 120_000);

  test('PF-budget remove on an owner’s root refuses an entry on the closed device and removes the others', async () => {
    const { l, root } = await setup();
    for (const rel of ['mounted.txt', 'mountdir/in.txt'])
      expect(await outcome(() => root.remove(named(root, rel))), rel).toBe('refused:fenced');
    expect(await outcome(() => root.remove(named(root, 'plain.txt')))).toBe('allowed');
    expect(await Bun.file(`${l.work}/mounted.txt`).exists()).toBe(true);
    expect(await Bun.file(`${l.work}/mountdir/in.txt`).exists()).toBe(true);
    expect(await Bun.file(`${l.work}/plain.txt`).exists()).toBe(false);
  }, 120_000);
});

describe('PF-budget the tree that is the root’s own is never closed against it, pinned or not', () => {
  test('PF-budget a login’s own root, held open, reads while its 4,100 login folders are truncated, and a stranger’s pin is refused', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-pinned-own-`));
    parents.push(parent);
    const home = `${parent}/home`;
    const credentials = `${home}/state/logins/credentials`;
    const agentHome = `${home}/state/codex/agent-homes/F1`;
    await mkdir(credentials, { recursive: true });
    await mkdir(agentHome, { recursive: true });
    await writeFile(`${credentials}/own.txt`, 'sealed');
    await writeFile(`${agentHome}/own.txt`, 'mine');
    const real = await realpath(home);
    const dev = ((await REAL.identity(real)) as FileIdentity).device;
    const fake = Array.from({ length: 4100 }, (_, n) => `L${n}`);
    const fs: HostFs = {
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
    };
    const pins = new PinRegistry(() => platformRootPinner());
    const own = rootsPortFor(
      fs,
      { home, plugin: 'logins', worktrees: `${home}-worktrees` },
      ['credentials'],
      () => undefined,
      {
        random: () => 'r',
        privateFiles: LIST,
        pins,
      },
    ).root('credentials', {});
    const stranger = rootsPortFor(
      fs,
      { home, plugin: 'codex', worktrees: `${home}-worktrees` },
      ['agent-homes'],
      () => undefined,
      {
        random: () => 'r',
        privateFiles: LIST,
        pins,
      },
    ).root('agent-homes', { subfolder: 'F1' });
    const ownPin = await own.pin(named(own, '.'));
    const strangerPin = await stranger.pin(named(stranger, '.')).catch((error: unknown) => error);
    try {
      const target = await ownPin.open('own.txt');
      try {
        expect(new TextDecoder().decode(await target.read(64))).toBe('sealed');
      } finally {
        await target.close();
      }
      // The control: the same truncated tree closes its device against every other root, pinned or not.
      if (strangerPin instanceof Error) expect(strangerPin).toBeInstanceOf(RootError);
      else {
        expect(await outcome(async () => (await (strangerPin as HeldRoot).open('own.txt')).close())).toBe(
          'refused:fenced',
        );
        await (strangerPin as HeldRoot).close();
      }
    } finally {
      await ownPin.close();
    }
  }, 60_000);
});
