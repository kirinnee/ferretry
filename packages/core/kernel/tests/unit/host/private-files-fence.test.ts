import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../host/adapters/pinned/index.ts';
import { PinRegistry } from '../../../host/pins.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

/**
 * The private-files fence at the unit tier: the REAL roots over real temp folders. A plugin declares the files a ferret
 * must never reach (`privacy.private`); the kernel composes the list and the fence of EVERY root — an owner's, an
 * internal one, a harness file — holds each by IDENTITY, so a bind mount or alias of one is refused under any name.
 *
 * A bind mount cannot be made without privilege in a unit test, so it is SIMULATED at the disk seam: `bound` makes one
 * name answer with another file's device and inode and ONE link — exactly what a bind mount shows — while the
 * hard-link variant uses a real second name. The composed list is the only thing that differs between a refusal and
 * an allowance, so every test also proves the same door ALLOWS the name once the entry is dropped from the list.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const SECRET_BYTES = 'private-fixture';
const REAL = nodeFs(() => 'r');
/** What the composed list holds for one plugin that declared `secret.key` private. */
const PRIVATE = ['state/vaultish/secret.key'];

/** A name that answers as another file does, with ONE link: what a bind mount of that file shows. */
function bound(base: HostFs, decoy: string, source: string): HostFs {
  const lie = (identity: FileIdentity): FileIdentity => ({ ...identity, links: 1 });
  // The name itself, or the same leaf reached through a folder descriptor (`/proc/self/fd/N/<leaf>`): one mount, two spellings.
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

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-private-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const agentHome = `${home}/state/codex/agent-homes/F1`;
  const key = `${home}/state/vaultish/secret.key`;
  await mkdir(`${home}/state/vaultish`, { recursive: true });
  await writeFile(key, SECRET_BYTES);
  await mkdir(agentHome, { recursive: true });
  await writeFile(`${agentHome}/own.txt`, 'mine');
  await mkdir(work, { recursive: true });
  await writeFile(`${work}/notes.md`, 'hello');
  return { parent, home, work, agentHome, key };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

type Layout = Awaited<ReturnType<typeof layout>>;

interface Door {
  readonly label: string;
  /** Whether the root takes writes at all (an owner's import folder is read-only through every handle). */
  readonly writable: boolean;
  /** Where the decoy name lives, absolute. */
  readonly folder: (l: Layout) => string;
  readonly make: (l: Layout, fs: HostFs, privateFiles: readonly string[]) => RootHandle;
}

function makeRoot(
  home: string,
  fs: HostFs,
  name: RootName,
  scope: { readonly ferret?: FerretId; readonly subfolder?: string },
  privateFiles: readonly string[],
  work?: string,
  pins?: PinRegistry,
): RootHandle {
  const roots = rootsPortFor(
    fs,
    { home, plugin: 'codex', worktrees: `${home}-worktrees` },
    [name],
    () => (work === undefined ? undefined : workFolders(work)),
    { random: () => 'r', privateFiles, setMode: true, ...(pins === undefined ? {} : { pins }) },
  );
  return roots.root(name, scope);
}

/** Every kind of root that could hold the decoy: an owner's (`work`, `imports`) and an internal one (`agent-homes`). */
const DOORS: readonly Door[] = [
  {
    label: 'work',
    writable: true,
    folder: l => l.work,
    make: (l, fs, list) => makeRoot(l.home, fs, 'work', { ferret: 'F1' as FerretId }, list, l.work),
  },
  {
    label: 'imports',
    writable: false,
    folder: l => l.work,
    make: (l, fs, list) => makeRoot(l.home, fs, 'imports', { subfolder: l.work }, list),
  },
  {
    label: 'agent-homes',
    writable: true,
    folder: l => l.agentHome,
    make: (l, fs, list) => makeRoot(l.home, fs, 'agent-homes', { subfolder: 'F1' }, list),
  },
];

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

/** The decoy under a spelling that is NOT the private file's: case, folders and a dot segment are only spellings. */
const DECOY = 'Secret.KEY';

describe('PF-doors every root refuses a private file reached under another name, by identity', () => {
  for (const door of DOORS) {
    describe(`PF-doors the ${door.label} root`, () => {
      async function planted() {
        const l = await layout();
        const decoy = `${door.folder(l)}/${DECOY}`;
        await writeFile(decoy, 'decoy');
        return { l, decoy, fs: bound(REAL, decoy, l.key) };
      }

      test(`PF-doors ${door.label}: every read door says fenced (a bind mount: one link, the key's device and inode)`, async () => {
        const { l, fs } = await planted();
        const root = door.make(l, fs, PRIVATE);
        const path = named(root, DECOY);
        expect(await refusal(() => root.readText(path))).toBe('refused:fenced');
        expect(await refusal(() => root.readBytes(path))).toBe('refused:fenced');
        expect(await refusal(() => root.readBytes(path, { offset: 0, length: 4 }))).toBe('refused:fenced');
        expect(await refusal(() => root.readTail(path, 64))).toBe('refused:fenced');
        expect(await refusal(() => root.readDurable(path))).toBe('refused:fenced');
        expect(await readFile(l.key, 'utf8')).toBe(SECRET_BYTES);
      });

      test(`PF-doors ${door.label}: the same bind mount is READ once the entry is dropped from the composed list`, async () => {
        const { l, fs } = await planted();
        const root = door.make(l, fs, []);
        // The mutation the per-file tests prove: with no entry, nothing but the declaration stood in the way.
        expect(await refusal(() => root.readText(named(root, DECOY)))).toBe('allowed');
      });

      test(`PF-doors ${door.label}: a real hard link to the key is fenced, not merely a hard link`, async () => {
        const l = await layout();
        await link(l.key, `${door.folder(l)}/${DECOY}`);
        const root = door.make(l, REAL, PRIVATE);
        expect(await refusal(() => root.readText(named(root, DECOY)))).toBe('refused:fenced');
        expect(await refusal(() => root.readDurable(named(root, DECOY)))).toBe('refused:fenced');
      });

      test(`PF-doors ${door.label}: stat, lstat and fileIdentity tell nothing about the private file`, async () => {
        const { l, fs } = await planted();
        const root = door.make(l, fs, PRIVATE);
        const path = named(root, DECOY);
        expect(await refusal(() => root.stat(path))).toBe('refused:fenced');
        expect(await refusal(() => root.lstat(path))).toBe('refused:fenced');
        expect(await refusal(() => root.fileIdentity(path))).toBe('refused:fenced');
      });

      test(`PF-doors ${door.label}: write, rename-over and delete of the name are refused, and the key is unchanged`, async () => {
        const { l, fs, decoy } = await planted();
        const root = door.make(l, fs, PRIVATE);
        const path = named(root, DECOY);
        if (!door.writable) {
          expect(await refusal(() => root.writeText(path, 'x'))).toBe('refused:read_only');
          expect(await refusal(() => root.remove(path))).toBe('refused:read_only');
          return;
        }
        expect(await refusal(() => root.writeText(path, 'overwritten'))).toBe('refused:fenced');
        expect(await refusal(() => root.writeBytes(path, new Uint8Array([1, 2, 3])))).toBe('refused:fenced');
        // rename-over as the TARGET: both leaf-only write modes and the durable publish replace a name by rename.
        expect(await refusal(() => root.writeText(path, 'over', { replaceExisting: true }))).toBe('refused:fenced');
        expect(await refusal(() => root.publish(path, new Uint8Array([9])))).toBe('refused:fenced');
        expect(await refusal(() => root.publish(path, new Uint8Array([9]), { exclusive: true }))).toBe(
          'refused:fenced',
        );
        expect(await refusal(() => root.remove(path))).toBe('refused:fenced');
        expect(await refusal(() => root.setMode(path, 0o600))).toBe('refused:fenced');
        expect(await readFile(l.key, 'utf8')).toBe(SECRET_BYTES);
        expect(await readFile(decoy, 'utf8')).toBe('decoy');
      });

      test(`PF-doors ${door.label}: a copy of the folder holding the name carries nothing of it out`, async () => {
        const { l, fs } = await planted();
        const root = door.make(l, fs, PRIVATE);
        const from = named(root, '.');
        const to = named(root, 'copied');
        expect(await refusal(() => root.copyTree(root, from, to))).toBe(
          door.writable ? 'refused:fenced' : 'refused:read_only',
        );
        const copied = await root.list(to).catch(() => []);
        expect(copied.join(',')).not.toContain('Secret');
      });

      test(`PF-doors ${door.label}: removing the folder that holds the name never removes it`, async () => {
        const { l, fs, decoy } = await planted();
        const root = door.make(l, fs, PRIVATE);
        const from = named(root, '.');
        if (door.label === 'agent-homes') {
          expect(await refusal(() => root.remove(from))).toBe('refused:fenced');
          expect(await readFile(decoy, 'utf8')).toBe('decoy');
        }
        expect(await readFile(l.key, 'utf8')).toBe(SECRET_BYTES);
      });
    });
  }

  test('PF-doors a spelling is not a defence: a double slash, a dot segment and a case variant reach the same verdict', async () => {
    const l = await layout();
    const decoy = `${l.agentHome}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const root = DOORS[2]?.make(l, bound(REAL, decoy, l.key), PRIVATE) as RootHandle;
    for (const spelling of [DECOY, `./${DECOY}`, `.//${DECOY}`, `sub/../${DECOY}`]) {
      const resolved = root.resolve(spelling);
      if (!resolved.ok) expect(resolved.error).toBe('outside');
      else expect(await refusal(() => root.readText(resolved.value))).toBe('refused:fenced');
    }
    // a `..` that leaves the root is refused before any disk is asked
    const out = root.resolve('../../../../vaultish/secret.key');
    expect(out.ok).toBe(false);
  });

  test('PF-doors an internal root reads its own files and its own sibling folders as before', async () => {
    const l = await layout();
    const root = DOORS[2]?.make(l, REAL, PRIVATE) as RootHandle;
    expect(await root.readText(named(root, 'own.txt'))).toBe('mine');
    await root.writeText(named(root, 'new.txt'), 'fresh');
    expect(await root.readText(named(root, 'new.txt'))).toBe('fresh');
    await root.publish(named(root, 'p.txt'), new TextEncoder().encode('durable'));
    expect(await root.readText(named(root, 'p.txt'))).toBe('durable');
    await root.remove(named(root, 'new.txt'));
    expect(await root.list(named(root, '.'))).not.toContain('new.txt');
  });

  test('PF-doors a private file is refused when reached through ANOTHER plugin root: the private place of one plugin, an agent home of another', async () => {
    const l = await layout();
    // `state/vaultish/secret.key` belongs to a plugin that is not the one holding this agent home.
    const decoy = `${l.agentHome}/borrowed.json`;
    await writeFile(decoy, 'x');
    const root = DOORS[2]?.make(l, bound(REAL, decoy, l.key), PRIVATE) as RootHandle;
    expect(await refusal(() => root.readText(named(root, 'borrowed.json')))).toBe('refused:fenced');
  });
});

