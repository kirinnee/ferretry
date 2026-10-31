import { describe, it } from 'bun:test';
import should from 'should';
import { type DaemonWorld, start } from '../../../bin/fyd.ts';
import { releaseAcquired, terminationGate } from '../../../src/adapters/runtime/termination-gate.ts';
import { StateHomeLockedError } from '../../../src/adapters/storage/home-lock.ts';

/**
 * F5 of the #1094 review: the saved-login sweep writes under the state home's lock, so the lock must outlive
 * it. A boot that is stopped (SIGTERM/SIGINT) while the sweep is in flight drains it BEFORE storage closes and
 * releases the lock; a stop that arrives before the sweep starts means it never starts; a boot that does not
 * hold the lock never sweeps. Everything is faked: no file, lock or process is touched, and the termination gate
 * is the production one with a fake exit and a fake signal target.
 */

const STOP = new Error('the probe stops the boot before configuration IO');

function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

function rig(options: { readonly refuse?: boolean; readonly holdBeforeSweep?: boolean } = {}) {
  const sweepEntered = deferred();
  const finishSweep = deferred();
  const beforeSweep = deferred();
  const pastRedirects = deferred();
  const exited = deferred();
  const order: string[] = [];
  const cleanups: Array<() => void | Promise<void>> = [];
  const state = { held: false, pending: false, sweepCalls: 0, configCalls: 0 };
  const world = {
    role: 'daemon',
    clock: { now: () => Date.now() },
    notices: { state: () => undefined, step: () => undefined },
    boot: {
      activities: { inFlight: () => [], current: () => undefined },
      beginProgress: () => ({ enter: () => undefined, snapshot: () => ({}) }),
      watchdogLimitMs: 0,
      sweepPairingRedirects: async () => {
        if (options.holdBeforeSweep === true) {
          pastRedirects.resolve();
          await beforeSweep.promise;
        }
        return 0;
      },
      sweepSavedLogins: async () => {
        state.sweepCalls += 1;
        state.pending = true;
        order.push(`sweep started; lock held=${state.held}`);
        sweepEntered.resolve();
        await finishSweep.promise;
        order.push(`sweep wrote; lock held=${state.held}`);
        state.pending = false;
        return { swept: 1 };
      },
    },
    tmuxControl: { stop: async () => undefined },
    storage: {
      open: async () => {
        if (options.refuse === true) throw new StateHomeLockedError('/fake/home/daemon.lock');
        state.held = true;
        order.push('lock acquired');
        return {
          paths: { home: '/fake/home' },
          storage: {
            close: async () => {
              await Promise.resolve();
              state.held = false;
              order.push(`lock released; sweep pending=${state.pending}`);
            },
          },
        };
      },
    },
    config: {
      peek: async () => {
        state.configCalls += 1;
        order.push('configuration read');
        throw STOP;
      },
    },
  } as unknown as DaemonWorld;
  const listeners = new Map<string, () => void>();
  terminationGate(
    async () => await releaseAcquired(cleanups),
    () => {
      order.push(`exit; sweep pending=${state.pending}`);
      exited.resolve();
    },
    { once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => void listeners.set(signal, listener) },
    () => cleanups.length > 0,
  );
  const run = (): Promise<number | 'stopped'> =>
    start(world, cleanups).catch((error: unknown) => {
      if (error !== STOP) throw error;
      return 'stopped' as const;
    });
  const sigterm = (): void => {
    const fire = listeners.get('SIGTERM');
    if (fire === undefined) throw new Error('no SIGTERM listener');
    fire();
  };
  return { world, cleanups, order, state, run, sigterm, sweepEntered, finishSweep, beforeSweep, pastRedirects, exited };
}

const ticks = async (count = 20): Promise<void> => {
  for (let tick = 0; tick < count; tick += 1) await Promise.resolve();
};

describe('the saved-login boot sweep and the state home lock', () => {
  it('should never sweep when another daemon holds the home', async () => {
    const r = rig({ refuse: true });
    const code = await r.run();
    await releaseAcquired(r.cleanups);

    should(code).be.a.Number();
    should(r.state.sweepCalls).equal(0);
    should(r.state.configCalls).equal(0);
  });

  it('should sweep while holding the lock and finish before the boot reads its configuration', async () => {
    const r = rig();
    const running = r.run();
    await r.sweepEntered.promise;
    should(r.state.held).be.true();
    should(r.state.configCalls).equal(0);
    r.finishSweep.resolve();
    await running;
    await releaseAcquired(r.cleanups);

    should(r.order.slice(0, 4)).deepEqual([
      'lock acquired',
      'sweep started; lock held=true',
      'sweep wrote; lock held=true',
      'configuration read',
    ]);
  });

  it('should drain an in-flight sweep BEFORE releasing the lock when stopped mid-boot, then exit', async () => {
    const r = rig();
    const running = r.run();
    await r.sweepEntered.promise;
    r.sigterm();
    await ticks();

    // The stop is waiting on the sweep: the lock is still held and the process has not exited.
    should(r.state.held).be.true();
    should(r.order.some(line => line.startsWith('exit'))).be.false();
    r.finishSweep.resolve();
    await r.exited.promise;
    await running.catch(() => undefined);

    const wrote = r.order.indexOf('sweep wrote; lock held=true');
    const released = r.order.indexOf('lock released; sweep pending=false');
    const exit = r.order.indexOf('exit; sweep pending=false');
    should(wrote).be.above(-1);
    should(released).be.above(wrote);
    should(exit).be.above(released);
  });

  it('should not start the sweep at all once a stop has begun', async () => {
    const r = rig({ holdBeforeSweep: true });
    const running = r.run();
    await r.pastRedirects.promise;
    r.sigterm();
    await r.exited.promise;
    r.beforeSweep.resolve();
    await running.catch(() => undefined);

    should(r.state.sweepCalls).equal(0);
    should(r.order.some(line => line.startsWith('sweep'))).be.false();
  });
});
