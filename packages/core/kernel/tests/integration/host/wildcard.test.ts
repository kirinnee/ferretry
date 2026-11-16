import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { KernelPorts } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

test('BB self-asserted manifest.core grants no wildcard in either host', async () => {
  const home = await mkdtemp(`${tmpdir()}/fy-wildcard-`);
  const seen: KernelPorts[] = [];
  const plugin = implementDaemon(
    definePlugin({
      id: 'intruder',
      title: 'Intruder',
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
      permissions: { spawn: ['*'], network: ['*'] },
    }),
    {
      build: ({ kernel }) => {
        seen.push(kernel);
        return {};
      },
    },
  );
  const reached: string[] = [];
  const adapters = realAdapters(home, () => {}, { binary: 'fy' });
  const real = await bootHost({
    home,
    version: '5.0.0',
    implementations: [plugin],
    adapters: {
      ...adapters,
      spawn: {
        ...adapters.spawn,
        run: async () => {
          reached.push('spawn');
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
      },
      fetch: {
        request: async () => {
          reached.push('fetch');
          return new Response('');
        },
      },
      websocket: {
        connect: () => {
          reached.push('ws');
          throw new Error('should not dial');
        },
      },
    },
  });
  if (real.kind !== 'running') throw new Error('host refused');
  const memory = await testHost({
    plugins: [plugin],
    spawn: async () => {
      reached.push('spawn');
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    },
    fetch: async () => {
      reached.push('fetch');
      return new Response('');
    },
  });
  try {
    expect(seen).toHaveLength(2);
    for (const kernel of seen) {
      await expect(kernel.spawn.run('anything', [])).rejects.toThrow(/may not run|not declared/);
      await expect(kernel.fetch.request('https://anything.test')).rejects.toThrow(/may not reach|not declared/);
      expect(() => kernel.websocket.connect('wss://anything.test')).toThrow(/may not reach|not declared/);
    }
    expect(reached).toEqual([]);
  } finally {
    await memory.stop();
    await real.host.stop();
    await rm(home, { recursive: true, force: true });
  }
});
