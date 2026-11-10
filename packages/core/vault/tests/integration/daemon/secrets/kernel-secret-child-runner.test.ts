import { describe, expect, test } from 'bun:test';
import type { ChildEnvironment, ChildHandle, SpawnOptions, SpawnPort } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { KernelSecretChildRunner } from '../../../../daemon/adapters/secrets/kernel-secret-child-runner.ts';
import type { ProgramLocator, SecretChildOutcome, SecretChildSpec } from '../../../../daemon/lib/secrets/types.ts';

const ENV = { handle: 'opaque' } as unknown as ChildEnvironment;
const SPEC: SecretChildSpec = {
  command: ['deploy', '--prod'],
  cwd: '/work/app',
  env: ENV,
  timeoutMs: 1000,
  maxOutputBytes: 8,
};
const SPAWN_FAILED: SecretChildOutcome = { outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false };

const stream = (...chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

/** A stream that never ends by itself, as a grandchild keeping the pipe open does. */
const open = (...chunks: string[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } => {
  let cancelled = false;
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel() {
        cancelled = true;
      },
    }),
    cancelled: () => cancelled,
  };
};

interface Started {
  program: string;
  args: readonly string[];
  options: unknown;
}

function machine(child: Partial<ChildHandle> | 'throw', locator?: ProgramLocator) {
  const started: Started[] = [];
  const killed: (string | undefined)[] = [];
  const spawn = {
    start: (program: string, args: readonly string[], options?: SpawnOptions) => {
      started.push({ program, args, options });
      if (child === 'throw') throw new Error('spawn refused');
      return {
        pid: 1,
        stdout: stream(),
        stderr: stream(),
        write: () => undefined,
        kill: (signal?: string) => killed.push(signal),
        exited: Promise.resolve(0),
        pipes: [],
        closePipes: () => undefined,
        ...child,
      } as ChildHandle;
    },
  } as unknown as SpawnPort;
  const clock = fixedClock();
  return { runner: new KernelSecretChildRunner(spawn, clock, locator), started, killed, clock };
}

describe('the secret child runner', () => {
  test('a child that exits is its exit code and its raw output, started without stdin and with only the handle as environment', async () => {
    const { runner, started } = machine({ stdout: stream('ok\n'), stderr: stream('warn'), exited: Promise.resolve(3) });
    expect(await runner.run(SPEC)).toEqual({
      outcome: 'exited',
      exitCode: 3,
      stdout: 'ok\n',
      stderr: 'warn',
      truncated: false,
    });
    expect(started).toEqual([
      { program: 'deploy', args: ['--prod'], options: { cwd: '/work/app', env: ENV, stdin: '' } },
    ]);
  });

  test('a child killed by a signal has no exit code to report', async () => {
    const { runner } = machine({ exited: Promise.resolve(null) });
    expect(await runner.run(SPEC)).toEqual({ outcome: 'exited', stdout: '', stderr: '', truncated: false });
  });

  test('output past the ceiling is cut and said to be cut, whichever stream carried it', async () => {
    const out = machine({ stdout: stream('0123456789', 'abc') });
    expect(await out.runner.run(SPEC)).toMatchObject({ stdout: '01234567', truncated: true });
    const err = machine({ stderr: stream('0123', '456789') });
    expect(await err.runner.run(SPEC)).toMatchObject({ stderr: '01234567', truncated: true });
  });

  test('no command at all is a failed spawn, and nothing is started', async () => {
    const { runner, started } = machine({});
    expect(await runner.run({ ...SPEC, command: [] })).toEqual(SPAWN_FAILED);
    expect(started).toEqual([]);
  });

  test('a spawn the host refuses is a failed spawn that says nothing about what was spawned', async () => {
    const { runner } = machine('throw');
    const outcome = await runner.run(SPEC);
    expect(outcome).toEqual(SPAWN_FAILED);
    expect(JSON.stringify(outcome)).not.toContain('deploy');
  });

  test('a program lookup that fails is a failed spawn before anything starts', async () => {
    const { runner, started } = machine(
      {},
      {
        locate: async () => {
          throw new Error('no PATH');
        },
      },
    );
    expect(await runner.run(SPEC)).toEqual(SPAWN_FAILED);
    expect(started).toEqual([]);
  });

  test('a located program is what is started, and the outcome names it and whether it could be replaced', async () => {
    const seen: unknown[][] = [];
    const locating = (replaceable: boolean): ProgramLocator => ({
      locate: async (program, cwd, path) => {
        seen.push([program, cwd, path]);
        return { program: `/usr/local/bin/${program}`, ...(replaceable ? { replaceable: true as const } : {}) };
      },
    });
    const writable = machine({}, locating(true));
    expect(await writable.runner.run({ ...SPEC, path: '/opt/bin' })).toMatchObject({
      outcome: 'exited',
      program: '/usr/local/bin/deploy',
      replaceable: true,
    });
    expect(writable.started[0]?.program).toBe('/usr/local/bin/deploy');
    expect(seen).toEqual([['deploy', '/work/app', '/opt/bin']]);
    const fixed = machine({}, locating(false));
    const outcome = await fixed.runner.run(SPEC);
    expect(outcome.program).toBe('/usr/local/bin/deploy');
    expect(outcome).not.toHaveProperty('replaceable');
  });

  test('a child that outlives its budget is killed, and what it printed is kept, never an exit status', async () => {
    const stdout = open('partial');
    const stderr = open();
    const { runner, killed, clock } = machine({
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited: new Promise<number | null>(() => undefined),
    });
    const running = runner.run(SPEC);
    await Bun.sleep(0);
    await clock.advance(1000);
    expect(await running).toEqual({ outcome: 'timeout', stdout: 'partial', stderr: '', truncated: true });
    expect(killed).toEqual(['SIGKILL']);
    // The pipe a grandchild kept open is let go, not waited on.
    expect(stdout.cancelled()).toBe(true);
    expect(stderr.cancelled()).toBe(true);
    expect(clock.pending()).toBe(0);
  });
});
