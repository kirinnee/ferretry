import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import type { RelocationSource } from '@ferretry/core-ferrets/contract';
import relocationSource from '../../daemon/features/relocation-source.feature.ts';
import type { FerretsContext } from '../../daemon/features/types.ts';
import type { FerretId } from '@ferretry/kernel/contract';

const FERRET = 'f-move-1' as FerretId;

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const at = (root: RootHandle, path: string): FencedPath => {
  const found = root.resolve(path);
  if (!found.ok) throw new Error(found.error);
  return found.value;
};

/** The real sessions RootHandle; only its filesystem's realpath answer is fault-injected. */
async function session(options: { readonly fault?: string; readonly directory?: string; readonly absent?: boolean }) {
  const parent = await mkdtemp(join(tmpdir(), 'relocate-session-listing-'));
  parents.push(parent);
  const home = join(parent, 'fy');
  const folder = join(home, 'state/ferrets/sessions', FERRET);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (!options.absent) {
    await mkdir(join(folder, 'attachments/nested'), { recursive: true, mode: 0o700 });
    await writeFile(join(folder, 'attachments/nested/photo.txt'), 'keep this attachment');
  }
  const disk = nodeFs(() => crypto.randomUUID());
  const root = rootsPortFor(
    {
      ...disk,
      realpath: async path => {
        if (options.fault !== undefined && path === join(folder, options.directory ?? 'attachments'))
          throw Object.assign(new Error(`synthetic ${options.fault}`), { code: options.fault });
        return await disk.realpath(path);
      },
    },
    { home, plugin: 'ferrets', worktrees: join(parent, 'worktrees') },
    ['sessions'],
    () => undefined,
  ).root('sessions', { subfolder: FERRET });
  const context = {
    registry: { get: () => ({ state: 'idle' }) },
    sessionFiles: { root: () => root },
    sessionStore: { replay: async () => ({ events: [], hasMore: false }) },
    ready: async () => {},
  } as unknown as FerretsContext;
  const source = (await relocationSource.register(context)?.port?.relocationSource?.(FERRET)) as RelocationSource;
  return { root, source };
}

for (const directory of ['attachments', 'attachments/nested']) {
  test.each(['EIO', 'EACCES', 'ENOENT'])(
    `R3 real sessions root: ${directory} realpath %s refuses the move listing naming the directory`,
    async fault => {
      const { source } = await session({ fault, directory });
      await expect(source.files()).rejects.toThrow(directory);
    },
  );
}

test.each(['EIO', 'EACCES', 'ENOENT'])('R3 default entries retains empty-on-realpath-%s behavior', async fault => {
  const { root } = await session({ fault });
  expect(await root.entries(at(root, 'attachments'))).toEqual([]);
});

test('R3 real sessions root: genuinely absent optional roots are still fine', async () => {
  const { source } = await session({ absent: true });
  expect(await source.files()).toEqual([{ area: 'history', path: 'history.jsonl', size: 0 }]);
});

test('R3 real sessions root: readable attachments are kept', async () => {
  const { source } = await session({});
  expect((await source.files()).map(file => file.path)).toEqual(['attachments/nested/photo.txt', 'history.jsonl']);
});
