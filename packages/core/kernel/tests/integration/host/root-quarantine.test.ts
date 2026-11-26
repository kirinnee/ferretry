import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath, RootHandle } from '../../../contract/index.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import type { FolderSteps } from '../../../host/adapters/pinned/descriptor-folder.ts';
import { rootsPortFor } from '../../../host/roots.ts';
import { loadDescriptorCalls } from '../../../host/adapters/pinned/descriptor-calls.ts';
import { loadProcessBracket } from '../../../host/adapters/pinned/descriptor-bracket.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const at = (root: RootHandle, name: string): FencedPath => {
  const resolved = root.resolve(name);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

for (const descriptorPath of [true, false]) {
  test(`a veto after the device preflight keeps every checkout entry (descriptor path ${descriptorPath})`, async () => {
    const fs = nodeFs(
      () => crypto.randomUUID(),
      descriptorPath
        ? {}
        : {
            descriptorFolder: '/nonexistent-descriptor-folder',
            descriptorCalls: loadDescriptorCalls,
            bracket: loadProcessBracket,
          },
    );
    let lateLock = false;
    const wrap = (steps: FolderSteps): FolderSteps => {
      const removal = steps.removal;
      return removal === undefined
        ? steps
        : {
            ...steps,
            removal: {
              ...removal,
              list: async () => {
                const names = await removal.list();
                lateLock = true;
                return names;
              },
              openFolder: async name => {
                const child = await removal.openFolder(name);
                return { ...child, steps: wrap(child.steps) };
              },
            },
          };
    };
    const f = await fresh({
      ...fs,
      list: async target => {
        const names = await fs.list(target);
        lateLock = true;
        return names;
      },
      openDirectory: async target => {
        const folder = await fs.openDirectory(target);
        return { ...folder, at: folder.at === undefined ? undefined : wrap(folder.at) };
      },
    });
    await expect(
      f.root.remove(f.checkout, {
        expectedIdentity: f.identity,
        beforeDelete: async () => {
          if (lateLock) throw new Error('synthetic late lock');
        },
      }),
    ).rejects.toThrow('synthetic late lock');
    expect(await readFile(`${f.checkout}/keep`, 'utf8')).toBe('verified');
  });
}
async function fresh(fs: HostFs = nodeFs(() => crypto.randomUUID())) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-quarantine-`));
  parents.push(parent);
  const worktrees = `${parent}/worktrees`;
  await mkdir(`${parent}/home/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${parent}/home/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${worktrees}/checkout`, { recursive: true });
  await writeFile(`${worktrees}/checkout/keep`, 'verified');
  const root = rootsPortFor(
    fs,
    { home: `${parent}/home`, worktrees, plugin: 'ferrets' },
    ['worktrees'],
    () => undefined,
    {},
  ).root('worktrees');
  const checkout = at(root, 'checkout');
  const identity = await root.fileIdentity(checkout);
  if (identity === undefined) throw new Error('missing fixture');
  return { root, checkout, identity, worktrees };
}

test('expected identity refuses a replacement without deleting its contents', async () => {
  const f = await fresh();
  await rename(f.checkout, `${f.worktrees}/original`);
  await mkdir(f.checkout);
  await writeFile(`${f.checkout}/keep`, 'replacement');
  await expect(f.root.remove(f.checkout, { expectedIdentity: f.identity })).rejects.toMatchObject({
    refusal: 'changed',
  });
  expect(await readFile(`${f.checkout}/keep`, 'utf8')).toBe('replacement');
});

for (const descriptorPath of [true, false])
  test(`quarantine deletion preserves a replacement (descriptor path ${descriptorPath})`, async () => {
    const f = await fresh(
      nodeFs(
        () => crypto.randomUUID(),
        descriptorPath
          ? {}
          : {
              descriptorFolder: '/nonexistent-descriptor-folder',
              descriptorCalls: loadDescriptorCalls,
              bracket: loadProcessBracket,
            },
      ),
    );
    const quarantine = at(f.root, '.fy-remove-fixture');
    await f.root.quarantineRename!(f.checkout, quarantine, f.identity);
    await mkdir(f.checkout);
    await writeFile(`${f.checkout}/keep`, 'replacement');
    await f.root.remove(quarantine, { expectedIdentity: f.identity });
    expect(await f.root.lstat(quarantine)).toBeUndefined();
    expect(await readFile(`${f.checkout}/keep`, 'utf8')).toBe('replacement');
  });

test('a source swap is preserved at recovery when the original name is occupied during restoration', async () => {
  const fs = nodeFs(() => crypto.randomUUID());
  let f: Awaited<ReturnType<typeof fresh>>;
  f = await fresh({
    ...fs,
    openDirectory: async path => {
      const folder = await fs.openDirectory(path);
      const move = folder.renameNoReplace;
      if (move !== undefined)
        Object.assign(folder, {
          renameNoReplace: async (from: string, into: typeof folder, to: string) => {
            if (from === 'checkout') {
              await rename(f.checkout, `${f.worktrees}/original`);
              await mkdir(f.checkout);
              await writeFile(`${f.checkout}/keep`, 'moved replacement');
              await move(from, into, to);
              await mkdir(f.checkout);
              await writeFile(`${f.checkout}/keep`, 'new arrival');
            } else await move(from, into, to);
          },
        });
      return folder;
    },
  });
  const quarantine = at(f.root, '.fy-remove-fixture');
  await expect(f.root.quarantineRename!(f.checkout, quarantine, f.identity)).rejects.toMatchObject({
    refusal: 'changed',
  });
  expect(await readFile(`${quarantine}/keep`, 'utf8')).toBe('moved replacement');
  expect(await readFile(`${f.checkout}/keep`, 'utf8')).toBe('new arrival');
});

for (const available of [true, false])
  test(`a swap inside rename is refused and preserved (exclusive primitive ${available})`, async () => {
    const fs = nodeFs(
      () => crypto.randomUUID(),
      available
        ? {}
        : {
            noReplaceRename: () => {
              throw new Error('injected unavailable');
            },
          },
    );
    let f: Awaited<ReturnType<typeof fresh>>;
    let swapped = false;
    const swap = async () => {
      if (swapped) return;
      swapped = true;
      await rename(f.checkout, `${f.worktrees}/original`);
      await mkdir(f.checkout);
      await writeFile(`${f.checkout}/keep`, 'replacement');
    };
    f = await fresh({
      ...fs,
      openDirectory: async path => {
        const folder = await fs.openDirectory(path);
        const move = folder.renameNoReplace;
        if (move !== undefined)
          Object.assign(folder, {
            renameNoReplace: async (from: string, into: typeof folder, to: string) => {
              if (from === 'checkout') await swap();
              await move(from, into, to);
            },
          });
        return folder;
      },
      rename: async (from, to) => {
        if (from.endsWith('/checkout')) await swap();
        await fs.rename(from, to);
      },
    });
    const quarantine = at(f.root, '.fy-remove-fixture');
    await expect(f.root.quarantineRename!(f.checkout, quarantine, f.identity)).rejects.toMatchObject({
      refusal: 'changed',
    });
    expect(swapped).toBe(true);
    expect(await readFile(`${available ? f.checkout : quarantine}/keep`, 'utf8')).toBe('replacement');
    expect(await readFile(`${f.worktrees}/original/keep`, 'utf8')).toBe('verified');
  });

test('an occupied recovery name and an arbitrary rename destination are refused', async () => {
  const f = await fresh();
  const quarantine = at(f.root, '.fy-remove-fixture');
  await mkdir(quarantine);
  await expect(f.root.quarantineRename!(f.checkout, quarantine, f.identity)).rejects.toMatchObject({
    refusal: 'changed',
  });
  await expect(f.root.quarantineRename!(f.checkout, at(f.root, 'arbitrary'), f.identity)).rejects.toMatchObject({
    refusal: 'outside',
  });
  expect(await readFile(`${f.checkout}/keep`, 'utf8')).toBe('verified');
});

test('unavailable exclusive rename still quarantines and deletes a matching tree', async () => {
  const f = await fresh(
    nodeFs(() => crypto.randomUUID(), {
      noReplaceRename: () => {
        throw new Error('unavailable');
      },
    }),
  );
  const quarantine = at(f.root, '.fy-remove-fixture');
  await f.root.quarantineRename!(f.checkout, quarantine, f.identity);
  await f.root.remove(quarantine, { expectedIdentity: f.identity });
  expect(await f.root.lstat(quarantine)).toBeUndefined();
});

for (const descriptorPath of [true, false]) {
  test(`a descendant on another device refuses the whole tree before deletion (descriptor path ${descriptorPath})`, async () => {
    const fs = nodeFs(
      () => crypto.randomUUID(),
      descriptorPath
        ? {}
        : {
            descriptorFolder: '/nonexistent-descriptor-folder',
            descriptorCalls: loadDescriptorCalls,
            bracket: loadProcessBracket,
          },
    );
    const mounted = <T extends { readonly device: bigint }>(identity: T): T => ({
      ...identity,
      device: identity.device + 1n,
    });
    const wrap = (steps: FolderSteps): FolderSteps => {
      const removal = steps.removal;
      if (removal === undefined) return steps;
      return {
        ...steps,
        removal: {
          ...removal,
          lstat: async name => {
            const identity = await removal.lstat(name);
            return name === 'z-mount' && identity !== undefined ? mounted(identity) : identity;
          },
          openFolder: async name => {
            const child = await removal.openFolder(name);
            return {
              ...child,
              identity: name === 'z-mount' ? mounted(child.identity) : child.identity,
              steps: wrap(child.steps),
            };
          },
        },
      };
    };
    const f = await fresh({
      ...fs,
      identity: async target => {
        const identity = await fs.identity(target);
        return target.endsWith('/z-mount') && identity !== undefined ? mounted(identity) : identity;
      },
      openDirectory: async target => {
        const folder = await fs.openDirectory(target);
        return {
          ...folder,
          identity: target.endsWith('/z-mount') ? mounted(folder.identity) : folder.identity,
          at: folder.at === undefined ? undefined : wrap(folder.at),
        };
      },
    });
    await mkdir(`${f.checkout}/z-mount`);
    await writeFile(`${f.checkout}/z-mount/keep`, 'mounted content');
    await expect(f.root.remove(f.checkout, { expectedIdentity: f.identity })).rejects.toMatchObject({
      refusal: 'cross_device',
    });
    expect(await readFile(`${f.checkout}/keep`, 'utf8')).toBe('verified');
    expect(await readFile(`${f.checkout}/z-mount/keep`, 'utf8')).toBe('mounted content');
  });
}
