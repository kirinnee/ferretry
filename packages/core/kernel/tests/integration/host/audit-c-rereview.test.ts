// Reviewer-only, real disposable disk. Copy beside host integration tests to run.
import { expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs, type HostFs } from '../../../host/adapters/node-fs.ts';
import { checkDirectory, stateHomeHolding } from '../../../host/paths.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock, testHost } from '../../../testing/index.ts';
import type { PathsPort } from '../../../contract/ports.ts';

test('review C1 race: a directory replaced after its lstat must not hide a real in-home destination', async () => {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-race-dir-`);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const entry = `${work}/entry`;
  const disk = nodeFs(() => 'review-fixture');
  try {
    await mkdir(`${home}/state/leaf`, { recursive: true });
    await mkdir(`${entry}/leaf`, { recursive: true });
    let swapped = false;
    const racing: HostFs = {
      ...disk,
      identity: async path => {
        const identity = await disk.identity(path);
        if (!swapped && path === entry) {
          swapped = true;
          await rename(entry, `${work}/old`);
          await symlink(`${home}/state`, entry);
        }
        return identity;
      },
    };
    const result = await stateHomeHolding(racing, home, { files: [], recheckMs: 0 }, `${entry}/leaf`);
    expect(swapped).toBe(true);
    expect(await checkDirectory(disk, `${entry}/leaf`)).toEqual({
      ok: true,
      value: { realPath: `${home}/state/leaf` },
    });
    expect(result).toBe(home);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('review C1 race: production port must not trust a link target replaced immediately after readlink', async () => {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-race-link-`);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const entry = `${work}/entry`;
  let outcome: Awaited<ReturnType<typeof bootHost>> | undefined;
  try {
    await mkdir(`${work}/plain/leaf`, { recursive: true });
    await symlink(`${work}/plain`, entry);
    let paths: PathsPort | undefined;
    let swapped = false;
    const adapters = realAdapters(home, () => {}, { binary: 'fy' });
    const fs: HostFs = {
      ...adapters.fs,
      readlink: async path => {
        const target = await adapters.fs.readlink(path);
        if (!swapped && path === entry) {
          swapped = true;
          await unlink(entry);
          await symlink(`${home}/state`, entry);
        }
        return target;
      },
    };
    const half = implementDaemon(
      definePlugin({
        id: 'reviewer',
        title: 'Reviewer',
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
    outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [half],
      adapters: { ...adapters, fs, clock: fixedClock() },
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    await mkdir(`${home}/state/leaf`, { recursive: true });
    const result = await paths!.stateHomeHolding(`${entry}/leaf`);
    expect(swapped).toBe(true);
    expect(await paths!.checkDirectory(`${entry}/leaf`)).toEqual({
      ok: true,
      value: { realPath: `${home}/state/leaf` },
    });
    expect(result).toBe(home);
  } finally {
    if (outcome?.kind === 'running') await outcome.host.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test('review C1 parity: real-disk testHost composes the same declared-private identities as production', async () => {
  const parent = await mkdtemp(`${tmpdir()}/audit-c-private-parity-`);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  let host: Awaited<ReturnType<typeof testHost>> | undefined;
  let outcome: Awaited<ReturnType<typeof bootHost>> | undefined;
  try {
    await mkdir(work);
    const paths: PathsPort[] = [];
    const half = implementDaemon(
      definePlugin({
        id: 'reviewer',
        title: 'Reviewer',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        permissions: { checkDirectory: true },
        privacy: { private: ['private'] },
      }),
      {
        build: ({ kernel }) => {
          paths.push(kernel.paths);
          return {};
        },
      },
    );
    outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [half],
      adapters: { ...realAdapters(home, () => {}, { binary: 'fy' }), clock: fixedClock() },
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    await mkdir(`${home}/state/reviewer/private`, { recursive: true });
    await writeFile(`${home}/state/reviewer/private/data`, 'disposable fixture');
    await link(`${home}/state/reviewer/private/data`, `${work}/alias`);
    host = await testHost({ plugins: [half], stateHome: home });
    expect(await paths[0]!.stateHomeHolding(`${work}/alias`)).toBe(home);
    expect(await paths[1]!.stateHomeHolding(`${work}/alias`)).toBe(home);
  } finally {
    if (host !== undefined) await host.stop();
    if (outcome?.kind === 'running') await outcome.host.stop();
    await rm(parent, { recursive: true, force: true });
  }
});
