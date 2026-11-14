/**
 * `kernel.selfCounters` (Usage's profile) reads THIS process's `/proc/self/{io,stat}` and nothing else, and widens no one
 * else's grant. Driven through the production composition (`bootHost` over `realAdapters`, `/proc` pointed at a fixture
 * tree) and through `testHost`: a plugin with `selfCounters` reads the two files and nothing of `hostFacts`; a plugin with
 * `hostFacts` (Terminals, Browsers, Ferrets) still reads what it did and still CANNOT read `io`, and holds no counters.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KernelPorts as Kernel, ProcPidFile } from '../../../contract/ports.ts';
import { nodeHostFacts } from '../../../host/adapters/host-facts.ts';
import { nodeSelfCounters } from '../../../host/adapters/self-counters.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

// `io` is deliberately NOT a ProcPidFile: the type refuses it, so the test names it past the type to prove the runtime refuses it too.
const IO = 'io' as unknown as ProcPidFile;

let fixture: string;
beforeAll(async () => {
  fixture = await mkdtemp(`${tmpdir()}/fy-self-counters-`);
  await mkdir(join(fixture, 'self'), { recursive: true });
  await mkdir(join(fixture, '123'), { recursive: true });
  await writeFile(join(fixture, 'self/io'), 'syscr: 1\nsyscw: 2\n');
  await writeFile(join(fixture, 'self/stat'), '1 (fyd) S 1 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 1 1 1 1');
  await writeFile(join(fixture, 'self/cmdline'), 'synthetic-command');
  await writeFile(join(fixture, '123/io'), 'syscr: 3\nsyscw: 4\n');
  await writeFile(join(fixture, '123/stat'), '123 (other) S 1');
});
afterAll(async () => await rm(fixture, { recursive: true, force: true }));

type Permission = { readonly selfCounters: true } | { readonly hostFacts: true } | undefined;
const kernels: Record<string, Kernel> = {};
const plugin = (id: string, permissions: Permission) =>
  implementDaemon(
    definePlugin({
      id,
      title: id,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      ...(permissions === undefined ? {} : { permissions }),
    }),
    {
      build: ctx => {
        kernels[id] = ctx.kernel;
        return {};
      },
    },
  );
const plugins = () => [
  plugin('usage-like', { selfCounters: true }),
  plugin('terminals-like', { hostFacts: true }),
  plugin('other', undefined),
];

const kernelOf = (id: string): Kernel => {
  const kernel = kernels[id];
  if (kernel === undefined) throw new Error(`${id} was not built`);
  return kernel;
};

const behaviour = (): void => {
  test('the plugin that declared selfCounters reads its own io and stat', async () => {
    const counters = kernelOf('usage-like').selfCounters;
    expect(await counters.io()).toBe('syscr: 1\nsyscw: 2\n');
    expect(await counters.stat()).toContain('(fyd)');
    expect(Object.keys(counters).sort()).toEqual(['io', 'platform', 'stat']);
  });

  test('it holds no hostFacts: another pid, its own command line and the process list are refused', async () => {
    const facts = kernelOf('usage-like').hostFacts;
    await expect(facts.procFile(123, IO)).rejects.toThrow('did not declare permissions.hostFacts');
    await expect(facts.procFile(123, 'stat')).rejects.toThrow('did not declare permissions.hostFacts');
    await expect(facts.procFile('self', 'cmdline')).rejects.toThrow('did not declare permissions.hostFacts');
    await expect(facts.procFile('self', IO)).rejects.toThrow('did not declare permissions.hostFacts');
    await expect(facts.pids()).rejects.toThrow('did not declare permissions.hostFacts');
    await expect(facts.procFds(1)).rejects.toThrow('did not declare permissions.hostFacts');
    await expect(facts.cgroupFile('', 'cpu.max')).rejects.toThrow('did not declare permissions.hostFacts');
  });

  test('a plugin that declared hostFacts keeps what it had, still cannot read io, and holds no counters', async () => {
    const kernel = kernelOf('terminals-like');
    expect(await kernel.hostFacts.procFile('self', 'cmdline')).toBe('synthetic-command');
    expect(await kernel.hostFacts.procFile(123, 'stat')).toContain('(other)');
    await expect(kernel.hostFacts.procFile('self', IO)).rejects.toThrow('not a declared host facts file');
    await expect(kernel.hostFacts.procFile(123, IO)).rejects.toThrow('not a declared host facts file');
    await expect(kernel.selfCounters.io()).rejects.toThrow('did not declare permissions.selfCounters');
    await expect(kernel.selfCounters.stat()).rejects.toThrow('did not declare permissions.selfCounters');
  });

  test('a plugin that declared neither reads nothing from either port', async () => {
    const kernel = kernelOf('other');
    await expect(kernel.selfCounters.io()).rejects.toThrow('did not declare permissions.selfCounters');
    await expect(kernel.hostFacts.procFile('self', 'stat')).rejects.toThrow('did not declare permissions.hostFacts');
  });
};

describe('production composition (bootHost over realAdapters)', () => {
  let stop: (() => Promise<void>) | undefined;
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(`${tmpdir()}/fy-self-counters-home-`);
    const boot = await bootHost({
      home,
      version: '5.0.0',
      implementations: plugins(),
      adapters: {
        ...realAdapters(home, () => {}, { binary: 'fy' }),
        hostFacts: nodeHostFacts({ proc: fixture, sys: join(fixture, 'sys') }),
        selfCounters: nodeSelfCounters({ proc: fixture }),
      },
      listen: async () => ({ addresses: [], stop: async () => {} }),
    });
    if (boot.kind !== 'running') throw new Error(`host did not start: ${boot.kind}`);
    stop = async () => await boot.host.stop();
  });
  afterAll(async () => {
    await stop?.();
    await rm(home, { recursive: true, force: true });
  });
  behaviour();
});

describe('testing composition (testHost)', () => {
  let stop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const host = await testHost({
      plugins: plugins(),
      hostFacts: nodeHostFacts({ proc: fixture, sys: join(fixture, 'sys') }),
      selfCounters: nodeSelfCounters({ proc: fixture }),
    });
    stop = async () => await host.stop();
  });
  afterAll(async () => await stop?.());
  behaviour();
});

describe('nodeHostFacts alone', () => {
  test('refuses io for every pid, so no host-facts consumer reaches the counters', async () => {
    const facts = nodeHostFacts({ proc: fixture });
    await expect(facts.procFile('self', IO)).rejects.toThrow('not a declared host facts file');
    await expect(facts.procFile(123, IO)).rejects.toThrow('not a declared host facts file');
  });
});
