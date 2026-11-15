import { describe, expect, it } from 'bun:test';
import { boardRuntimeOf } from '../../../app/views/runtime.ts';
import { deferred, flush } from './board-support.ts';

/** Forty chat embeds each ask for the callsigns: they share one read while it is in flight, never a stale one after. */
describe('the Board runtime: ferrets', () => {
  it('shares one GET /v1/ferrets between readers that ask together, and reads afresh the next time', async () => {
    const answers = [deferred<unknown>(), deferred<unknown>()];
    let calls = 0;
    const runtime = boardRuntimeOf({
      call: (async (route: string) => (route === 'GET /v1/ferrets' ? answers[calls++]?.promise : null)) as never,
      subscribe: (() => () => undefined) as never,
    } as never);
    const first = [runtime.ferrets(), runtime.ferrets(), runtime.ferrets()];
    expect(calls).toBe(1);
    answers[0]?.resolve([{ id: 'a', name: 'nimbus', parent: 'b' }, { id: 'b' }]);
    const expected = [
      { id: 'a', name: 'nimbus', parent: 'b' },
      { id: 'b', name: 'b' },
    ];
    for (const read of first) expect(await read).toEqual(expected);
    await flush();
    const later = runtime.ferrets();
    expect(calls).toBe(2);
    answers[1]?.reject(new Error('down'));
    expect(await later).toEqual([]);
  });
});
