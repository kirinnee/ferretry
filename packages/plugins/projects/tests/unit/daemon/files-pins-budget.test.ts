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

  test('with time left, a descendant is judged as before', async () => {
    const pins = await kernelPins(kernel(hang), browser({}))(budgetOf(5_000));

    expect(await pins.descendant('/h/p/x')).toBeUndefined();
  }, 2_000);
});
