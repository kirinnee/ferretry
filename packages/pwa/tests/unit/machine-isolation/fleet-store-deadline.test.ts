/**
 * A machine whose list read never answers must not pin its slot forever: the store gives up after its
 * deadline, says the machine did not answer, asks again on the next poll — and another machine's list is
 * never waiting on any of it.
 */
import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DaemonFleetStore } from '../../../src/lib/fleet-store.ts';
import type { DeadlineSchedule } from '../../../src/lib/machine-deadline.ts';
import { sessionView } from '../../support/sessions.ts';

const asleep = daemonConnection({ daemonId: 'asleep', baseUrl: 'https://asleep.invalid', deviceId: 'a' });
const awake = daemonConnection({ daemonId: 'awake', baseUrl: 'https://awake.invalid', deviceId: 'b' });

const manualClock = () => {
  const timers = new Set<() => void>();
  const schedule: DeadlineSchedule = run => {
    timers.add(run);
    return () => timers.delete(run);
  };
  return {
    schedule,
    fire: () => {
      for (const run of [...timers]) {
        timers.delete(run);
        run();
      }
    },
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(onResolve => {
    resolve = onResolve;
  });
  return { promise, resolve };
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('DaemonFleetStore list deadline', () => {
  it('answers the healthy machine at once while the asleep one hangs, then marks only the asleep one', async () => {
    const clock = manualClock();
    const asleepReads: ReturnType<typeof deferred<readonly SessionView[]>>[] = [];
    const store = new DaemonFleetStore(
      {
        list: daemon => {
          if (daemon.daemonId === awake.daemonId) return Promise.resolve([sessionView('ivo')]);
          const read = deferred<readonly SessionView[]>();
          asleepReads.push(read);
          return read.promise;
        },
        get: () => Promise.reject(new Error('unused')),
      },
      () => 1_000,
      { listTimeoutMs: 15_000, schedule: clock.schedule },
    );
    const hung = store.hydrate(asleep).catch((cause: unknown) => cause);
    await store.hydrate(awake);
    expect(store.fleet(awake.daemonId)).toMatchObject({ status: 'ready', error: null });
    expect(store.fleet(awake.daemonId).sessions?.map(view => view.config.id)).toEqual(['ivo']);
    expect(store.fleet(asleep.daemonId).status).toBe('loading');

    clock.fire();
    expect(((await hung) as Error).message).toBe('did not answer within 15s');
    expect(store.fleet(asleep.daemonId)).toMatchObject({
      status: 'error',
      error: 'the machine did not answer within 15s',
    });
    expect(store.fleet(awake.daemonId).status).toBe('ready');

    // The slot was released: the next poll asks again rather than joining the dead read.
    void store.hydrate(asleep).catch(() => undefined);
    expect(asleepReads).toHaveLength(2);
  });

  it('publishes a late answer, but never one older than an answer already published', async () => {
    const clock = manualClock();
    const reads: ReturnType<typeof deferred<readonly SessionView[]>>[] = [];
    const store = new DaemonFleetStore(
      {
        list: () => {
          const read = deferred<readonly SessionView[]>();
          reads.push(read);
          return read.promise;
        },
        get: () => Promise.reject(new Error('unused')),
      },
      () => 1_000,
      { listTimeoutMs: 15_000, schedule: clock.schedule },
    );
    void store.hydrate(asleep).catch(() => undefined);
    clock.fire();
    await settle();
    void store.hydrate(asleep).catch(() => undefined);
    reads[1]?.resolve([sessionView('fresh')]);
    await settle();
    expect(store.fleet(asleep.daemonId).sessions?.map(view => view.config.id)).toEqual(['fresh']);
    reads[0]?.resolve([sessionView('stale')]);
    await settle();
    expect(store.fleet(asleep.daemonId).sessions?.map(view => view.config.id)).toEqual(['fresh']);

    // With nothing newer published, a late answer is still a good answer.
    void store.hydrate(awake).catch(() => undefined);
    clock.fire();
    await settle();
    expect(store.fleet(awake.daemonId).status).toBe('error');
    reads[2]?.resolve([sessionView('late')]);
    await settle();
    expect(store.fleet(awake.daemonId)).toMatchObject({ status: 'ready', error: null });
  });
});
