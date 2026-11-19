import { describe, expect, test } from 'bun:test';
import { LEDGER_MAX_ENTRIES, LEDGER_WINDOW_MS, PostLedger, type Settled } from '../../daemon/features/post/ledger.ts';

const done = (value: string): Settled<string, string> => ({ kind: 'done', value });

describe('the exactly-once ledger', () => {
  test('work runs once per id; a repeat inside the window gets the first answer, a repeat after it posts again', async () => {
    let now = 0;
    const ledger = new PostLedger<string, string>(() => now);
    let runs = 0;
    const work = async () => {
      runs += 1;
      return done(`run-${String(runs)}`);
    };
    const first = await ledger.run('id-1', 'same', work);
    const again = await ledger.run('id-1', 'same', work);
    expect([first, again]).toEqual([
      { kind: 'ran', settled: done('run-1'), replayed: false },
      { kind: 'ran', settled: done('run-1'), replayed: true },
    ]);
    now = LEDGER_WINDOW_MS + 1;
    expect(await ledger.run('id-1', 'same', work)).toEqual({ kind: 'ran', settled: done('run-2'), replayed: false });
  });

  test('a repeat that arrives while the first is still in flight waits for it', async () => {
    const ledger = new PostLedger<string, string>(() => 0);
    let runs = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const work = async () => {
      runs += 1;
      await gate;
      return done('once');
    };
    const both = Promise.all([ledger.run('id', 'f', work), ledger.run('id', 'f', work)]);
    release();
    const [a, b] = await both;
    expect(runs).toBe(1);
    expect([a, b].map(each => (each.kind === 'ran' ? each.replayed : null))).toEqual([false, true]);
  });

  test('a different fingerprint under the same id is a mismatch; a certain refusal is forgotten; a throw reads as unknown', async () => {
    const ledger = new PostLedger<string, string>(() => 0);
    await ledger.run('id', 'a', async () => done('x'));
    expect(await ledger.run('id', 'b', async () => done('y'))).toEqual({ kind: 'mismatch' });
    await ledger.run('no', 'a', async () => ({ kind: 'refused', refusal: 'nope' }));
    expect(ledger.size).toBe(1);
    const thrown = await ledger.run('boom', 'a', async () => {
      throw new Error('?');
    });
    expect(thrown).toEqual({ kind: 'ran', settled: { kind: 'unknown' }, replayed: false });
    expect((await ledger.run('boom', 'a', async () => done('late'))).kind).toBe('ran');
    expect(ledger.size).toBe(2);
  });

  test('the ledger is bounded: past its size the oldest settled entries go', async () => {
    const ledger = new PostLedger<string, string>(() => 0);
    for (let i = 0; i < LEDGER_MAX_ENTRIES + 50; i += 1)
      await ledger.run(`id-${String(i)}`, 'f', async () => done('x'));
    expect(ledger.size).toBeLessThanOrEqual(LEDGER_MAX_ENTRIES);
  });
});
