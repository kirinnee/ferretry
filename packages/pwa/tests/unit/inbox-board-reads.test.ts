import { describe, expect, test } from 'bun:test';
import type { DeferredTimers } from '../../src/lib/agenda-inbox.ts';
import {
  InboxBoardReads,
  type InboxBoardWant,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  retryDelay,
} from '../../src/lib/inbox-board-reads.ts';

/** A hand-cranked clock: every armed timer, and which were cleared. */
const manualTimers = () => {
  const armed = new Map<number, { readonly run: () => void; readonly after: number }>();
  let next = 0;
  const timers: DeferredTimers = {
    setTimeout: (run, after) => {
      next += 1;
      armed.set(next, { run, after });
      return next;
    },
    clearTimeout: handle => {
      armed.delete(handle as number);
    },
    now: () => 0,
  };
  const fire = (): void => {
    const due = [...armed.values()];
    armed.clear();
    for (const timer of due) timer.run();
  };
  return { timers, armed, fire };
};

/** A board the test settles by hand: how many reads it saw, and whether the store would hold it. */
const board = (id: string, key = 'k1') => {
  const state = { reads: 0, held: false, settle: (_held: boolean, _fail?: boolean): void => undefined };
  const want = (summary = key): InboxBoardWant => ({
    id,
    key: summary,
    read: () =>
      new Promise<void>((resolve, reject) => {
        state.reads += 1;
        state.settle = (held, fail = false) => {
          state.held = held;
          if (fail) reject(new Error('did not answer within 20s'));
          else resolve();
        };
      }),
    held: () => state.held,
  });
  return { state, want };
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

describe('InboxBoardReads', () => {
  test('should read a wanted board once per summary, and once however often it is listed', async () => {
    const { timers } = manualTimers();
    const reads = new InboxBoardReads(timers);
    const a = board('a');
    reads.sync([a.want(), a.want()]);
    expect(a.state.reads).toBe(1);
    reads.sync([a.want()]);
    expect(a.state.reads).toBe(1);
    reads.sync([a.want('k2')]);
    expect(a.state.reads).toBe(2);
    a.state.settle(true);
    await flush();
    expect(reads.getSnapshot().size).toBe(0);
  });

  test('should call a read that settles without the board failed, and ask again on a backoff until one lands', async () => {
    const { timers, armed, fire } = manualTimers();
    const reads = new InboxBoardReads(timers);
    let told = 0;
    const stop = reads.subscribe(() => {
      told += 1;
    });
    const down = board('down');
    reads.sync([down.want()]);
    expect(told).toBe(0);

    down.state.settle(false, true);
    await flush();
    expect([...reads.getSnapshot()]).toEqual(['down']);
    expect(told).toBe(1);
    expect([...armed.values()].map(timer => timer.after)).toEqual([RETRY_FIRST_MS]);

    // The retry is quiet: the board stays failed while it is read again.
    fire();
    expect(down.state.reads).toBe(2);
    expect([...reads.getSnapshot()]).toEqual(['down']);
    down.state.settle(false);
    await flush();
    expect([...armed.values()].map(timer => timer.after)).toEqual([RETRY_FIRST_MS * 2]);
    expect(told).toBe(1);

    fire();
    down.state.settle(true);
    await flush();
    expect(reads.getSnapshot().size).toBe(0);
    expect(told).toBe(2);
    expect(armed.size).toBe(0);
    stop();
  });

  test('should keep a failed board failed through a read for a new summary, until a read lands', async () => {
    const { timers, armed } = manualTimers();
    const reads = new InboxBoardReads(timers);
    const down = board('down');
    reads.sync([down.want()]);
    down.state.settle(false);
    await flush();
    reads.sync([down.want('k2')]);
    // The pending retry gave way to the read the new summary started.
    expect(armed.size).toBe(0);
    expect(down.state.reads).toBe(2);
    expect([...reads.getSnapshot()]).toEqual(['down']);
    down.state.settle(true);
    await flush();
    expect(reads.getSnapshot().size).toBe(0);
  });

  test('should ignore a read that settles after a newer one started, and one for a board no longer wanted', async () => {
    const { timers, armed } = manualTimers();
    const reads = new InboxBoardReads(timers);
    const a = board('a');
    reads.sync([a.want()]);
    const first = a.state.settle;
    reads.sync([a.want('k2')]);
    first(false);
    await flush();
    expect(reads.getSnapshot().size).toBe(0);
    expect(armed.size).toBe(0);

    reads.sync([]);
    a.state.settle(false);
    await flush();
    expect(reads.getSnapshot().size).toBe(0);
    expect(armed.size).toBe(0);
  });

  test('should forget a failed board that is no longer wanted, its retry with it', async () => {
    const { timers, armed, fire } = manualTimers();
    const reads = new InboxBoardReads(timers);
    const down = board('down');
    reads.sync([down.want()]);
    down.state.settle(false);
    await flush();
    expect(armed.size).toBe(1);
    reads.sync([]);
    expect(armed.size).toBe(0);
    expect(reads.getSnapshot().size).toBe(0);
    fire();
    expect(down.state.reads).toBe(1);
  });

  test('should drop a retry that fires for a board read again since', async () => {
    const stale: (() => void)[] = [];
    const reads = new InboxBoardReads({
      // Cancelling is a no-op here, so the stale retry still fires.
      setTimeout: run => {
        stale.push(run);
        return stale.length;
      },
      clearTimeout: () => undefined,
      now: () => 0,
    });
    const down = board('down');
    reads.sync([down.want()]);
    down.state.settle(false);
    await flush();
    reads.sync([down.want('k2')]);
    for (const run of stale) run();
    expect(down.state.reads).toBe(2);
  });

  test('should cancel every retry and forget every board when disposed', async () => {
    const { timers, armed } = manualTimers();
    const reads = new InboxBoardReads(timers);
    const down = board('down');
    const up = board('up');
    reads.sync([down.want(), up.want()]);
    down.state.settle(false);
    await flush();
    reads.dispose();
    expect(armed.size).toBe(0);
    expect(reads.getSnapshot().size).toBe(0);
    reads.sync([down.want(), up.want()]);
    expect(down.state.reads).toBe(2);
    expect(up.state.reads).toBe(2);
  });

  test('should double the wait after each failure, up to five minutes', () => {
    expect(retryDelay(1)).toBe(15_000);
    expect(retryDelay(2)).toBe(30_000);
    expect(retryDelay(5)).toBe(240_000);
    expect(retryDelay(6)).toBe(RETRY_MAX_MS);
    expect(retryDelay(40)).toBe(RETRY_MAX_MS);
  });
});
