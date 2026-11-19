import { describe, expect, test } from 'bun:test';
import { LEDGER_WINDOW_MS, PostLedger, type Settled } from '../../daemon/features/post/ledger.ts';

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

  test('the ledger is bounded: when it holds as many live entries as it may, a NEW id is refused busy and nothing is evicted', async () => {
    const ledger = new PostLedger<string, string>(() => 0, LEDGER_WINDOW_MS, 3);
    let runs = 0;
    const work = async () => done(`run-${String(++runs)}`);
    for (const id of ['a', 'b', 'c']) await ledger.run(id, 'f', work);
    expect(await ledger.run('d', 'f', work)).toEqual({ kind: 'busy' });
    expect(runs).toBe(3);
    expect(ledger.size).toBe(3);
    // A retry of the OLDEST entry, at capacity, still finds it: it is answered, never run again.
    expect(await ledger.run('a', 'f', work)).toEqual({ kind: 'ran', settled: done('run-1'), replayed: true });
    expect(runs).toBe(3);
  });

  test('an in-flight entry holds its place too, and room comes back only as entries expire', async () => {
    let now = 0;
    const ledger = new PostLedger<string, string>(() => now, 1_000, 2);
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => (release = resolve));
    const slow = ledger.run('slow', 'f', async () => {
      await held;
      return done('slow');
    });
    await ledger.run('b', 'f', async () => done('b'));
    expect(await ledger.run('c', 'f', async () => done('c'))).toEqual({ kind: 'busy' });
    now = 2_000;
    // 'b' expired and is swept for the new id; the in-flight one is not expired (it has not settled).
    expect(await ledger.run('c', 'f', async () => done('c'))).toEqual({
      kind: 'ran',
      settled: done('c'),
      replayed: false,
    });
    expect(await ledger.run('d', 'f', async () => done('d'))).toEqual({ kind: 'busy' });
    release();
    expect((await slow).kind).toBe('ran');
  });

  test('an expired entry that is retried runs afresh, even at capacity', async () => {
    let now = 0;
    const ledger = new PostLedger<string, string>(() => now, 1_000, 1);
    let runs = 0;
    const work = async () => done(`run-${String(++runs)}`);
    await ledger.run('a', 'f', work);
    now = 5_000;
    expect(await ledger.run('a', 'f', work)).toEqual({ kind: 'ran', settled: done('run-2'), replayed: false });
  });
});
