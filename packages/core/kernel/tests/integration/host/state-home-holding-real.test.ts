// Real-disk and production-boot proof that stateHomeHolding resolves links before it judges (audit C review P1). Temp dirs only.
import { expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { PathsPort } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock, testHost } from '../../../testing/index.ts';
import { checkDirectory, stateHomeHolding } from '../../../host/paths.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';

test('stateHomeHolding: real production boot wires the composed private fence and permission gate', async () => {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-boot-`);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  await mkdir(work);
  const paths: Record<string, PathsPort> = {};
  const half = (id: string, permitted: boolean) =>
    implementDaemon(
      definePlugin({
        id,
        title: id,
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        ...(permitted ? { permissions: { checkDirectory: true } } : {}),
        privacy: { private: ['private'] },
      }),
      {
        build: ({ kernel }) => {
          paths[id] = kernel.paths;
          return {};
        },
      },
    );
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: [half('allowed', true), half('denied', false)],
    adapters: { ...realAdapters(home, () => {}, { binary: 'fy' }), clock: fixedClock() },
  });
  try {
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    const allowed = paths.allowed!;
    await mkdir(`${home}/state/allowed/private`, { recursive: true });
    await writeFile(`${home}/state/allowed/private/fixture`, 'test data only');
    await link(`${home}/state/allowed/private/fixture`, `${work}/alias`);
    await mkdir(`${parent}/home-before-20260101T000000Z`);
    await symlink(work, `${home}/state/out`);
    await symlink(`${home}/state`, `${parent}/into`);
    await symlink(`${home}/state/out`, `${parent}/through`);
    expect(await allowed.stateHomeHolding(home)).toBe(home);
    expect(await allowed.stateHomeHolding(`${parent}/home-before-20260101T000000Z`)).toBe(home);
    expect(await allowed.stateHomeHolding(`${parent}/into`)).toBe(home);
    expect(await allowed.stateHomeHolding(`${parent}/through`)).toBe(home);
    expect(await allowed.stateHomeHolding(work)).toBeUndefined();
    expect(await allowed.stateHomeHolding(`${work}/missing`)).toBeUndefined();
    expect(await allowed.stateHomeHolding(`${work}/alias`)).toBe(home);
    await expect(paths.denied!.stateHomeHolding(work)).rejects.toThrow(
      'denied did not declare permissions.checkDirectory',
    );
    await rename(home, `${parent}/held-home`);
    try {
      await expect(allowed.stateHomeHolding(work)).rejects.toThrow();
    } finally {
      await rename(`${parent}/held-home`, home);
    }
    await mkdir(`${home}/state/inner`, { recursive: true });
    await mkdir(`${work}/inner`, { recursive: true });
    await symlink(`${home}/state/inner`, `${work}/entry`);
    const raw = `${work}/entry/../inner`;
    expect(await allowed.checkDirectory(raw)).toEqual({ ok: true, value: { realPath: `${home}/state/inner` } });
    expect(await allowed.stateHomeHolding(raw)).toBe(home);
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test('stateHomeHolding: testHost real-disk option uses the same fence', async () => {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-kit-`);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true });
  let paths: PathsPort | undefined;
  const half = implementDaemon(
    definePlugin({
      id: 'allowed',
      title: 'Allowed',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { checkDirectory: true },
    }),
    {
      build: ({ kernel }) => {
        paths = kernel.paths;
        return {};
      },
    },
  );
  const host = await testHost({ plugins: [half], stateHome: home });
  try {
    expect(await paths!.stateHomeHolding(`${home}/state`)).toBe(home);
    expect(await paths!.stateHomeHolding(parent)).toBeUndefined();
  } finally {
    await host.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test('stateHomeHolding: a symlink followed by dot-dot is judged at its real destination', async () => {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-dotdot-`);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const disk = nodeFs(() => 'fixture');
  try {
    await mkdir(`${home}/state/inner`, { recursive: true });
    await mkdir(`${work}/inner`, { recursive: true });
    await symlink(`${home}/state/inner`, `${work}/entry`);
    const raw = `${work}/entry/../inner`;
    expect(await checkDirectory(disk, raw)).toEqual({ ok: true, value: { realPath: `${home}/state/inner` } });
    expect(await stateHomeHolding(disk, home, { files: [], recheckMs: 0 }, raw)).toBe(home);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('stateHomeHolding: dot-dot cannot erase a link hop that lives in the home, even when the final folder is outside', async () => {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-dotdot-hop-`);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const disk = nodeFs(() => 'fixture');
  try {
    await mkdir(`${home}/state`, { recursive: true });
    await mkdir(`${work}/plain`, { recursive: true });
    await symlink(`${home}/state`, `${work}/bridge`);
    await symlink(`${work}/plain`, `${home}/state/out`);
    const raw = `${work}/bridge/out/../plain`;
    expect(await checkDirectory(disk, raw)).toEqual({ ok: true, value: { realPath: `${work}/plain` } });
    expect(await stateHomeHolding(disk, home, { files: [], recheckMs: 0 }, raw)).toBe(home);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
