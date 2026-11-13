import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { gatedPaths, stateHomeHolding } from '../../../host/paths.ts';
import type { PathsPort } from '../../../contract/ports.ts';

/**
 * `kernel.paths.stateHomeHolding` (S40 S43 S47): the state home an absolute path is in, judged as every owner root
 * judges it, over a real temp disk. Fake values only.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const disk = nodeFs(() => 'r');
const NO_PRIVATE = { files: [], recheckMs: 0 } as const;

/** A parent folder holding a real `home` (with `state/`) and a bind-free `work` sibling. */
async function world(): Promise<{ parent: string; home: string; work: string }> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-state-home-`));
  parents.push(parent);
  const home = `${parent}/ferretry`;
  const work = `${parent}/work`;
  await mkdir(`${home}/state/ferrets`, { recursive: true });
  await mkdir(work);
  return { parent, home, work };
}
const holding = async (home: string, path: string): Promise<string | undefined> =>
  await stateHomeHolding(disk, home, NO_PRIVATE, path);

describe('S47 kernel.paths.stateHomeHolding', () => {
  test('S40 a folder inside the home answers the home name', async () => {
    const { home } = await world();

    expect(await holding(home, `${home}/state/ferrets`)).toBe(home);
    expect(await holding(home, home)).toBe(home);
  });

  test('S43 a "-before-" folder beside the home answers the home name', async () => {
    const { parent, home } = await world();
    await mkdir(`${parent}/ferretry-before-20260101T000000Z`);

    expect(await holding(home, `${parent}/ferretry-before-20260101T000000Z`)).toBe(home);
  });

  test('S47 a link outside the home that points into it answers the home name', async () => {
    const { parent, home } = await world();
    await symlink(`${home}/state`, `${parent}/to-state`);

    expect(await holding(home, `${parent}/to-state`)).toBe(home);
    expect(await holding(home, `${parent}/to-state/ferrets`)).toBe(home);
  });

  test('S47 a link inside the home that points back out is judged on its hop', async () => {
    const { home, work } = await world();
    await symlink(work, `${home}/state/out`);

    expect(await holding(home, `${home}/state/out`)).toBe(home);
  });

  test('a bind-free sibling folder answers undefined', async () => {
    const { work, home } = await world();

    expect(await holding(home, work)).toBeUndefined();
  });

  test('a path that is not there answers undefined', async () => {
    const { work, home } = await world();

    expect(await holding(home, `${work}/missing/deeper`)).toBeUndefined();
  });

  test('a home whose identity cannot be read throws, so the caller refuses', async () => {
    const { parent } = await world();

    await expect(holding(`${parent}/no-such-home`, parent)).rejects.toThrow();
  });

  test('a home that is a file, not a folder, throws', async () => {
    const { parent, work } = await world();
    await writeFile(`${parent}/file-home`, 'x');

    await expect(holding(`${parent}/file-home`, work)).rejects.toThrow();
  });

  test('a relative path is refused rather than judged', async () => {
    const { home } = await world();

    await expect(holding(home, 'work')).rejects.toThrow();
  });
});

describe('S47 kernel.paths.stateHomeHolding resolves links BEFORE it judges (no lexical ".." erasure)', () => {
  test('a ".." taken through a link into the home is judged at the real folder: a link to home/state/inner', async () => {
    const { home, work } = await world();
    await mkdir(`${home}/state/inner`);
    await mkdir(`${work}/inner`);
    await symlink(`${home}/state/inner`, `${work}/entry`);

    expect(await holding(home, `${work}/entry/../inner`)).toBe(home);
    expect(await holding(home, `${work}/entry/..`)).toBe(home);
  });

  test('a ".." cannot erase an in-home link hop even when the final folder is outside the home', async () => {
    const { home, work } = await world();
    await mkdir(`${work}/plain`);
    await symlink(`${home}/state`, `${work}/bridge`);
    await symlink(`${work}/plain`, `${home}/state/out`);

    expect(await holding(home, `${work}/bridge/out/../plain`)).toBe(home);
  });

  test('a link in the home that points outside the state home is judged on its hop, then by real path', async () => {
    const { parent, home, work } = await world();
    await mkdir(`${work}/deep`);
    await symlink(work, `${home}/state/leave`);
    await symlink(`${home}/state/leave`, `${parent}/via`);

    expect(await holding(home, `${home}/state/leave/deep`)).toBe(home);
    expect(await holding(home, `${parent}/via/deep`)).toBe(home);
  });

  test('a ".." through a link OUT of the home lands where it really is: outside answers undefined', async () => {
    const { parent, home, work } = await world();
    await mkdir(`${work}/inner`);
    await symlink(work, `${parent}/outer-link`);

    // outer-link -> work (outside the home): outer-link/inner/.. is work, outside the fence.
    expect(await holding(home, `${parent}/outer-link/inner/..`)).toBeUndefined();
    // ferretry/../work is the sibling, outside; the lexical result is the same here and stays outside.
    expect(await holding(home, `${home}/../work`)).toBeUndefined();
  });

  test('a real folder inside the home is found (including through "." and doubled slashes)', async () => {
    const { home } = await world();

    expect(await holding(home, `${home}/state/./ferrets/`)).toBe(home);
    expect(await holding(home, `${home}//state///ferrets`)).toBe(home);
    expect(await holding(home, `${home}/state/ferrets/../ferrets`)).toBe(home);
  });

  test('a path that is not there inside the home is still held; one outside is not', async () => {
    const { home, work } = await world();

    expect(await holding(home, `${home}/state/ferrets/missing/deeper`)).toBe(home);
    expect(await holding(home, `${work}/missing/../other`)).toBeUndefined();
  });

  test('a link loop fails closed (held), never throws or hangs', async () => {
    const { parent, home } = await world();
    await symlink(`${parent}/loop-b`, `${parent}/loop-a`);
    await symlink(`${parent}/loop-a`, `${parent}/loop-b`);

    expect(await holding(home, `${parent}/loop-a/x`)).toBe(home);
  });
});

describe('S47 kernel.paths.stateHomeHolding is gated by permissions.checkDirectory', () => {
  const base: PathsPort = {
    home: () => '/h',
    checkDirectory: async () => ({ ok: true as const, value: { realPath: '/x' } }),
    bindDirectory: async () => ({
      ok: true as const,
      value: { realPath: '/x', insideStateHome: false, verify: async () => ({ ok: true as const, value: undefined }) },
    }),
    stateHomeHolding: async () => '/home/fy',
    which: async () => undefined,
    locate: async () => ({ kind: 'absent' as const }),
    whichFor: async () => ({ kind: 'unprovable' as const }),
  };

  test('a declared plugin is answered; an undeclared one is refused naming the plugin', async () => {
    expect(await gatedPaths('ferrets', true, base).stateHomeHolding('/x')).toBe('/home/fy');
    await expect(gatedPaths('notes', false, base).stateHomeHolding('/x')).rejects.toThrow(
      'notes did not declare permissions.checkDirectory',
    );
  });
});
