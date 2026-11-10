import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { milliseconds } from '@ferretry/std';
import { AdmissionPort } from '../../../contract/bound.ts';
import type { Log } from '../../../contract/ports.ts';
import { bootHost, type HostOptions } from '../../../host/host.ts';
import { DEFAULT_STOP_DEADLINE_MS, JobRunner } from '../../../host/jobs.ts';
import { STOP_LIMIT_MS, stopOnSignal, type StopProcess } from '../../../host/stop-signals.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, silentLog } from './fixtures.ts';

/** A log that keeps what it was told, with its fields. */
const recordingLog = () => {
  const warned: { message: string; fields: unknown }[] = [];
  const log: Log = {
    ...silentLog,
    warn: (message: string, fields?: unknown) => void warned.push({ message, fields }),
    child: () => log,
  };
  return { log, warned };
};

describe('stopping the jobs is bounded', () => {
  test('a job that ignores the abort signal no longer blocks stop past the deadline, and is named', async () => {
    const clock = fixedClock();
    const { log, warned } = recordingLog();
    const jobs = new JobRunner(clock, log);
    jobs.portFor('board').add({
      id: 'stuck',
      schedule: { every: milliseconds(10) },
      run: () => new Promise<void>(() => {}),
    });
    jobs.start();
    await clock.advance(0);

    let stopped = false;
    const stopping = jobs.stop().then(() => {
      stopped = true;
    });
    await clock.advance(DEFAULT_STOP_DEADLINE_MS - 1);
    expect(stopped).toBe(false);
    await clock.advance(1);
    await stopping;

    expect(stopped).toBe(true);
    expect(warned.map(entry => entry.fields)).toEqual([{ job: 'board/stuck' }]);
    expect(clock.pending()).toBe(0);
  });

  test('a job that honours the abort signal stops at once and nothing is named', async () => {
    const clock = fixedClock();
    const { log, warned } = recordingLog();
    const jobs = new JobRunner(clock, log);
    jobs.portFor('board').add({
      id: 'polite',
      schedule: { every: milliseconds(10) },
      run: signal => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
    });
    jobs.start();
    await clock.advance(0);

    await jobs.stop();

    expect(warned).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test('only the stuck job is named when another one honours the signal', async () => {
    const clock = fixedClock();
    const { log, warned } = recordingLog();
    const jobs = new JobRunner(clock, log, () => true, { stopDeadlineMs: 50 });
    const add = (id: string, run: (signal: AbortSignal) => Promise<void>) =>
      jobs.portFor('p').add({ id, schedule: { every: milliseconds(10) }, run });
    add('polite', signal => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())));
    add('stuck', () => new Promise<void>(() => {}));
    jobs.start();
    await clock.advance(0);

    const stopping = jobs.stop();
    await new Promise(resolve => setImmediate(resolve));
    await clock.advance(50);
    await stopping;

    expect(warned.map(entry => entry.fields)).toEqual([{ job: 'p/stuck' }]);
  });

  test('a job that answers the abort by throwing is not logged as a failure at shutdown', async () => {
    const clock = fixedClock();
    const { log, warned } = recordingLog();
    const jobs = new JobRunner(clock, log);
    jobs.portFor('board').add({
      id: 'throws-on-abort',
      schedule: { every: milliseconds(10) },
      run: signal =>
        new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    jobs.start();
    await clock.advance(0);

    await jobs.stop();

    expect(warned).toEqual([]);
    expect(jobs.reports().map(job => job.failures)).toEqual([0]);
  });

  test('a job that throws while it is still wanted is still logged as a failure', async () => {
    const clock = fixedClock();
    const { log, warned } = recordingLog();
    const jobs = new JobRunner(clock, log);
    jobs.portFor('board').add({
      id: 'broken',
      schedule: { every: milliseconds(1_000) },
      run: () => Promise.reject(new Error('broken')),
    });
    jobs.start();
    await clock.advance(0);

    expect(warned.map(entry => entry.message)).toEqual(['a job failed']);
    await jobs.stop();
  });
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('the host releases its home even when a job ignores the stop', () => {
  test('lease.release is still called once the bounded jobs stop has given up on the stuck job', async () => {
    const root = await mkdtemp(`${tmpdir()}/host-stop-deadline-`);
    roots.push(root);
    const home = `${root}/home`;
    const clock = fixedClock();
    const released: string[] = [];
    const adapters: HostOptions['adapters'] = {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock,
      homeLock: async () => ({
        release: async () => {
          released.push('lock');
        },
      }),
    };
    const gate = definePlugin({
      version: '5.0.0',
      api: 5,
      kinds: [],
      id: 'gate',
      title: 'Gate',
      core: true,
      provides: { admission: AdmissionPort },
    });
    const result = await bootHost({
      home,
      version: '5.0.0',
      implementations: [
        implementDaemon(gate, {
          build: ctx => {
            ctx.kernel.jobs.add({
              id: 'stuck',
              schedule: { every: milliseconds(1_000) },
              run: () => new Promise<void>(() => {}),
            });
            return { provides: { admission: recordingAdmission() } };
          },
        }),
      ],
      adapters,
    });
    if (result.kind !== 'running') throw new Error(result.sentence);
    await clock.advance(1_000);

    const stopping = result.host.stop();
    expect(released).toEqual([]);
    await clock.advance(DEFAULT_STOP_DEADLINE_MS);
    await stopping;

    expect(released).toEqual(['lock']);
  });
});

/** A process whose signals and exit the test drives. */
const fakeProcess = () => {
  const handlers = new Map<string, (() => void)[]>();
  const exits: number[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  const proc: StopProcess = {
    once: (signal, handler) => void handlers.set(signal, [...(handlers.get(signal) ?? []), handler]),
    on: (signal, handler) => void handlers.set(signal, [...(handlers.get(signal) ?? []), handler]),
    exit: code => void exits.push(code),
    after: (ms, fn) => void timers.push({ ms, fn }),
  };
  const signal = (name: string) => {
    for (const handler of handlers.get(name) ?? []) handler();
  };
  return { proc, signal, exits, timers };
};

describe('the daemon process ends even when a stop never finishes', () => {
  test('a stop that finishes resolves the wait and ends nothing by force', async () => {
    const world = fakeProcess();
    const waiting = stopOnSignal(async () => {}, world.proc);
    world.signal('SIGTERM');
    await waiting;
    expect(world.exits).toEqual([]);
    expect(world.timers.map(timer => timer.ms)).toEqual([STOP_LIMIT_MS]);
  });

  test('a stop still running at the limit ends the process with 1', async () => {
    const world = fakeProcess();
    void stopOnSignal(() => new Promise<void>(() => {}), world.proc);
    world.signal('SIGTERM');
    expect(world.exits).toEqual([]);
    world.timers[0]?.fn();
    expect(world.exits).toEqual([1]);
  });

  test('a second signal ends the process with 1 at once', async () => {
    const world = fakeProcess();
    void stopOnSignal(() => new Promise<void>(() => {}), world.proc);
    world.signal('SIGTERM');
    world.signal('SIGTERM');
    expect(world.exits).toEqual([1]);
  });

  test('SIGTERM then SIGINT begins one stop and one limit timer, never a second of each', () => {
    const world = fakeProcess();
    let stops = 0;
    void stopOnSignal(() => {
      stops += 1;
      return new Promise<void>(() => {});
    }, world.proc);
    world.signal('SIGTERM');
    world.signal('SIGINT');
    expect(stops).toBe(1);
    expect(world.timers).toHaveLength(1);
    expect(world.exits).toEqual([1]);
  });

  test('a stop that rejects ends the process with 1 and is no unhandled rejection', async () => {
    const world = fakeProcess();
    void stopOnSignal(() => Promise.reject(new Error('stop failed')), world.proc);
    world.signal('SIGTERM');
    await new Promise(resolve => setImmediate(resolve));
    expect(world.exits).toEqual([1]);
  });
});
