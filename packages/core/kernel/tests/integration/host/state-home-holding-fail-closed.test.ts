// Real-disk proof that stateHomeHolding fails CLOSED (answers the home, never `undefined`) when the disk moves or the
// two routes disagree (audit C fix round 2). Mutations are real renames/symlinks scheduled at syscall boundaries. Temp dirs only.
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs, type HostFs } from '../../../host/adapters/node-fs.ts';
import { stateHomeHolding } from '../../../host/paths.ts';

const disk = nodeFs(() => 'fail-closed-fixture');
const options = { files: [], recheckMs: 0 };

async function fixture(run: (dirs: { home: string; work: string }) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-fail-closed-`);
  try {
    await mkdir(`${parent}/home/state/leaf`, { recursive: true });
    await mkdir(`${parent}/work`);
    await run({ home: `${parent}/home`, work: `${parent}/work` });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('a quiet disk still answers undefined for a path outside, whole or with a missing tail', async () => {
  await fixture(async ({ home, work }) => {
    await mkdir(`${work}/plain/leaf`, { recursive: true });
    expect(await stateHomeHolding(disk, home, options, `${work}/plain/leaf`)).toBeUndefined();
    expect(await stateHomeHolding(disk, home, options, `${work}/plain/missing/deeper`)).toBeUndefined();
  });
});

test('an ancestor swapped for a link into the home AFTER the kernel resolved the request is held', async () => {
  await fixture(async ({ home, work }) => {
    await mkdir(`${work}/entry/leaf`, { recursive: true });
    let swapped = false;
    const racing: HostFs = {
      ...disk,
      realpath: async path => {
        const real = await disk.realpath(path);
        if (!swapped && path === `${work}/entry/leaf`) {
          swapped = true;
          await rename(`${work}/entry`, `${work}/old`);
          await symlink(`${home}/state`, `${work}/entry`);
        }
        return real;
      },
    };
    expect(await stateHomeHolding(racing, home, options, `${work}/entry/leaf`)).toBe(home);
    expect(swapped).toBe(true);
  });
});

test('a link re-pointed into the home while the end was being judged is held', async () => {
  await fixture(async ({ home, work }) => {
    await mkdir(`${work}/plain/leaf`, { recursive: true });
    await symlink(`${work}/plain`, `${work}/entry`);
    let swapped = false;
    const racing: HostFs = {
      ...disk,
      // The judging of the end looks at the end's identity; re-point the link right after the first such look.
      identity: async path => {
        const identity = await disk.identity(path);
        if (!swapped && path === `${work}/plain/leaf`) {
          swapped = true;
          await rm(`${work}/entry`);
          await symlink(`${home}/state`, `${work}/entry`);
        }
        return identity;
      },
    };
    expect(await stateHomeHolding(racing, home, options, `${work}/entry/leaf`)).toBe(home);
    expect(swapped).toBe(true);
  });
});

test('a missing tail that appears as a link into the home while the request was settled is held', async () => {
  await fixture(async ({ home, work }) => {
    let appeared = false;
    const racing: HostFs = {
      ...disk,
      realpath: async path => {
        try {
          return await disk.realpath(path);
        } finally {
          if (!appeared && path === `${work}/later/leaf`) {
            appeared = true;
            await symlink(`${home}/state`, `${work}/later`);
          }
        }
      },
    };
    expect(await stateHomeHolding(racing, home, options, `${work}/later/leaf`)).toBe(home);
    expect(appeared).toBe(true);
  });
});

test('a kernel resolution that disagrees with the walk, or cannot settle a whole path, is held', async () => {
  await fixture(async ({ home, work }) => {
    await mkdir(`${work}/plain/leaf`, { recursive: true });
    await mkdir(`${work}/other`);
    // Only the request is answered differently: the fence is built from the home with the real call.
    const elsewhere: HostFs = {
      ...disk,
      realpath: async path => (path.startsWith(work) ? `${work}/other` : await disk.realpath(path)),
    };
    expect(await stateHomeHolding(elsewhere, home, options, `${work}/plain/leaf`)).toBe(home);
    const unsettled: HostFs = {
      ...disk,
      realpath: async path => {
        if (!path.startsWith(work)) return await disk.realpath(path);
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    };
    expect(await stateHomeHolding(unsettled, home, options, `${work}/plain/leaf`)).toBe(home);
  });
});
