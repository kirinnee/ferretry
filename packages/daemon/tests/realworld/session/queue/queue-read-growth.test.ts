// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileSessionQueueStore } from '../../../../src/adapters/session/queue/index.ts';
import { foldQueue, type QueueEvent } from '../../../../src/lib/session/queue/index.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

/**
 * &F4319: a long-lived session's queue log, read on every one of the deliverer's looks. Measured on the owner's
 * host, a 228,788-line log cost ~420 ms of event loop per read and fold, three or more times per look, every five
 * seconds. Once read, a log that grew by a line must cost a read of that line, not of the file.
 */

const homes = new Set<string>();
const ID = parseSessionId('session-1');
const LINES = 200_000;

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

/** Shaped like the measured log: messages enqueued, flapping between unreadable and clear, typed, refused, read. */
function realShapedLog(lines: number): string {
  const out: string[] = [];
  for (let n = 0; out.length < lines; n++) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const at = new Date(Date.UTC(2026, 10, 13, 0, 0, n)).toISOString();
    out.push(
      JSON.stringify({
        v: 1,
        kind: 'enqueued',
        at,
        message: {
          v: 1,
          id,
          sender: 'agent',
          from: 'mwigky3p-2438b555',
          by: { kind: 'ferret', name: 'bruce' },
          text: 'CI checkout failed on the release job; the cache key moved. Re-running with a fresh key.',
          attachmentIds: [],
          label: 'action',
          enqueuedAt: at,
          state: 'queued',
          stateAt: at,
          revision: 1,
        },
      }),
    );
    for (let flap = 0; flap < 30; flap++)
      out.push(
        JSON.stringify({ v: 1, kind: 'waiting', at, id, reason: 'unreadable' }),
        JSON.stringify({ v: 1, kind: 'waiting', at, id }),
        JSON.stringify({ v: 1, kind: 'moved', at, id, state: 'typing' }),
        JSON.stringify({ v: 1, kind: 'moved', at, id, state: 'queued' }),
      );
    for (const state of ['typing', 'delivered', 'read'])
      out.push(JSON.stringify({ v: 1, kind: 'moved', at, id, state }));
  }
  return `${out.slice(0, lines).join('\n')}\n`;
}

const timed = async (run: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await run();
  return performance.now() - started;
};

describe('a 200,000-line queue log read again after one more line', () => {
  it('should cost the new line, not the file: well under a tenth of the first read and under 30 ms', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'ferretry-queue-realworld-'));
    homes.add(home);
    const store = new FileSessionQueueStore(id => join(home, id));
    await store.append(ID, JSON.parse(realShapedLog(1).trim()) as QueueEvent);
    await appendFile(store.file(ID), realShapedLog(LINES));
    const look = async (): Promise<number> => foldQueue(await store.read(ID)).length;

    // Act — the first look parses everything; each later one follows one more appended line.
    const first = await timed(look);
    const later: number[] = [];
    for (let n = 0; n < 5; n++) {
      await store.append(ID, { v: 1, kind: 'waiting', at: new Date().toISOString(), id: 'nobody' });
      later.push(await timed(look));
    }
    const worst = Math.max(...later);

    // Assert
    console.log(
      `first read+fold ${first.toFixed(0)} ms; after one appended line: ${later.map(ms => ms.toFixed(1)).join(', ')} ms`,
    );
    should(worst).be.below(first / 10);
    should(worst).be.below(30);
  });
});
