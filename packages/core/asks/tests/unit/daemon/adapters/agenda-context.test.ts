import { describe, expect, test } from 'bun:test';
import { agendaContext } from '../../../../daemon/adapters/agenda-context.ts';
import { subFerretRefusal } from '../../../../daemon/lib/sub-ferret/index.ts';
import type { AgendaBoardContext, AgendaFerretsContext } from '../../../../contract/index.ts';

const TASK = { id: 'F12' } as never;
const ferrets = (over: Partial<AgendaFerretsContext> = {}): AgendaFerretsContext => ({
  has: async id => id === 'lead' || id === 'child',
  leadOf: async id => (id === 'child' ? 'lead' : undefined),
  addressOf: async id => (id === 'lead' ? 'lizzette' : id),
  get: async id => (id === 'lead' ? { id, mode: 'interactive', updatedAt: '1' } : undefined),
  all: async () => ['lead', 'child'],
  ...over,
});
const board = (over: Partial<AgendaBoardContext> = {}): AgendaBoardContext => ({
  focusOf: async () => TASK,
  inToTest: async () => true,
  asking: async () => ({ sessionId: 'lead', id: 'A1' as never }),
  ...over,
});
const of = (f?: AgendaFerretsContext, b?: AgendaBoardContext) =>
  agendaContext(
    key => (key === 'ferrets' ? (f ?? 'unavailable') : (b ?? 'unavailable')) as never,
    () => undefined,
  );

describe('M3 the agenda context Asks binds from agenda.context', () => {
  test('sessions: only a ferret that exists has a board; no Ferrets means none does', async () => {
    expect(await of(ferrets()).sessions.has('lead')).toBe(true);
    expect(await of(ferrets()).sessions.has('ghost')).toBe(false);
    expect(await of().sessions.has('lead')).toBe(false);
    expect(await of(ferrets({ has: async () => Promise.reject(new Error('x')) })).sessions.has('lead')).toBe(false);
  });

  test('subFerrets: lineage from Ferrets; unreadable lineage is said, never read as "a lead"', async () => {
    const ctx = of(ferrets());
    expect(await ctx.subFerrets.leadOf('child')).toBe('lead');
    expect(await ctx.subFerrets.leadOf('lead')).toBeUndefined();
    expect(await ctx.subFerrets.addressOf('lead')).toBe('lizzette');
    expect(await ctx.subFerrets.readable?.('child')).toBe(true);
    expect(await of().subFerrets.readable?.('child')).toBe(false);
    const down = of(ferrets({ leadOf: async () => Promise.reject(new Error('down')) }));
    expect(await down.subFerrets.readable?.('child')).toBe(false);
  });

  test('subFerrets.lineage reads Ferrets ONCE: readable and lead come from the same answer', async () => {
    let reads = 0;
    const counted = of(
      ferrets({
        leadOf: async id => {
          reads += 1;
          return id === 'child' ? 'lead' : undefined;
        },
      }),
    );
    expect(await counted.subFerrets.lineage?.('child')).toEqual({ readable: true, lead: 'lead' });
    expect(reads).toBe(1);
    expect(await counted.subFerrets.lineage?.('lead')).toEqual({ readable: true, lead: undefined });
    expect(await of().subFerrets.lineage?.('child')).toEqual({ readable: false });
    const down = of(ferrets({ leadOf: async () => Promise.reject(new Error('down')) }));
    expect(await down.subFerrets.lineage?.('child')).toEqual({ readable: false });
  });

  test('a provider that answers once and then goes away refuses the raise (fail closed on the second read)', async () => {
    let gone = false;
    const ctx = agendaContext(
      key =>
        key === 'ferrets'
          ? gone
            ? 'unavailable'
            : ferrets({
                leadOf: async id => {
                  gone = true;
                  return id === 'child' ? 'lead' : undefined;
                },
              })
          : 'unavailable',
      () => undefined,
    );
    const refusal = await subFerretRefusal(ctx.subFerrets, 'child', 'raise agenda items');
    expect(refusal).not.toBeNull();
  });

  test('focus and cards come from Board; absent Board is benign (no focus card, not in to-test)', async () => {
    expect(await of(undefined, board()).focus.focusOf('lead')).toEqual(TASK);
    expect(await of(undefined, board()).cards.inToTest(TASK)).toBe(true);
    expect(await of().focus.focusOf('lead')).toBeNull();
    expect(await of().cards.inToTest(TASK)).toBe(false);
  });

  test('gates: Board answers where the card asks; absent or throwing Board rejects so the service reads "asking"', async () => {
    expect(await of(undefined, board()).gates.asking(TASK)).toEqual({ sessionId: 'lead', id: 'A1' });
    await expect(of().gates.asking(TASK)).rejects.toThrow();
    await expect(
      of(undefined, board({ asking: async () => Promise.reject(new Error('x')) })).gates.asking(TASK),
    ).rejects.toThrow();
  });

  test('homes: a sub-ferret of an owner-started lead lands on the lead', async () => {
    const f = ferrets({
      get: async id =>
        id === 'lead'
          ? { id, mode: 'interactive', updatedAt: '1', origin: 'human' }
          : id === 'child'
            ? { id, parent: 'lead', mode: 'auto', updatedAt: '2' }
            : undefined,
    });
    expect(await of(f).homes.of('child')).toBe('lead');
    expect(await of().homes.of('child')).toBe('child');
  });
});
