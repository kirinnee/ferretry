import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../host/roots.ts';

/**
 * A read of a file that is not there carries the errno (`readDurable` and its callers go by the code) and never the
 * absolute path the system's own message names (row 147).
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

test('row 147 a read of a missing file throws ENOENT without the absolute path in its message', async () => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-read-missing-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  const fs = nodeFs(() => 'r');
  const layout = { home, plugin: 'stranger', worktrees: `${home}-worktrees` };
  await ensureInternalRootBases(fs, layout, ['agent-homes']);
  const root = rootsPortFor(fs, layout, ['agent-homes'], () => undefined, { random: () => 'r' }).root('agent-homes', {
    subfolder: 'F1',
  });
  // The scoped folder exists once something is written; the file read below is the one that is not there.
  const own = root.resolve('own.txt');
  if (!own.ok) throw new Error(own.error);
  await root.writeText(own.value as FencedPath, 'own');
  const path = root.resolve('absent.txt');
  if (!path.ok) throw new Error(path.error);
  const failure = await root.readText(path.value as FencedPath).then(
    () => undefined,
    (error: unknown) => error as { code?: string; message: string },
  );
  expect(failure?.code).toBe('ENOENT');
  expect(failure?.message).not.toContain(parent);
  expect(failure?.message).not.toContain('absent.txt');
});
