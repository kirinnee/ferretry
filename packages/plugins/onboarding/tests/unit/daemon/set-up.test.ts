import { describe, expect, test } from 'bun:test';
import { machineIsSetUp } from '../../../daemon/lib/set-up.ts';

const listing = (count: number) => ({ list: async () => Array.from({ length: count }, () => ({}) as never) });

describe('machineIsSetUp', () => {
  test('a machine with a runtime is set up', async () => {
    expect(await machineIsSetUp(listing(1))).toBe(true);
  });

  test('a machine with no runtime is not', async () => {
    expect(await machineIsSetUp(listing(0))).toBe(false);
  });

  test('Runtimes off gives setUp false', async () => {
    expect(await machineIsSetUp(undefined)).toBe(false);
  });

  test('Runtimes that cannot be read gives setUp false', async () => {
    expect(
      await machineIsSetUp({
        list: async () => {
          throw new Error('unreadable');
        },
      }),
    ).toBe(false);
  });
});
