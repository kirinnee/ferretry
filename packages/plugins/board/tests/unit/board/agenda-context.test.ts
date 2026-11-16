import { describe, expect, test } from 'bun:test';
import { boardAgendaContext } from '../../../daemon/adapters/agenda-context.ts';

const IN_TEST = { id: 'F9', laneId: 'to-test', workflow: 'quick' };
const laneSet = { lanes: [] } as never;
const lanes = {
  laneForTrigger: (_set: unknown, _workflow: unknown) => ({ ok: true as const, value: { id: 'to-test' } }),
};

const make = (over: Partial<Parameters<typeof boardAgendaContext>[0]> = {}) =>
  boardAgendaContext({
    focusOf: async ferret => (ferret === 'lead' ? { id: 'F12' as never } : null),
    card: async id => (id === 'F9' ? { card: IN_TEST as never, laneSet } : undefined),
    asking: async id => (id === 'F12' ? { ferret: 'lead', id: 'A7' } : undefined),
    machineId: () => 'm1',
    laneForTrigger: lanes.laneForTrigger as never,
    ...over,
  });

describe('M3 Board’s agenda.context provider', () => {
  test('focusOf is the card the ferret works on, or null', async () => {
    expect(await make().focusOf('lead')).toEqual({ id: 'F12' });
    expect(await make().focusOf('other')).toBeNull();
  });

  test('inToTest is true only for a card in the lane release.published enters', async () => {
    expect(await make().inToTest({ id: 'F9' } as never)).toBe(true);
    expect(await make().inToTest({ id: 'F10' } as never)).toBe(false);
    const elsewhere = make({ laneForTrigger: (() => ({ ok: true, value: { id: 'done' } })) as never });
    expect(await elsewhere.inToTest({ id: 'F9' } as never)).toBe(false);
    const none = make({ laneForTrigger: (() => ({ ok: true, value: null })) as never });
    expect(await none.inToTest({ id: 'F9' } as never)).toBe(false);
  });

  test('a card of another machine is not answered here', async () => {
    const ctx = make();
    expect(await ctx.inToTest({ id: 'F9', machineId: 'elsewhere' } as never)).toBe(false);
    expect(await ctx.asking({ id: 'F12', machineId: 'elsewhere' } as never)).toBeUndefined();
    expect(await ctx.inToTest({ id: 'F9', machineId: 'm1' } as never)).toBe(true);
  });

  test('asking names the agenda and item the card’s gate is on; a read that fails throws, never "not asking"', async () => {
    expect(await make().asking({ id: 'F12' } as never)).toEqual({ sessionId: 'lead', id: 'A7' });
    expect(await make().asking({ id: 'F99' } as never)).toBeUndefined();
    await expect(
      make({ asking: async () => Promise.reject(new Error('x')) }).asking({ id: 'F12' } as never),
    ).rejects.toThrow('x');
  });
});
