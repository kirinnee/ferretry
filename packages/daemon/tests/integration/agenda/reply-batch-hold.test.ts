import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAgendaOutboxRepository } from '../../../src/adapters/agenda/file-agenda-outbox-repository.ts';
import { AgendaReplyBatcher, type AgendaReplyTimers } from '../../../src/lib/agenda/index.ts';
import { waitFor } from '../support/wait-for.ts';

const homes: string[] = [];
const SESSION = 'session-1';

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

const serial = { run: async <T>(_key: string, task: () => Promise<T>): Promise<T> => await task() };

/**
 * The batcher's timer port and clock, driven by hand: a window closes when the test fires its timer, which
 * moves the clock to the moment the timer was due. Nothing here waits for time to pass.
 */
class ManualWindows implements AgendaReplyTimers {
  ms = Date.parse('2026-10-29T00:00:00.000Z');
  scheduled = 0;
  readonly #timers = new Map<string, { readonly at: number; readonly task: () => void }>();

  now = (): string => new Date(this.ms).toISOString();

  schedule(key: string, delayMs: number, task: () => void): void {
    this.scheduled += 1;
    this.#timers.set(key, { at: this.ms + delayMs, task });
  }

  cancel(key: string): void {
    this.#timers.delete(key);
  }

  /** Closes the window on `key`: the clock reaches its due time and the task runs. */
  fire(key: string): void {
    const timer = this.#timers.get(key);
    if (timer === undefined) throw new Error(`no timer is set for ${key}`);
    this.#timers.delete(key);
    this.ms = Math.max(this.ms, timer.at);
    timer.task();
  }
}

/** Real files and the real batcher; only the timer port and the clock are the test's. */
async function world() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-agenda-hold-'));
  homes.push(home);
  const windows = new ManualWindows();
  const sent: Array<{ message: string }> = [];
  const ferret = { busy: false };
  const batcher = new AgendaReplyBatcher(
    new FileAgendaOutboxRepository(sessionId => join(home, 'sessions', sessionId)),
    {
      send: async (_sessionId: string, message: string) => {
        sent.push({ message });
      },
    },
    windows,
    serial,
    windows,
    { settleMs: 30, capMs: 400, recheckMs: 15, holdCeilingMs: 2_000 },
    { busy: async () => ferret.busy },
  );
  return { batcher, sent, ferret, windows };
}

describe('the agenda reply batcher over real files and a hand-driven clock', () => {
  it('should hold a due batch while the ferret works, take later answers into it, and send one message once idle', async () => {
    // Arrange
    const { batcher, sent, ferret, windows } = await world();
    ferret.busy = true;
    const rechecked = async (): Promise<void> => {
      const before = windows.scheduled;
      windows.fire(SESSION);
      await waitFor(() => windows.scheduled > before, 'the held batch to be looked at again');
    };

    // Act — the first answer falls due while busy; a second arrives during the hold.
    await batcher.add(SESSION, 'A1', 'one');
    await rechecked();
    const heldWhileBusy = await batcher.pending(SESSION);
    await batcher.add(SESSION, 'A2', 'two');
    await rechecked();
    const sentWhileBusy = sent.length;
    ferret.busy = false;
    windows.fire(SESSION);
    await waitFor(() => sent.length === 1, 'the one message to be sent once the ferret is idle');

    // Assert
    should(heldWhileBusy?.heldForTurn).be.true();
    should(sentWhileBusy).equal(0);
    should(sent.map(each => each.message)).deepEqual(['one\n\ntwo']);
    should(await batcher.pending(SESSION)).be.undefined();
  });

  it('should deliver on the settle window alone when the ferret is idle', async () => {
    // Arrange
    const { batcher, sent, windows } = await world();

    // Act
    await batcher.add(SESSION, 'A1', 'one');
    windows.fire(SESSION);
    await waitFor(() => sent.length === 1, 'the batch to be sent when its settle window closed');

    // Assert
    should(sent.map(each => each.message)).deepEqual(['one']);
  });
});
