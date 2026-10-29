import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAttentionOutboxRepository } from '../../../src/adapters/attention/file-attention-outbox-repository.ts';
import { KeyedAttentionReplyTimers } from '../../../src/adapters/attention/keyed-attention-reply-timers.ts';
import { AttentionReplyBatcher } from '../../../src/lib/attention/index.ts';

const homes: string[] = [];
const timersInUse: KeyedAttentionReplyTimers[] = [];
const SESSION = 'session-1';

afterEach(async () => {
  for (const timers of timersInUse.splice(0)) timers.close();
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

const after = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms));
const serial = { run: async <T>(_key: string, task: () => Promise<T>): Promise<T> => await task() };

/** Real files, real timers and the real clock; only the windows are shrunk from seconds to milliseconds. */
async function world() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-attention-hold-'));
  homes.push(home);
  const timers = new KeyedAttentionReplyTimers();
  timersInUse.push(timers);
  const sent: Array<{ at: number; message: string }> = [];
  const ferret = { busy: false };
  const batcher = new AttentionReplyBatcher(
    new FileAttentionOutboxRepository(sessionId => join(home, 'sessions', sessionId)),
    {
      send: async (_sessionId: string, message: string) => {
        sent.push({ at: Date.now(), message });
      },
    },
    timers,
    serial,
    { now: () => new Date().toISOString() },
    { settleMs: 30, capMs: 400, recheckMs: 15, holdCeilingMs: 2_000 },
    { busy: async () => ferret.busy },
  );
  return { batcher, sent, ferret };
}

describe('the attention reply batcher over real files and timers', () => {
  it('should hold a due batch while the ferret works, take later answers into it, and send one message once idle', async () => {
    // Arrange
    const { batcher, sent, ferret } = await world();
    ferret.busy = true;

    // Act — the first answer falls due while busy; a second arrives during the hold.
    await batcher.add(SESSION, 'A1', 'one');
    await after(80);
    const heldWhileBusy = await batcher.pending(SESSION);
    await batcher.add(SESSION, 'A2', 'two');
    await after(80);
    const sentWhileBusy = sent.length;
    ferret.busy = false;
    await after(120);

    // Assert
    should(heldWhileBusy?.heldForTurn).be.true();
    should(sentWhileBusy).equal(0);
    should(sent.map(each => each.message)).deepEqual(['one\n\ntwo']);
    should(await batcher.pending(SESSION)).be.undefined();
  });

  it('should deliver on the settle window alone when the ferret is idle', async () => {
    // Arrange
    const { batcher, sent } = await world();

    // Act
    await batcher.add(SESSION, 'A1', 'one');
    await after(120);

    // Assert
    should(sent.map(each => each.message)).deepEqual(['one']);
  });
});
