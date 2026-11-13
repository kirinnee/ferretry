import { expect, it } from 'bun:test';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { BunConnectorProcesses } from '../../../daemon/adapters/tunnel/bun-connector-process.ts';
import { CLOUDFLARED_ARGUMENTS } from '../../../daemon/lib/tunnel/connector.ts';

it('R666 a connector receives SIGTERM then SIGKILL after the kernel clock grace', async () => {
  const clock = fixedClock();
  const signals: string[] = [];
  let settle!: (code: number | null) => void;
  const exited = new Promise<number | null>(resolve => {
    settle = resolve;
  });
  const launches: unknown[] = [];
  const spawn: SpawnPort = {
    run: async () => {
      throw new Error('unused');
    },
    runBytes: () => Promise.reject(new Error('the fixture runs no bytes')),
    start: (program, args, options) => {
      launches.push({ program, args, env: options?.env });
      return {
        pid: 123,
        pipes: [],
        closePipes: () => undefined,
        stdout: new ReadableStream({ start: c => c.close() }),
        stderr: new ReadableStream({ start: c => c.close() }),
        write: () => {},
        kill: signal => {
          signals.push(signal ?? 'SIGTERM');
          if (signal === 'SIGKILL') settle(null);
        },
        exited,
      };
    },
  };
  const adapter = new BunConnectorProcesses(
    { PATH: '/bin', HOME: '/test', PROVIDER_KEY: 'fake-provider-key' },
    spawn,
    clock,
  );
  const child = adapter.spawn(
    { executable: 'cloudflared', args: CLOUDFLARED_ARGUMENTS, environment: { TUNNEL_TOKEN: 'fake-connector' } },
    () => {},
  );
  child.terminate();
  child.terminate();
  expect(signals).toEqual(['SIGTERM']);
  await clock.advance(4_999);
  expect(signals).toEqual(['SIGTERM']);
  await clock.advance(1);
  expect(await child.exited).toBeNull();
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(launches).toEqual([
    {
      program: 'cloudflared',
      args: CLOUDFLARED_ARGUMENTS,
      env: { PATH: '/bin', HOME: '/test', TUNNEL_TOKEN: 'fake-connector' },
    },
  ]);
  expect(clock.pending()).toBe(0);
});
