import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { resolveInRoot } from '../../../host/roots.ts';

/**
 * A repeat look at the same path inside the window costs the look at the ENTRY (and the private places), not the whole
 * walk; any change to the entry, or to a folder that leads somewhere else, is walked in full again and refused.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** The disk, with every call counted. */
function counted(inner: HostFs): { readonly fs: HostFs; readonly calls: () => number } {
  let calls = 0;
  const fs = new Proxy(inner, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fs, calls: () => calls };
}

async function setup() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-resolved-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const base = `${home}/data`;
  await mkdir(`${base}/sub`, { recursive: true, mode: 0o700 });
  await mkdir(`${parent}/outside`, { recursive: true });
  await writeFile(`${base}/sub/file.txt`, 'one');
  await writeFile(`${parent}/outside/file.txt`, 'outside');
  const disk = counted(nodeFs(() => 'r'));
  // As the host builds it: the private places are looked at once and kept for a while, not at every call.
  const places = { files: [], recheckMs: 60_000 };
  const resolve = async (relative = 'sub/file.txt') =>
    await resolveInRoot(disk.fs, home, base, false, relative, home, places);
  return { parent, base, disk, resolve };
}

test('a repeat look of the same path inside the window costs far fewer disk calls and answers the same place', async () => {
  const { disk, resolve } = await setup();
  const first = await resolve();
  const afterFirst = disk.calls();
  const again = await resolve();
  const repeat = disk.calls() - afterFirst;
  expect(first.ok && again.ok && first.value === again.value).toBe(true);
  expect(afterFirst).toBeGreaterThan(repeat * 2);
});

test('an entry replaced by another file is walked in full again (and still answers the place)', async () => {
  const { base, disk, resolve } = await setup();
  await resolve();
  const warm = disk.calls();
  await resolve();
  const repeat = disk.calls() - warm;
  // Made beside the old file and renamed over it, so the new file cannot reuse the old one's inode number.
  await writeFile(`${base}/sub/file.new`, 'two');
  await rename(`${base}/sub/file.new`, `${base}/sub/file.txt`);
  const before = disk.calls();
  const replaced = await resolve();
  expect(replaced.ok).toBe(true);
  expect(disk.calls() - before).toBeGreaterThan(repeat);
});

test('an entry swapped for a link that leads out is refused at once', async () => {
  const { parent, base, resolve } = await setup();
  expect((await resolve()).ok).toBe(true);
  await unlink(`${base}/sub/file.txt`);
  await symlink(`${parent}/outside/file.txt`, `${base}/sub/file.txt`);
  const swapped = await resolve();
  expect(swapped.ok).toBe(false);
  expect(!swapped.ok && swapped.error).toBe('link_escape');
});

test('a folder above the entry swapped for a link to another folder holding the same name is refused at once', async () => {
  const { parent, base, resolve } = await setup();
  expect((await resolve()).ok).toBe(true);
  await rename(`${base}/sub`, `${parent}/moved`);
  await symlink(`${parent}/outside`, `${base}/sub`);
  const swapped = await resolve();
  expect(swapped.ok).toBe(false);
  expect(!swapped.ok && swapped.error).toBe('link_escape');
});

test('an entry that is gone is not served from memory', async () => {
  const { base, resolve } = await setup();
  expect((await resolve()).ok).toBe(true);
  await unlink(`${base}/sub/file.txt`);
  const gone = await resolve();
  // Not there: the walk answers the path it would be made at, never the remembered place's identity.
  expect(gone.ok ? String(gone.value) : gone.error).toBe(`${base}/sub/file.txt`);
});