describe('PF-links linkTo refuses a private file as the link target and as the link place', () => {
  test('PF-links the target is a name of the same plugin that is the key by identity: refused fenced', async () => {
    const l = await layout();
    const decoy = `${l.agentHome}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const root = makeRoot(l.home, bound(REAL, decoy, l.key), 'agent-homes', { subfolder: 'F1' }, PRIVATE);
    expect(await refusal(() => root.linkTo(named(root, 'pointer'), { root, path: named(root, DECOY) }))).toBe(
      'refused:fenced',
    );
  });

  test('PF-links the link place is a name that is the key by identity: refused fenced', async () => {
    const l = await layout();
    const decoy = `${l.agentHome}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    const root = makeRoot(l.home, bound(REAL, decoy, l.key), 'agent-homes', { subfolder: 'F1' }, PRIVATE);
    expect(await refusal(() => root.linkTo(named(root, DECOY), { root, path: named(root, 'own.txt') }))).toBe(
      'refused:fenced',
    );
  });

  test('PF-links an ordinary link target and place still work', async () => {
    const l = await layout();
    const root = makeRoot(l.home, REAL, 'agent-homes', { subfolder: 'F1' }, PRIVATE);
    await root.linkTo(named(root, 'pointer'), { root, path: named(root, 'own.txt') });
    expect(await root.lstat(named(root, 'pointer'))).toMatchObject({ kind: 'symlink' });
  });
});

