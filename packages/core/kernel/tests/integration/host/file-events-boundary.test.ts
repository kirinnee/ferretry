/**
 * `kernel.fileEvents` (Usage's profile) lists the directories the host polls instead of watching, and nothing else: no
 * subscribe, no path in, and a plugin that did not declare `permissions.fileEvents` is refused. Driven through the
 * production composition (`bootHost` over `realAdapters`) and through `testHost`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { KernelPorts as Kernel, PolledDirectory } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const POLLED: readonly PolledDirectory[] = [{ directory: '/h/config/logins', reason: 'EMFILE', everyMs: 1_000 }];

const kernels: Record<string, Kernel> = {};
const plugin = (id: string, declared: boolean) =>
  implementDaemon(
    definePlugin({
      id,
      title: id,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      ...(declared ? { permissions: { fileEvents: true as const } } : {}),
    }),
    {
      build: ctx => {
        kernels[id] = ctx.kernel;
        return {};
      },
    },
  );
const plugins = () => [plugin('usage-like', true), plugin('other', false)];
const kernelOf = (id: string): Kernel => {
  const kernel = kernels[id];
  if (kernel === undefined) throw new Error(`${id} was not built`);
  return kernel;
};

const behaviour = (): void => {
  test('the plugin that declared fileEvents reads the polled list, and the port has no way to watch', () => {
    const port = kernelOf('usage-like').fileEvents;
    expect(port.polled()).toEqual(POLLED);
    expect(Object.keys(port)).toEqual(['polled']);
  });

  test('a plugin that did not declare it is refused, naming the plugin', () => {
    expect(() => kernelOf('other').fileEvents.polled()).toThrow('other did not declare permissions.fileEvents');
  });
};

describe('production composition (bootHost over realAdapters)', () => {
  let stop: (() => Promise<void>) | undefined;
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(`${tmpdir()}/fy-file-events-home-`);
    const adapters = realAdapters(home, () => {}, { binary: 'fy' });
    const boot = await bootHost({
      home,
      version: '5.0.0',
      implementations: plugins(),
      adapters: { ...adapters, fileEvents: { polled: () => POLLED } },
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
    const host = await testHost({ plugins: plugins(), fileEvents: { polled: () => POLLED } });
    stop = async () => await host.stop();
  });
  afterAll(async () => await stop?.());
  behaviour();
});

describe('a host with no file-events adapter', () => {
  test('lists nothing as polled, in the testing host and the real one', async () => {
    const host = await testHost({ plugins: plugins() });
    expect(kernelOf('usage-like').fileEvents.polled()).toEqual([]);
    await host.stop();
    const home = await mkdtemp(`${tmpdir()}/fy-file-events-none-`);
    const { fileEvents: _dropped, ...adapters } = realAdapters(home, () => {}, { binary: 'fy' });
    const boot = await bootHost({
      home,
      version: '5.0.0',
      implementations: plugins(),
      adapters,
      listen: async () => ({ addresses: [], stop: async () => {} }),
    });
    if (boot.kind !== 'running') throw new Error(`host did not start: ${boot.kind}`);
    expect(kernelOf('usage-like').fileEvents.polled()).toEqual([]);
    await boot.host.stop();
    await rm(home, { recursive: true, force: true });
  });
});
