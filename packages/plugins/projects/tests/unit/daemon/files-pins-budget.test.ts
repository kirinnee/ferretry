/**
 * The project pins spend the build's deadline (&F6061 U5 review R2): reading the privacy policy, holding the folder and
 * judging a descendant each list whole folders, and none of them may run on after the time is gone.
 */
import { describe, expect, test } from 'bun:test';
import type { KernelPorts, SpawnBudget } from '@ferretry/kernel/contract';
import type { FolderBrowser } from '../../../daemon/features/folders/port.ts';
import { kernelPins } from '../../../daemon/features/files/pins.ts';

/** Never answers: a folder listing that does not come back before the deadline. */
const hang = <T>(): Promise<T> => new Promise<T>(() => undefined);

const budgetOf = (ms: number): SpawnBudget => {
  const end = Date.now() + ms;
  return { expired: () => Date.now() >= end, remainingMs: () => Math.max(0, end - Date.now()) };
};

const browser = (over: Partial<FolderBrowser>): FolderBrowser => ({
  home: async () => '/h',
  realPaths: async () => [],
  holdsSignIn: async () => false,
  leaf: async () => 'present',
  open: async () => ({ ok: false, reason: 'refused' }),
  ...over,
});

const kernel = (realPath: () => Promise<string>) =>
  ({
    clock: {
      after: (delay: number, fn: () => void) => {
        const timer = setTimeout(fn, Number(delay));
        return () => clearTimeout(timer);
      },
    },
    roots: {
      root: () => ({ resolve: () => ({ ok: true, value: '' }), realPath }),
    },
  }) as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>;

describe('the pins are spent from the build’s deadline', () => {
  test('a privacy policy that never finishes reading ends at the deadline, and every pin then says the time ran out', async () => {
    const pins = await kernelPins(kernel(hang), browser({ realPaths: hang }))(budgetOf(40));

    expect(await pins.project('/h/p')).toEqual({ ok: false, reason: 'spent' });
    expect(await pins.nested('/h/p/n')).toEqual({ ok: false, reason: 'spent' });
    expect(await pins.descendant('/h/p/x')).toBe('spent');
  }, 2_000);

  test('a descendant whose sign-in look never answers is "spent" at the deadline, not waited for', async () => {
    const pins = await kernelPins(kernel(hang), browser({ holdsSignIn: hang }))(budgetOf(40));

    expect(await pins.descendant('/h/p/x')).toBe('spent');
  }, 2_000);

  test('holding the project folder that never resolves is "spent" at the deadline', async () => {
    const pins = await kernelPins(kernel(hang), browser({}))(budgetOf(40));

    expect(await pins.project('/h/p')).toEqual({ ok: false, reason: 'spent' });
  }, 2_000);

  test('a descendant whose sign-in look saw only part of its names is "partial", not accepted (U4’s completeness-aware look)', async () => {
    const wide = browser({ holdsSignIn: async path => (path === '/h/p/wide' ? 'partial' : false) });
    const pins = await kernelPins(kernel(hang), wide)(budgetOf(5_000));

    expect(await pins.descendant('/h/p/wide')).toBe('partial');
    expect(await pins.descendant('/h/p/narrow')).toBeUndefined();
  }, 2_000);

  test('a descendant holding a sign-in file is "private", and a folder outside every home is not a descendant', async () => {
    const pins = await kernelPins(
      kernel(hang),
      browser({ holdsSignIn: async path => path === '/h/p/vault' }),
    )(budgetOf(5_000));

    expect(await pins.descendant('/h/p/vault')).toBe('private');
    expect(await pins.descendant('/proc/self')).toBe('unreadable');
  }, 2_000);

  test('with time left, a descendant is judged as before', async () => {
    const pins = await kernelPins(kernel(hang), browser({}))(budgetOf(5_000));

    expect(await pins.descendant('/h/p/x')).toBeUndefined();
  }, 2_000);
});

/** A promise the test settles by hand: "the disk answers late" made deterministic. */
function pending<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every queued continuation run (a late answer's whole chain), without a timer the build's deadline could race. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn++) await new Promise(done => setTimeout(done, 0));
};

/**
 * A kernel whose `realPath` and `pin` are held by the test, and which records every folder it was asked to hold and every
 * descriptor it closed. `expiresNow()` spends the budget at a moment the test picks, so nothing races a timer.
 */
function controlled() {
  const realPath = pending<string>();
  const pin = pending<{ rootReal: string; close: () => Promise<void> }>();
  const log = { realPaths: 0, pins: 0, closed: 0 };
  const clock = {
    after: (_delay: number, _fn: () => void) => () => undefined,
  };
  const roots = {
    root: () => ({
      resolve: () => ({ ok: true, value: '' }),
      realPath: async () => {
        log.realPaths += 1;
        return await realPath.promise;
      },
      pin: async () => {
        log.pins += 1;
        const held = await pin.promise;
        return {
          ...held,
          close: async () => {
            log.closed += 1;
          },
        };
      },
    }),
  };
  let spent = false;
  const budget: SpawnBudget = { expired: () => spent, remainingMs: () => (spent ? 0 : 1_000) };
  return {
    kernel: { clock, roots } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>,
    realPath,
    pin,
    log,
    budget,
    expiresNow: () => {
      spent = true;
    },
  };
}