describe('PF-pin a pinned root judges every component the walk opens against the private places', () => {
  const pinner = platformRootPinner();

  test('PF-pin an internal root: a hard link of the key under any name is refused through the pin, an own file is served', async () => {
    const l = await layout();
    await link(l.key, `${l.agentHome}/${DECOY}`);
    const root = makeRoot(
      l.home,
      REAL,
      'agent-homes',
      { subfolder: 'F1' },
      PRIVATE,
      undefined,
      new PinRegistry(() => pinner),
    );
    const pinned = await root.pin(named(root, '.'));
    try {
      const attempt = async (rel: string): Promise<string> => {
        try {
          const target = await pinned.open(rel);
          try {
            return new TextDecoder().decode(await target.read(1024));
          } finally {
            await target.close();
          }
        } catch (error) {
          return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
        }
      };
      expect(await attempt(DECOY)).toBe('refused:fenced');
      expect(await attempt('own.txt')).toBe('mine');
      expect(await pinned.fenced([DECOY, 'own.txt'])).toEqual([true, false]);
    } finally {
      await pinned.close();
    }
  });

  test('PF-pin an owner root pinned above the key: a hard link under any name is refused, a sibling is served', async () => {
    const l = await layout();
    await link(l.key, `${l.work}/${DECOY}`);
    const root = makeRoot(
      l.home,
      REAL,
      'work',
      { ferret: 'F1' as FerretId },
      PRIVATE,
      l.work,
      new PinRegistry(() => pinner),
    );
    const pinned = await root.pin(named(root, '.'));
    try {
      const target = pinned.open('notes.md');
      expect(new TextDecoder().decode(await (await target).read(64))).toBe('hello');
      await expect(pinned.open(DECOY)).rejects.toMatchObject({ refusal: 'fenced' });
    } finally {
      await pinned.close();
    }
  });
});

