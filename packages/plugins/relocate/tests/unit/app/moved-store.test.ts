/** U16: the stub ledger the "Moved to" mark reads: read once, read again after a move, and an unreadable ledger is an empty one. */
import { describe, expect, it } from 'bun:test';
import { createMovedStore } from '../../../app/lib/moved-store.ts';

const ENTRY = { daemonId: `fy_daemon_${'B'.repeat(43)}`, ferretId: 'g9', at: '2026-11-28T00:00:00.000Z' };
const ledger = { moved: { f1: ENTRY } } as never;

const clientOf = (answers: unknown[]) => {
  const calls: string[] = [];
  return {
    calls,
    client: {
      call: (async (route: string) => {
        calls.push(route);
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      }) as never,
    },
  };
};
const settle = async () => await new Promise(resolve => setTimeout(resolve, 0));

describe('the moved store', () => {
  it('starts empty, reads on the first subscription only, and tells listeners when the ledger changes', async () => {
    const { client, calls } = clientOf([ledger, ledger]);
    const store = createMovedStore(client);
    expect(store.snapshot()).toEqual({ moved: {} });
    let told = 0;
    const off = store.subscribe(() => {
      told += 1;
    });
    store.subscribe(() => undefined);
    await settle();
    expect(calls).toEqual(['GET /v1/relocate/moved']);
    expect(store.snapshot()).toEqual(ledger);
    expect(told).toBe(1);
    await store.refresh();
    expect(told).toBe(1);
    off();
  });

  it('keeps what it had when the read fails or answers nonsense, and says nothing', async () => {
    const { client } = clientOf([new Error('down'), { nope: true }]);
    const store = createMovedStore(client);
    let told = 0;
    store.subscribe(() => {
      told += 1;
    });
    await settle();
    await store.refresh();
    expect(store.snapshot()).toEqual({ moved: {} });
    expect(told).toBe(0);
  });
});
