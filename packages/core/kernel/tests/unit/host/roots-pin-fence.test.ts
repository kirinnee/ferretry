import { afterEach, describe, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { PinnedRoot, SessionRootPinner } from '../../../contract/pinned.ts';
import { platformRootPinner } from '../../../host/adapters/pinned/index.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { PinRegistry } from '../../../host/pins.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

/**
 * A ferret working in `~`: the pinned `work` root is an ANCESTOR of the state home. The root itself is outside the
 * fence, so the pin's own check passes, and the descriptor walk beneath it knows nothing of the home — every op the
 * pin hands out is judged against the fence again, as each op of an owner's root is (S40, S47).
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const SECRET = 'protected-fixture';
const fs = nodeFs(() => 'r');

/** `<parent>` is the work root; the state home is `<parent>/.ferretry` and a sibling file lives beside it. */
async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-pin-fence-`));
  parents.push(parent);
  const home = `${parent}/.ferretry`;
  await mkdir(`${home}/state/vault`, { recursive: true });
  await writeFile(`${home}/state/vault/vault.key`, SECRET);
  await writeFile(`${parent}/sibling.txt`, 'sibling-bytes');
  await mkdir(`${parent}/project`);
  await writeFile(`${parent}/project/a.ts`, 'project-bytes');
  return { parent, home };
}

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

async function pinOf(home: string, work: string, pinner: SessionRootPinner = platformRootPinner()) {
  const roots = rootsPortFor(
    fs,
    { home, plugin: 'ferrets', worktrees: `${home}-worktrees` },
    ['work'],
    () => workFolders(work),
    { pins: new PinRegistry(() => pinner) },
  );
  const root = roots.root('work', { ferret: 'F1' as FerretId });
  const resolved = root.resolve('.');
  if (!resolved.ok) throw new Error(resolved.error);
  return await root.pin(resolved.value);
}

/** What an op through the pin came to: its text, or the refusal it threw. */
async function outcome(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
}

const read = (pinned: PinnedRoot, rel: string) => async (): Promise<string> => {
  const target = await pinned.open(rel);
  try {
    return new TextDecoder().decode(await target.read(1024));
  } finally {
    await target.close();
  }
};

const listing = (pinned: PinnedRoot, rel: string) => async (): Promise<string> => {
  const target = await pinned.open(rel, { wantDirectory: true });
  try {
    return (await target.list(100)).entries.map(entry => entry.name).join(',');
  } finally {
    await target.close();
  }
};

describe('S40 S47 a pinned work root that is an ancestor of the state home', () => {
  test('S40 S47 a file inside the home is refused through the pin, and a sibling file is served', async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent);
    try {
      expect(await outcome(read(pinned, '.ferretry/state/vault/vault.key'))).toBe('refused:fenced');
      expect(await outcome(read(pinned, 'sibling.txt'))).toBe('sibling-bytes');
      expect(await outcome(read(pinned, 'project/a.ts'))).toBe('project-bytes');
    } finally {
      await pinned.close();
    }
  });

  test('S40 S47 the walk refuses to descend into the home: no listing of it or beneath it, a listing beside it is served', async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent);
    try {
      for (const rel of [
        '.ferretry',
        '.ferretry/state',
        '.ferretry/state/vault',
        '.ferretry/./state',
        'project/../.ferretry',
      ])
        expect(await outcome(listing(pinned, rel))).toBe('refused:fenced');
      expect(await outcome(listing(pinned, 'project'))).toBe('a.ts');
      expect((await outcome(listing(pinned, ''))).split(',').sort()).toEqual(['.ferretry', 'project', 'sibling.txt']);
    } finally {
      await pinned.close();
    }
  });

  test('S40 S47 the probe calls a name inside the home unsupported without walking it, and keeps the others in order', async () => {
    const { parent, home } = await layout();
    const pinned = await pinOf(home, parent);
    const probe = pinned.probe();
    try {
      expect(
        await probe.classify(['sibling.txt', '.ferretry/state/vault/vault.key', 'project/a.ts', 'missing.txt']),
      ).toEqual(['file', 'unsupported', 'file', 'unsupported']);
    } finally {
      await probe.close();
      await pinned.close();
    }
  });

  test('S40 S47 a home file hard-linked into the work folder is refused as hard_link', async () => {
    const { parent, home } = await layout();
    await link(`${home}/state/vault/vault.key`, `${parent}/planted`);
    const pinned = await pinOf(home, parent);
    try {
      expect(await outcome(read(pinned, 'planted'))).toBe('refused:hard_link');
      expect(await outcome(read(pinned, 'sibling.txt'))).toBe('sibling-bytes');
    } finally {
      await pinned.close();
    }
  });

  test('S40 S47 a component that IS the home by device and inode is refused though its name is innocent', async () => {
    const { parent, home } = await layout();
    const homeIdentity = await fs.identity(home);
    if (homeIdentity === undefined) throw new Error('the fixture home has no identity');
    // A walk that reached the home by another name (a bind mount, a case-insensitive spelling): only identity can tell.
    const real = platformRootPinner();
    const aliasing: SessionRootPinner = {
      pin: async (cwd, options) => {
        const held = await real.pin(cwd, options);
        return {
          rootReal: held.rootReal,
          policyCwd: held.policyCwd,
          probe: () => held.probe(),
          close: () => held.close(),
          open: async (rel, openOptions) => {
            const target = await held.open(rel, openOptions);
            return {
              metadata: target.metadata,
              canonical: target.canonical,
              identities: [
                ...target.identities,
                { dev: homeIdentity.device, ino: homeIdentity.inode, ctimeNs: 0n, mode: homeIdentity.mode },
              ],
              read: max => target.read(max),
              list: (max, budget) => target.list(max, budget),
              close: () => target.close(),
            };
          },
        };
      },
    };
    const pinned = await pinOf(home, parent, aliasing);
    try {
      expect(await outcome(read(pinned, 'sibling.txt'))).toBe('refused:fenced');
    } finally {
      await pinned.close();
    }
  });
});