describe('PF-harness a harness file beside a harness home refuses a private file by identity', () => {
  test('PF-harness the named file that is the key by identity is fenced; the entry dropped, it is read', async () => {
    const l = await layout();
    await mkdir(`${l.parent}/ext`, { recursive: true });
    const outside = `${l.parent}/ext/.claude.json`;
    await writeFile(outside, '{}');
    const harness = (list: readonly string[]) =>
      rootsPortFor(
        bound(REAL, outside, l.key),
        { home: l.home, plugin: 'runtimes', worktrees: `${l.home}-worktrees` },
        ['harness-home'],
        () => undefined,
        { harnessFiles: ['.claude.json'], privateFiles: list },
      ).harnessFile(outside);
    expect(await refusal(async () => await harness(PRIVATE).readText())).toBe('refused:fenced');
    expect(await refusal(async () => await harness(PRIVATE).readDurable())).toBe('refused:fenced');
    expect(await refusal(async () => await harness([]).readText())).toBe('allowed');
  });
});

describe('PF-shared a shared tree and the source of a copy are judged by the same fence', () => {
  test('PF-shared a copy whose SOURCE folder holds a name that is the key by identity is refused', async () => {
    const l = await layout();
    const decoy = `${l.agentHome}/${DECOY}`;
    await writeFile(decoy, 'decoy');
    await mkdir(`${l.home}/state/codex/agent-homes/F2`, { recursive: true });
    const fs = bound(REAL, decoy, l.key);
    const roots = rootsPortFor(
      fs,
      { home: l.home, plugin: 'codex', worktrees: `${l.home}-worktrees` },
      ['agent-homes'],
      () => undefined,
      { random: () => 'r', privateFiles: PRIVATE },
    );
    const from = roots.root('agent-homes', { subfolder: 'F1' });
    const to = roots.root('agent-homes', { subfolder: 'F2' });
    expect(await refusal(() => to.copyTree(from, named(from, '.'), named(to, 'copy')))).toBe('refused:fenced');
    expect(await to.list(named(to, '.')).then(names => names.join(','))).not.toContain('copy/Secret');
  });
});

