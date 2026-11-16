/**
 * The testing host's spawn answers a child that ended by a signal in the real host's shape (`host/adapters/process.ts`):
 * `run` carries a fake's `{ exitCode: null, signal }` through unchanged, and `runBytes` reads that same event, under a
 * timeout the caller set, as the real one reads its own kill: `timedOut` with exit `-1`. A child that exited by itself
 * is its code, never a timeout.
 */
import { expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import type { KernelPorts, SpawnResult } from '../../../contract/ports.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const KILLED: SpawnResult = { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' };
const EXITED: SpawnResult = { exitCode: 3, signal: null, stdout: 'x', stderr: '' };

async function withSpawn<T>(answer: SpawnResult, use: (spawn: KernelPorts['spawn']) => Promise<T>): Promise<T> {
  let spawn: KernelPorts['spawn'] | undefined;
  const host = await testHost({
    plugins: [
      implementDaemon(
        definePlugin({
          id: 'prober',
          title: 'Prober',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          permissions: { spawn: ['probe'] },
        }),
        {
          build: ({ kernel }) => {
            spawn = kernel.spawn;
            return {};
          },
        },
      ),
    ],
    spawn: async () => answer,
  });
  try {
    return await use(spawn as KernelPorts['spawn']);
  } finally {
    await host.stop();
  }
}

test('run carries a killed child as exitCode null with its signal, and an exit as its code with no signal', async () => {
  expect(await withSpawn(KILLED, spawn => spawn.run('probe', [], { timeout: milliseconds(10) }))).toEqual(KILLED);
  expect(await withSpawn(EXITED, spawn => spawn.run('probe', []))).toEqual(EXITED);
});

test('runBytes reads a killed child under a timeout as timedOut with exit -1, and an exit as its code', async () => {
  const killed = await withSpawn(KILLED, spawn => spawn.runBytes('probe', [], { timeout: milliseconds(10) }));
  expect(killed.timedOut).toBe(true);
  expect(killed.exitCode).toBe(-1);
  const noTimeout = await withSpawn(KILLED, spawn => spawn.runBytes('probe', []));
  expect(noTimeout.timedOut).toBe(false);
  expect(noTimeout.exitCode).toBe(-1);
  const exited = await withSpawn(EXITED, spawn => spawn.runBytes('probe', [], { timeout: milliseconds(10) }));
  expect(exited.timedOut).toBe(false);
  expect(exited.exitCode).toBe(3);
});
