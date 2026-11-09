import { describe, expect, test } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { FerretsLiveness } from '../../../daemon/adapters/ferrets.ts';
import { KernelFerretFocus } from '../../../daemon/adapters/store/focus-store.ts';

const COUNT = 500;
const ids = Array.from({ length: COUNT }, (_, i) => `f${i}`);
const file = {
  format: 1,
  ferrets: Object.fromEntries(ids.map(id => [id, { card: { id: `F${id}` }, anchor: null, skip: null }])),
};

/** The real focus store over a state port that counts reads of the one focus file. */
const world = () => {
  const counts = { reads: 0 };
  const state = {
    read: async () => {
      counts.reads += 1;
      return { ok: true, value: file };
    },
  } as unknown as StatePort;
  const focus = new KernelFerretFocus(
    state,
    {} as never,
    { get: async () => undefined },
    { run: async (_key, work) => await work() },
    { warn: () => undefined },
  );
  const ferrets = {
    list: async () => ids.map(id => ({ id, state: 'idle', stateAt: 'now' })) as never,
    get: async (id: string) => ({ id, state: 'idle', stateAt: 'now' }) as never,
  };
  const liveness = new FerretsLiveness(ferrets as never, focus, { run: async (_key, work) => await work() });
  return { counts, liveness };
};

describe('the board roster', () => {
  test('reads the focus file once for 500 ferrets, not once per ferret', async () => {
    const { counts, liveness } = world();
    const roster = await liveness.roster();
    expect(roster.sessions.size).toBe(COUNT);
    expect(roster.sessions.get('f7')?.focusCard).toEqual({ id: 'Ff7' });
    expect(counts.reads).toBe(1);
  });

  test('settled reads the focus file once for the named ferrets', async () => {
    const { counts, liveness } = world();
    await liveness.settled(ids.slice(0, 100), async fresh => {
      expect(fresh.sessions.size).toBe(100);
    });
    expect(counts.reads).toBe(1);
  });
});