/** A clock that fires the deadline when the test says so (the build's own `after`), so `within` stops waiting on cue. */
function cuedClock() {
  const timers: (() => void)[] = [];
  return {
    clock: {
      after: (_delay: number, fn: () => void) => {
        timers.push(fn);
        return () => undefined;
      },
    },
    fire: () => {
      for (const fn of timers.splice(0)) fn();
    },
  };
}

describe('no new work starts after the deadline, whichever stage of it was pending when the time ran out (R3)', () => {
  test('a realPath that arrives after the deadline starts no sign-in verdict and no pin', async () => {
    const world = controlled();
    const cue = cuedClock();
    const signIn: string[] = [];
    const pins = await kernelPins(
      { ...world.kernel, clock: cue.clock } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>,
      browser({
        holdsSignIn: async path => {
          signIn.push(path);
          return false;
        },
      }),
    )(world.budget);

    const held = pins.project('/h/a/b');
    await flush();
    expect(world.log.realPaths).toBe(1);
    world.expiresNow();
    cue.fire();
    expect(await held).toEqual({ ok: false, reason: 'spent' });
    // The folder resolves only now, after the time is gone.
    world.realPath.resolve('/h/a/b');
    await flush();

    expect(signIn).toEqual([]);
    expect(world.log.pins).toBe(0);
  }, 2_000);

  test('a sign-in verdict that arrives after the deadline starts no further verdict and no pin', async () => {
    const world = controlled();
    const cue = cuedClock();
    const first = pending<boolean>();
    const signIn: string[] = [];
    const pins = await kernelPins(
      { ...world.kernel, clock: cue.clock } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>,
      browser({
        holdsSignIn: async path => {
          signIn.push(path);
          return await first.promise;
        },
      }),
    )(world.budget);

    const held = pins.project('/h/a/b');
    world.realPath.resolve('/h/a/b');
    await flush();
    expect(signIn).toEqual(['/h/a']);
    world.expiresNow();
    cue.fire();
    expect(await held).toEqual({ ok: false, reason: 'spent' });
    first.resolve(false);
    await flush();

    // `/h/a/b` (the next ancestor) is not looked at, and nothing is pinned.
    expect(signIn).toEqual(['/h/a']);
    expect(world.log.pins).toBe(0);
  }, 2_000);

  test('a descriptor that arrives after the deadline is closed, and the held folder is not judged again', async () => {
    const world = controlled();
    const cue = cuedClock();
    const signIn: string[] = [];
    const pins = await kernelPins(
      { ...world.kernel, clock: cue.clock } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>,
      browser({
        holdsSignIn: async path => {
          signIn.push(path);
          return false;
        },
      }),
    )(world.budget);

    const held = pins.project('/h/p');
    world.realPath.resolve('/h/p');
    await flush();
    expect(world.log.pins).toBe(1);
    const verdicts = signIn.length;
    world.expiresNow();
    cue.fire();
    expect(await held).toEqual({ ok: false, reason: 'spent' });
    world.pin.resolve({ rootReal: '/h/p', close: async () => undefined });
    await flush();

    expect(world.log.closed).toBe(1);
    expect(signIn.length).toBe(verdicts);
  }, 2_000);

  test('a home that arrives after the deadline starts no read of where the private folders are', async () => {
    const world = controlled();
    const cue = cuedClock();
    const home = pending<string>();
    const realPaths: (readonly string[])[] = [];
    const reading = kernelPins(
      { ...world.kernel, clock: cue.clock } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>,
      browser({
        home: async () => await home.promise,
        realPaths: async paths => {
          realPaths.push(paths);
          return [];
        },
      }),
    )(world.budget);
    await flush();
    world.expiresNow();
    cue.fire();
    const pins = await reading;
    expect(await pins.project('/h/p')).toEqual({ ok: false, reason: 'spent' });
    home.resolve('/h');
    await flush();

    expect(realPaths).toEqual([]);
  }, 2_000);

  test('a build that stopped waiting is still counted as running until the work it started has actually stopped', async () => {
    const world = controlled();
    const cue = cuedClock();
    const pins = await kernelPins(
      { ...world.kernel, clock: cue.clock } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>,
      browser({}),
    )(world.budget);
    const held = pins.project('/h/p');
    await flush();
    world.expiresNow();
    cue.fire();
    await held;

    let stopped = false;
    void pins.settled?.().then(() => {
      stopped = true;
    });
    await flush();
    expect(pins.settled).toBeDefined();
    expect(stopped).toBe(false);

    world.realPath.resolve('/h/p');
    await flush();
    expect(stopped).toBe(true);
  }, 2_000);
});
