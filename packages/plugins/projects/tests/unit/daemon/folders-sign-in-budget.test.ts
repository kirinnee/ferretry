/**
 * The sign-in look starts no I/O once the build's time is gone (&F6061 U5 review R4 items a, b): the budget is asked
 * immediately before the stat, before EACH known-marker lstat, and before the pin, the open and the list. A call that was
 * already pending when the time ran out may return late, but nothing after it is started, and every descriptor the look
 * opened is closed (opens == closes). The kernel here is a fake the test controls, so "the answer comes back past the
 * deadline" is a deterministic event, not a race.
 */
import { describe, expect, test } from 'bun:test';
import type { KernelPorts } from '@ferretry/kernel/contract';
import { SIGN_IN_FILES } from '@ferretry/std';
import { kernelBrowser } from '../../../daemon/features/folders/adapter.ts';

type Step = 'stat' | 'lstat' | 'pin' | 'open' | 'list';

/** What the fake disk was asked, and what it was left holding. */
function disk(spendAt: Step, onNth = 1) {
  const log = { stat: 0, lstat: 0, pin: 0, open: 0, list: 0, pinsClosed: 0, targetsClosed: 0 };
  let spent = false;
  const reach = (step: Step): void => {
    log[step] += 1;
    // The call is already in flight when the time runs out: it returns, but past the deadline.
    if (step === spendAt && log[step] === onNth) spent = true;
  };
  const kernel = {
    roots: {
      root: () => ({
        resolve: () => ({ ok: true, value: '' }),
        stat: async () => {
          reach('stat');
          return { kind: 'directory' };
        },
        lstat: async () => {
          reach('lstat');
          return undefined;
        },
        pin: async () => {
          reach('pin');
          return {
            open: async () => {
              reach('open');
              return {
                list: async () => {
                  reach('list');
                  return { entries: [{ name: 'a.txt', type: 'file' }], truncated: false };
                },
                close: async () => {
                  log.targetsClosed += 1;
                },
              };
            },
            close: async () => {
              log.pinsClosed += 1;
            },
          };
        },
      }),
    },
  } as unknown as Pick<KernelPorts, 'roots' | 'paths' | 'spawn'>;
  return { kernel, log, budget: { expired: () => spent, remainingMs: () => (spent ? 0 : 1_000) } };
}

describe('the sign-in look asks the budget before each step and starts nothing once it is gone', () => {
  test('a stat that returns past the deadline starts no marker lstat, no pin, no open and no list', async () => {
    const world = disk('stat');

    expect(await kernelBrowser(world.kernel).holdsSignIn('/h/p/x', world.budget)).toBe('partial');

    expect(world.log).toEqual({ stat: 1, lstat: 0, pin: 0, open: 0, list: 0, pinsClosed: 0, targetsClosed: 0 });
  });

  test('the budget running out inside the marker lstats stops the very next lstat, not the remaining nine', async () => {
    expect(SIGN_IN_FILES.length).toBeGreaterThan(3);
    const world = disk('lstat', 3);

    expect(await kernelBrowser(world.kernel).holdsSignIn('/h/p/x', world.budget)).toBe('partial');

    expect(world.log).toEqual({ stat: 1, lstat: 3, pin: 0, open: 0, list: 0, pinsClosed: 0, targetsClosed: 0 });
  });

  test('a pin that returns past the deadline starts no open and no list, and the descriptor is closed', async () => {
    const world = disk('pin');

    expect(await kernelBrowser(world.kernel).holdsSignIn('/h/p/x', world.budget)).toBe('partial');

    expect(world.log.pin).toBe(1);
    expect(world.log.open).toBe(0);
    expect(world.log.list).toBe(0);
    expect(world.log.pinsClosed).toBe(world.log.pin);
  });

  test('an open that returns past the deadline starts no list, and both descriptors are closed', async () => {
    const world = disk('open');

    expect(await kernelBrowser(world.kernel).holdsSignIn('/h/p/x', world.budget)).toBe('partial');

    expect(world.log.open).toBe(1);
    expect(world.log.list).toBe(0);
    expect(world.log.targetsClosed).toBe(world.log.open);
    expect(world.log.pinsClosed).toBe(world.log.pin);
  });

  test('with time left every step runs, the look is whole, and what it opened it closed', async () => {
    const world = disk('list', 99);

    expect(await kernelBrowser(world.kernel).holdsSignIn('/h/p/x', world.budget)).toBe(false);

    expect(world.log).toEqual({
      stat: 1,
      lstat: SIGN_IN_FILES.length,
      pin: 1,
      open: 1,
      list: 1,
      pinsClosed: 1,
      targetsClosed: 1,
    });
  });
});