/** A name that is an ordinary file until it is OPENED, and then answers as another file does (swapped in between). */
function boundOnOpen(base: HostFs, decoy: string, source: string): HostFs {
  let swapped = false;
  const lie = (identity: FileIdentity): FileIdentity => ({ ...identity, links: 1 });
  const isDecoy = (path: string): boolean =>
    path === decoy || (path.startsWith('/proc/self/fd/') && path.endsWith(`/${basename(decoy)}`));
  return {
    ...base,
    identity: async path => {
      if (!swapped || !isDecoy(path)) return await base.identity(path);
      const found = await base.identity(source);
      return found === undefined ? undefined : lie(found);
    },
    openRead: async path => {
      if (!isDecoy(path)) return await base.openRead(path);
      swapped = true;
      const opened = await base.openRead(source);
      return { ...opened, identity: lie(opened.identity) };
    },
  };
}

describe('PF-race what is OPENED is judged again: a name swapped for the key between the check and the open is refused', () => {
  for (const door of DOORS) {
    test(`PF-race ${door.label}: the open descriptor is the key by identity, so the read is fenced, not served`, async () => {
      const l = await layout();
      const decoy = `${door.folder(l)}/${DECOY}`;
      await writeFile(decoy, 'decoy');
      const root = door.make(l, boundOnOpen(REAL, decoy, l.key), PRIVATE);
      expect(await refusal(() => root.readText(named(root, DECOY)))).toBe('refused:fenced');
    });
  }
});

/** The roots port for `plugin` (`credentials` is Logins' alone), one unscoped internal root. */
const ownRoot = (home: string, name: RootName, privateFiles: readonly string[]): RootHandle =>
  rootsPortFor(REAL, { home, plugin: 'logins', worktrees: `${home}-worktrees` }, [name], () => undefined, {
    random: () => 'r',
    privateFiles,
  }).root(name, {});

describe('PF-own an internal root is never refused its own place, whatever the list holds above or around it', () => {
  test('PF-own the unscoped agent-homes, downloads and credentials roots read and write their own files', async () => {
    const l = await layout();
    for (const name of ['agent-homes', 'downloads', 'credentials'] as const) {
      await mkdir(`${l.home}/state/logins/${name}`, { recursive: true });
      const root = ownRoot(l.home, name, [...PRIVATE, `state/logins/${name}`, 'state/logins']);
      await root.writeText(named(root, 'own.txt'), name);
      expect(await root.readText(named(root, 'own.txt'))).toBe(name);
      expect(await root.list(named(root, '.'))).toContain('own.txt');
    }
  });

  test('PF-own a folder the plugin declared private is its own root: declaring it does not lock the owner out', async () => {
    const l = await layout();
    await mkdir(`${l.home}/state/logins/credentials/login-1`, { recursive: true });
    await writeFile(`${l.home}/state/logins/credentials/login-1/token`, 'sealed');
    const root = ownRoot(l.home, 'credentials', ['state/logins/credentials']);
    expect(await root.readText(named(root, 'login-1/token'))).toBe('sealed');
  });
});
